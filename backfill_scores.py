"""
backfill_scores.py — One-shot script to reconstruct meeting-cadence and
comms-quality Layer 1 sub-scores for the past ~3 months, using the EXACT
SAME scoring functions the live generate.py path uses (scoring.py's
_score_meeting_cadence and _score_comms_for_window) -- not a re-implemented
shortcut. Task stalling is deliberately NOT backfilled (see
docs/scoring-spec-draft.md follow-up): the live pipeline's stalled_items are
a Claude judgment call reading Monday + meetings + WhatsApp together, and
WhatsApp history isn't retrievable at all (no local exports, Drive isn't
configured) -- faithfully reconstructing that same judgment for a past date
isn't possible without guessing. Every backfilled row's task_stalling stays
{score: None, status: "not_backfilled"}.

Data sources:
  - Meetings: Fireflies' `transcripts` query, now paginated (see
    fetch_fireflies.py -- the unpaginated version silently capped at 50,
    which a 30-day window already hit live).
  - Comments: archive/monday_updates/*.jsonl, the existing Monday-updates
    archive (real comment text/author/timestamp, already resolved to a
    canonical client at archive time) -- confirmed to go back to Feb 2026
    with no truncation (no item hit the archive query's 100-updates cap).

Known assumptions (there's no historical config to fall back on, so these
are the only reasonable choices -- flagged, not hidden):
  - client_cadence.json's CURRENT values are applied retroactively across
    the whole backfill window. There's no record of what the expected
    cadence was 3 months ago, and no reason to think it was different.
  - Meeting-to-client matching uses TODAY's Monday-board "active clients"
    set as the corroboration gate for content-only matches (the same gate
    match_meeting_clients always uses) -- Monday itself doesn't retain a
    historical picture of which clients had board activity on a past date,
    so today's roster is the only available proxy. Title matches (the
    strong signal) are unaffected by this.
  - Each backfilled day's "now" is fixed at 12:00 UTC to mirror the actual
    cron schedule (.github/workflows/standup.yml runs at 0 12 * * *), so
    the 7-day rolling window lines up the same way it would have live.

Run once (locally, needs MONDAY_API_TOKEN / FIREFLIES_API_KEY /
ANTHROPIC_API_KEY in .env):
    python backfill_scores.py
"""

import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fetch_fireflies import fetch_transcripts
from fetch_monday import fetch_all_boards
from generate import group_items_by_client, match_meeting_clients, _anthropic_client, _call_tool, load_config
import scoring

BACKFILL_DAYS = 90
ARCHIVE_DIR = Path("archive/monday_updates")


def _daterange(start, end):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def _load_archive_comments(scored_clients: set, earliest: "datetime.date") -> dict:
    """{client: [{id, body, creator, created_at}, ...]} sorted by created_at,
    from every archive/monday_updates/*.jsonl month that could contain data
    on/after `earliest`."""
    by_client: dict = {c: [] for c in scored_clients}
    if not ARCHIVE_DIR.exists():
        return by_client

    for path in sorted(ARCHIVE_DIR.glob("*.jsonl")):
        # Filename is YYYY-MM.jsonl -- skip whole months that end before the
        # window starts, no need to even open them.
        try:
            ym_end = datetime.strptime(path.stem, "%Y-%m").date().replace(day=28) + timedelta(days=4)
        except ValueError:
            ym_end = None
        if ym_end and ym_end < earliest:
            continue

        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            client = rec.get("client")
            body = (rec.get("body") or "").strip()
            created_at = rec.get("created_at") or ""
            if client not in by_client or not body or not created_at:
                continue
            by_client[client].append({
                "id": rec.get("update_id"),
                "body": body,
                "creator": rec.get("creator") or "Unknown",
                "created_at": created_at,
            })

    for lst in by_client.values():
        lst.sort(key=lambda c: c["created_at"])
    return by_client


def _comments_in_window(comments: list, window_start: datetime, as_of: datetime) -> list:
    out = []
    for c in comments:
        try:
            ts = datetime.fromisoformat(c["created_at"].replace("Z", "+00:00"))
        except ValueError:
            continue
        if window_start <= ts <= as_of:
            out.append(c)
    return out


def main() -> None:
    config = load_config()
    clients_config = config.get("clients", {})
    days_back_window = config.get("days_back", 7)
    scored_clients = [c for c in clients_config if c not in scoring.EXCLUDED_CLIENTS]

    today = datetime.now(timezone.utc).date()
    start_date = today - timedelta(days=BACKFILL_DAYS)
    end_date = today - timedelta(days=1)  # today already has a real row from the live run

    print(f"Backfilling {start_date} .. {end_date} for {len(scored_clients)} client(s) "
          f"(excluded: {sorted(scoring.EXCLUDED_CLIENTS)})\n")

    # ── 1. meetings ──────────────────────────────────────────────────────────
    print("[1/4] Fetching Fireflies meetings (paginated)...")
    fetch_days = (today - start_date).days + 3  # small buffer
    fireflies_data = fetch_transcripts(days_back=fetch_days)
    print(f"  {len(fireflies_data)} meeting(s) fetched")

    print("  Fetching current Monday boards for the active-clients corroboration gate...")
    monday_data, _ = fetch_all_boards(config)
    grouped, _ = group_items_by_client(monday_data, clients_config)
    active_clients_set = {c for c in grouped if c != "Unmapped"}

    meetings_by_date_client: dict = {}
    for mt in fireflies_data:
        mdate = mt.get("date")
        if not mdate:
            continue
        matched = match_meeting_clients(mt, clients_config, active_clients_set)
        for c in matched:
            if c not in scored_clients:
                continue
            meetings_by_date_client.setdefault(mdate, {}).setdefault(c, []).append(mt)
    n_matched_days = sum(len(v) for v in meetings_by_date_client.values())
    print(f"  {n_matched_days} client-day meeting match(es) across the window")

    # ── 2. archived comments ────────────────────────────────────────────────
    print("\n[2/4] Loading archived Monday comments...")
    earliest_needed = start_date - timedelta(days=days_back_window)
    archive_comments = _load_archive_comments(set(scored_clients), earliest_needed)
    total_comments = sum(len(v) for v in archive_comments.values())
    print(f"  {total_comments} archived comment(s) across {len(scored_clients)} client(s) "
          f"since {earliest_needed}")

    # ── 3. classify every unique historical comment once (cache-shared with the live path) ──
    print("\n[3/4] Classifying historical comments (cached by Monday update id)...")
    cache = scoring._load_json(scoring.COMMS_CACHE_PATH, {})
    all_comments = [c for lst in archive_comments.values() for c in lst]
    uncached = [c for c in all_comments if c.get("id") and c["id"] not in cache]
    if uncached:
        ai = _anthropic_client()
        print(f"  classifying {len(uncached)} new comment(s) ({len(all_comments) - len(uncached)} already cached)")
        cache.update(scoring._classify_comments(_call_tool, ai, uncached))
        scoring._save_json(scoring.COMMS_CACHE_PATH, cache)
    else:
        print(f"  all {len(all_comments)} comment(s) already cached -- nothing to classify")

    # ── 4. walk each day, score through the SAME functions the live path uses ──
    print(f"\n[4/4] Scoring {(end_date - start_date).days + 1} day(s) per client...")
    cadence_map = scoring._load_cadence_config()
    cadence_state: dict = {}          # fresh replay -- see main() docstring
    comms_people_history: dict = {}   # fresh replay, per client

    new_rows = []
    for d in _daterange(start_date, end_date):
        date_str = d.isoformat()
        as_of = datetime(d.year, d.month, d.day, 12, 0, 0, tzinfo=timezone.utc)
        window_start = as_of - timedelta(days=days_back_window)

        for client in scored_clients:
            meetings_today = meetings_by_date_client.get(date_str, {}).get(client, [])
            cadence_score = scoring._score_meeting_cadence(
                client, meetings_today, date_str, cadence_map, cadence_state,
            )

            window_comments = _comments_in_window(archive_comments.get(client, []), window_start, as_of)
            client_hist = comms_people_history.setdefault(client, {})
            comms_score = scoring._score_comms_for_window(window_comments, cache, client_hist, date_str)

            sub_scores = {
                "task_stalling": {
                    "score": None, "status": scoring.NOT_BACKFILLED,
                    "reason": "task stalling is not backfilled -- the live pipeline's stalled_items are "
                              "an AI judgment over Monday + meetings + WhatsApp together, and WhatsApp "
                              "history isn't retrievable; scoring starts from generate.py's live runs only",
                },
                "comms_quality": comms_score,
                "meeting_cadence": cadence_score,
                "team_load": scoring._score_team_load(),
            }
            comp = scoring._composite(sub_scores)
            new_rows.append({
                "date": date_str,
                "client": client,
                "composite_health": comp["composite"],
                "composite_label": comp["label"],
                "sub_scores": sub_scores,
                "composite_risk": None,
                "risk_sub_scores": None,
            })

    # ── merge into scores-history.json -- never touches an existing (date, client) row ──
    existing = scoring._load_json(scoring.SCORES_HISTORY_PATH, [])
    if not isinstance(existing, list):
        existing = []
    existing_keys = {(r.get("date"), r.get("client")) for r in existing}
    to_add = [r for r in new_rows if (r["date"], r["client"]) not in existing_keys]
    skipped = len(new_rows) - len(to_add)

    combined = existing + to_add
    combined.sort(key=lambda r: (r["date"], r["client"]))
    scoring._save_json(scoring.SCORES_HISTORY_PATH, combined)
    site_path = Path("site") / "scores-history.json"
    site_path.parent.mkdir(exist_ok=True)
    shutil.copy2(scoring.SCORES_HISTORY_PATH, site_path)

    print(f"\n  Added {len(to_add)} row(s) to {scoring.SCORES_HISTORY_PATH} "
          f"({skipped} already present, left untouched)")
    print(f"  Copied -> {site_path}")

    # ── seed the LIVE cadence-state.json with the backfill's ending state, so
    #    tomorrow's live run continues the gap-days count from real history
    #    instead of starting cold -- but never overwrite a client the live
    #    file already has a MORE RECENT date for (e.g. today's live run
    #    already saw a real meeting for them). ──
    live_cadence_state = scoring._load_json(scoring.CADENCE_STATE_PATH, {})
    seeded = 0
    for client, last_date in cadence_state.items():
        if client not in live_cadence_state or live_cadence_state[client] < last_date:
            live_cadence_state[client] = last_date
            seeded += 1
    scoring._save_json(scoring.CADENCE_STATE_PATH, live_cadence_state)
    print(f"  Seeded {seeded} client(s) into {scoring.CADENCE_STATE_PATH} from backfilled meeting history")

    print("\nDone.")


if __name__ == "__main__":
    main()
