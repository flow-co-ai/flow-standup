"""
scoring.py — Layer 1 operational health scoring.

Implements docs/scoring-spec-draft.md section 1 (task stalling, comms
quality, meeting cadence, team load sub-scores + weighted composite) and
section 3 (flag -> suggested action lookup). Layer 2 (fear-signal / client
risk scoring) is a separate, later pass -- not built here.

Known first-draft assumptions, called out because the spec doesn't pin them
down precisely (flag to Naz for confirmation/tuning):

- Comms-quality "same person posts low two weeks running": this pipeline
  runs DAILY (see .github/workflows/standup.yml) over a rolling 7-day
  `recent_updates` window, so a naive run-over-run comparison could call two
  low runs 48 hours apart "two weeks." Fixed to key off each comment's own
  ISO calendar week (from its created_at, not the run date): per person, a
  week is "low" only once every comment of theirs seen in that ISO week is
  low, and the flag fires only when the CURRENT ISO week and the
  IMMEDIATELY PRECEDING one are both fully low for that person. Persisted
  per (client, person, iso_week) in comms-quality-people.json, deduped by
  comment id (the same comment reappears across several days' rolling
  windows before it ages out) and pruned to just the current + previous week
  once a run moves past them.
- A comment the classifier fails to return a label for defaults to "medium"
  (fail open, not red) so one bad batch can't tank a client's score.
- Meeting-cadence red/yellow/green thresholds (gap <= expected -> green,
  <= 1.5x expected -> yellow, > 1.5x -> red) aren't specified in the doc --
  picked as a reasonable first cut.
- Composite 0-100 -> red/yellow/green bucketing (<50 red, <80 yellow, else
  green) isn't specified either -- same as above.
- Composite reweights across only the sub-scores that have data (task
  stalling + comms quality if cadence/team load are null) rather than
  treating missing sub-scores as zero, so an unconfigured cadence doesn't
  artificially cap every client's score at 65.
- "Pending Review bottleneck" and "Long-stalled task" flags use `review`
  count and `days_stalled` per stalled item -- the doc's flag table also
  mentions "any item >10d in review" specifically, but there's no per-item
  days-in-review data available today (only a total review count), so that
  half of the trigger isn't implemented.
"""

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path

CADENCE_CONFIG_PATH = Path("client_cadence.json")
CADENCE_STATE_PATH = Path("standups") / "cadence-state.json"
COMMS_CACHE_PATH = Path("standups") / "comms-quality-cache.json"
COMMS_PEOPLE_PATH = Path("standups") / "comms-quality-people.json"
SCORES_HISTORY_PATH = Path("scores-history.json")

CADENCE_DAYS = {"weekly": 7, "biweekly": 14, "monthly": 30}

RED, YELLOW, GREEN = "red", "yellow", "green"

# For a null (unscored) sub-score, which of the two very different reasons it
# is: a feature/config gap (nothing will happen until a human fills something
# in) vs. a properly-configured metric that simply hasn't seen its first real
# signal yet (will resolve itself on a future run, no action needed). The UI
# renders these differently so "CADENCE N/A" doesn't read as a bug when it's
# actually just day one of tracking for that client.
NOT_CONFIGURED = "not_configured"
AWAITING_DATA = "awaiting_data"
NOT_BACKFILLED = "not_backfilled"  # backfill_scores.py: task stalling is deliberately not reconstructed
SCORE_VALUE = {RED: 20, YELLOW: 60, GREEN: 100}

WEIGHTS = {
    "task_stalling": 0.35,
    "comms_quality": 0.30,
    "meeting_cadence": 0.20,
    "team_load": 0.15,
}

# Section 3 flag -> suggested action lookup. Kept as one full table (matching
# the spec's intent that a new flag type later is a data change, not a code
# change) even though only the Layer-1-computable rows can actually fire
# today -- the rest belong to Layer 2 (fear-signal rubric), not built yet.
FLAG_ACTIONS = {
    "pending_review_bottleneck": {
        "label": "Pending Review bottleneck",
        "action": "Reassign or escalate: pull the oldest tasks out of review, assign an explicit reviewer with a 48h SLA",
    },
    "long_stalled_task": {
        "label": "Long-stalled task",
        "action": "Escalate in next standup — decide kill or keep, don't let it age further",
    },
    "comms_quality_red": {
        "label": "Comms quality red",
        "action": "1:1 on update expectations; share one \"high\" example from the team as a model",
    },
    "meeting_cadence_red": {
        "label": "Meeting cadence red",
        "action": "Book a check-in this week; if client unresponsive, escalate to account owner as a risk, not just a scheduling gap",
    },
    "team_load_red": {
        "label": "Team load red",
        "action": "Rebalance — move tasks to a teammate with headroom, or explicitly deprioritize lower-tier client work",
    },
    # Layer 2 (not yet implemented -- kept here so wiring it in later is a
    # data change only):
    "going_quiet": {
        "label": "Going Quiet",
        "action": "Reach out same day — don't wait for the next scheduled touchpoint",
    },
    "competitive_shopping": {
        "label": "Competitive shopping detected",
        "action": "Immediate save conversation — address the underlying complaint the transcript reveals before they finish evaluating",
    },
    "escalation_new_stakeholder": {
        "label": "Escalation to new stakeholder",
        "action": "Prep a stakeholder-specific ROI brief before the next call; ask to be looped into that conversation directly",
    },
    "roi_performance_doubt": {
        "label": "ROI/performance doubt (spend cut)",
        "action": "Send a performance recap within 48h addressing the exact metric questioned",
    },
    "budget_hedging": {
        "label": "Budget hedging (no action yet)",
        "action": "Proactively surface a cost-efficiency win before they raise it again",
    },
    "vendor_framing": {
        "label": "Vendor-framing detected",
        "action": "Reinforce partnership framing at the next touchpoint — lead with proactive insight, not deliverable status",
    },
}

EMIT_COMMS_CLASSIFICATION_TOOL = {
    "name": "emit_comms_classification",
    "description": "Classify each Monday.com status update by substance.",
    "input_schema": {
        "type": "object",
        "required": ["classifications"],
        "properties": {
            "classifications": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["id", "label", "reason"],
                    "properties": {
                        "id": {"type": "string", "description": "Verbatim id from the input. Never invent or alter."},
                        "label": {"type": "string", "enum": ["low", "medium", "high"]},
                        "reason": {"type": "string", "description": "One short phrase, max ~12 words."},
                    },
                },
            },
        },
    },
}


# ── small persistence helpers (same append/overwrite pattern as generate.py's
#    accumulator/alerts files) ───────────────────────────────────────────────

def _load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default
    return default


def _save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ── 1.2 task stalling ──────────────────────────────────────────────────────

def _score_task_stalling(entry: dict) -> dict:
    stalled_items = [
        item for dept in (entry.get("work_by_department") or [])
        for item in (dept.get("stalled_items") or [])
    ]
    days = [
        i.get("days_stalled") for i in stalled_items
        if isinstance(i.get("days_stalled"), (int, float))
    ]
    review = (entry.get("stats") or {}).get("review", 0)

    any_over_10 = any(d > 10 for d in days)
    n_5_to_10 = sum(1 for d in days if 5 <= d <= 10)

    if any_over_10 or review >= 5:
        score = RED
    elif (1 <= n_5_to_10 <= 2) or (3 <= review <= 4):
        score = YELLOW
    else:
        score = GREEN

    bits = [f"{review} in review"]
    if days:
        bits.append(f"max stalled {max(days)}d")
    return {"score": score, "reason": ", ".join(bits), "max_days_stalled": max(days) if days else 0, "review_count": review}


# ── 1.3 comms quality ──────────────────────────────────────────────────────

def _fallback_comment_id(item: dict, upd: dict) -> str:
    """Monday updates fetched before the `id` field was added to the query
    (or any edge case where Monday doesn't return one) still need a stable
    cache key -- hash of item + timestamp + body prefix."""
    basis = f"{item.get('item_id', '')}|{upd.get('created_at', '')}|{(upd.get('body') or '')[:80]}"
    return "h:" + hashlib.sha1(basis.encode()).hexdigest()[:16]


def _gather_all_comments(grouped: dict) -> dict:
    """{client: [{id, body, creator, created_at}, ...]}"""
    per_client = {}
    for client, departments in grouped.items():
        comments = []
        for items in departments.values():
            for item in items:
                for upd in (item.get("recent_updates") or []):
                    body = (upd.get("body") or "").strip()
                    if not body:
                        continue
                    cid = upd.get("update_id") or _fallback_comment_id(item, upd)
                    comments.append({
                        "id": cid, "body": body,
                        "creator": upd.get("creator", "Unknown"),
                        "created_at": upd.get("created_at"),
                    })
        if comments:
            per_client[client] = comments
    return per_client


def _build_classification_prompt(chunk: list) -> str:
    lines = [
        "Classify each Monday.com status update below as `low`, `medium`, or `high` substance.",
        "High = specific outcome + concrete next step. Medium = vague outcome OR next step but not both.",
        "Low = \"done\", \"on it\", \"all good\", or any update with no verifiable content.",
        "Ignore length -- a two-word update can be high if specific (\"Meta pixel fixed, live now\") "
        "and a paragraph can be low if it's filler.",
        "", "Updates:",
    ]
    for c in chunk:
        lines.append(f"- id={c['id']} | {c['body'][:400]}")
    return "\n".join(lines)


def _classify_comments(call_tool, ai, comments: list) -> dict:
    """Returns {id: {label, reason}} for whatever the model successfully
    classifies. Batched so one call doesn't blow past output token limits."""
    results = {}
    chunk_size = 40
    for i in range(0, len(comments), chunk_size):
        chunk = comments[i:i + chunk_size]
        prompt = _build_classification_prompt(chunk)
        try:
            result = call_tool(
                ai, prompt, EMIT_COMMS_CLASSIFICATION_TOOL,
                label=f"comms-quality[{i}:{i + len(chunk)}]", max_tokens=2000,
            )
        except Exception as exc:
            print(f"  ⚠️  comms-quality classification batch failed: {exc}")
            continue
        for row in result.get("classifications", []) or []:
            cid, label = row.get("id"), row.get("label")
            if cid and label in ("low", "medium", "high"):
                results[cid] = {"label": label, "reason": row.get("reason", "")}
    return results


def _iso_week(date_str: str) -> str:
    """ISO year-week (e.g. '2026-W30') for a date string. Accepts either a
    bare 'YYYY-MM-DD' or a full ISO timestamp -- only the date part matters."""
    iso = datetime.fromisoformat(date_str[:10]).isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def _prev_iso_week(iso_week: str) -> str:
    """The ISO week immediately before the given one -- via that week's
    Monday minus 7 days, so it's correct across year boundaries."""
    year, week = iso_week.split("-W")
    monday = datetime.fromisocalendar(int(year), int(week), 1)
    prev = (monday - timedelta(days=7)).isocalendar()
    return f"{prev.year}-W{prev.week:02d}"


def _score_comms_for_window(comments: list, cache: dict, client_hist: dict, today: str) -> dict:
    """The actual comms-quality scoring logic (section 1.3), factored out so
    both the live path (this run's rolling-window comments) and
    backfill_scores.py (an archived window as of a past date) score through
    the identical function -- not two copies that can drift.

    comments: this client's {id, body, creator, created_at} comments already
      in scope for the window being scored (gathering/windowing is the
      caller's job -- this function only aggregates + classifies-via-cache).
    cache: the shared classification cache (id -> {label, reason}) -- the
      caller is responsible for having already classified any new ids in it.
    client_hist: THIS CLIENT's slice of the per-person/per-ISO-week repeat-low
      tracker, mutated in place. Live and backfill each pass their own (the
      live dict persists to comms-quality-people.json; backfill's is a
      throwaway dict it builds while replaying history day by day).
    today: the "as of" date -- current ISO week is computed from this, not
      from a comment's own date, so backfill can correctly treat "as of
      2026-05-03" as that day's current week, not today's."""
    labeled = [
        (c, cache.get(c["id"], {"label": "medium", "reason": "unclassified — defaulted"}))
        for c in comments
    ]
    total = len(labeled)
    medium_high = sum(1 for _, l in labeled if l["label"] in ("medium", "high"))

    current_week = _iso_week(today)
    prev_week = _prev_iso_week(current_week)

    # Fold this window's comments into the per-person, per-ISO-week record.
    # Deduped by comment id since the same comment reappears across several
    # days' worth of the rolling 7-day window before it ages out.
    for c, l in labeled:
        week = _iso_week(c.get("created_at") or today)
        week_rec = client_hist.setdefault(c["creator"], {}).setdefault(
            week, {"all_low": True, "seen_ids": []},
        )
        if c["id"] not in week_rec["seen_ids"]:
            week_rec["seen_ids"].append(c["id"])
            if l["label"] != "low":
                week_rec["all_low"] = False

    # Only the current + immediately preceding ISO week are ever compared --
    # drop anything older so this doesn't grow forever across daily runs (or,
    # for a backfill replay, across 90 days of history).
    for person_weeks in client_hist.values():
        for wk in list(person_weeks.keys()):
            if wk not in (current_week, prev_week):
                del person_weeks[wk]

    repeat_low_person = None
    for person, weeks in client_hist.items():
        cur, prev = weeks.get(current_week), weeks.get(prev_week)
        if (cur and cur["seen_ids"] and cur["all_low"]
                and prev and prev["seen_ids"] and prev["all_low"]):
            repeat_low_person = person
            break

    if total == 0:
        return {"score": None, "status": AWAITING_DATA, "reason": "no Monday comments this window", "pct_medium_high": None}

    pct = round(100 * medium_high / total)
    if pct < 40 or repeat_low_person:
        reason = f"{pct}% medium/high"
        if repeat_low_person:
            reason += f"; {repeat_low_person} posted low in both {prev_week} and {current_week}"
        return {"score": RED, "reason": reason, "pct_medium_high": pct}
    if pct <= 70:
        return {"score": YELLOW, "reason": f"{pct}% medium/high", "pct_medium_high": pct}
    return {"score": GREEN, "reason": f"{pct}% medium/high", "pct_medium_high": pct}


def _score_comms_quality_all(call_tool, ai, grouped: dict, today: str) -> dict:
    """Live-path wrapper: gathers this run's comments from `grouped`,
    classifies whatever isn't cached yet, then scores each client through
    _score_comms_for_window against the persisted people-history file."""
    cache = _load_json(COMMS_CACHE_PATH, {})
    people_history = _load_json(COMMS_PEOPLE_PATH, {})

    per_client_comments = _gather_all_comments(grouped)
    all_comments = [c for lst in per_client_comments.values() for c in lst]
    uncached = [c for c in all_comments if c["id"] not in cache]
    if uncached:
        print(f"  comms-quality: classifying {len(uncached)} new comment(s) "
              f"({len(all_comments) - len(uncached)} already cached)")
        cache.update(_classify_comments(call_tool, ai, uncached))
        _save_json(COMMS_CACHE_PATH, cache)

    results = {
        client: _score_comms_for_window(comments, cache, people_history.setdefault(client, {}), today)
        for client, comments in per_client_comments.items()
    }

    _save_json(COMMS_PEOPLE_PATH, people_history)
    return results


# ── 1.4 meeting cadence ─────────────────────────────────────────────────────

def _load_cadence_config() -> dict:
    return _load_json(CADENCE_CONFIG_PATH, {"clients": {}}).get("clients", {})


def _score_meeting_cadence(client: str, meetings_this_run: list, today: str,
                            cadence_map: dict, cadence_state: dict) -> dict:
    cadence_label = cadence_map.get(client)
    if not cadence_label or cadence_label not in CADENCE_DAYS:
        return {
            "score": None, "status": NOT_CONFIGURED,
            "reason": "cadence not configured -- add an entry to client_cadence.json (see docs/scoring-spec-draft.md section 1.4)",
        }

    expected_days = CADENCE_DAYS[cadence_label]
    today_date = datetime.fromisoformat(today).date()

    if meetings_this_run:
        cadence_state[client] = today  # any meeting this run resets the clock to today

    last_seen = cadence_state.get(client)
    if not last_seen:
        return {
            "score": None, "status": AWAITING_DATA,
            "reason": "no meeting history recorded yet -- will start scoring once a meeting is logged",
        }

    gap_days = (today_date - datetime.fromisoformat(last_seen).date()).days
    ratio = gap_days / expected_days
    if ratio <= 1.0:
        score = GREEN
    elif ratio <= 1.5:
        score = YELLOW
    else:
        score = RED
    return {
        "score": score,
        "reason": f"{gap_days}d since last meeting (expected every {expected_days}d, {cadence_label})",
        "gap_days": gap_days, "expected_days": expected_days,
    }


# ── 1.4 team load (stub -- see docs/scoring-spec-draft.md section 1.4) ─────

def _score_team_load() -> dict:
    return {
        "score": None, "status": NOT_CONFIGURED,
        "reason": "no per-assignee task-count data yet -- needs a Monday query grouped by assignee, "
                  "plus per-person capacity thresholds (docs/scoring-spec-draft.md section 1.4)",
    }


# ── 1.5 composite ───────────────────────────────────────────────────────────

def _composite(sub_scores: dict) -> dict:
    weighted_sum = 0.0
    total_weight = 0.0
    for key, weight in WEIGHTS.items():
        sub = sub_scores.get(key) or {}
        if sub.get("score") not in SCORE_VALUE:
            continue
        weighted_sum += SCORE_VALUE[sub["score"]] * weight
        total_weight += weight
    if total_weight == 0:
        return {"composite": None, "label": None}
    composite = round(weighted_sum / total_weight)
    label = GREEN if composite >= 80 else YELLOW if composite >= 50 else RED
    return {"composite": composite, "label": label}


# ── section 3: flag -> suggested action ─────────────────────────────────────

def _derive_flags(entry: dict, sub_scores: dict) -> list:
    flags = []
    stalled_items = [
        item for dept in (entry.get("work_by_department") or [])
        for item in (dept.get("stalled_items") or [])
    ]
    review = (entry.get("stats") or {}).get("review", 0)

    if review >= 5:
        flags.append({"id": "pending_review_bottleneck", **FLAG_ACTIONS["pending_review_bottleneck"]})
    if any((i.get("days_stalled") or 0) > 20 for i in stalled_items):
        flags.append({"id": "long_stalled_task", **FLAG_ACTIONS["long_stalled_task"]})
    if (sub_scores.get("comms_quality") or {}).get("score") == RED:
        flags.append({"id": "comms_quality_red", **FLAG_ACTIONS["comms_quality_red"]})
    if (sub_scores.get("meeting_cadence") or {}).get("score") == RED:
        flags.append({"id": "meeting_cadence_red", **FLAG_ACTIONS["meeting_cadence_red"]})
    return flags


# ── orchestrator ─────────────────────────────────────────────────────────────

# Not real operational clients -- excluded from Layer 1 entirely (no
# composite, no sub-score chips, no scores-history row). Same treatment the
# `potential_clients` entries already get: entry["scores"] is simply never
# set, and app.js already renders that as "no score section" rather than a
# red/zero score.
#   - Flow Company: internal pseudo-client, not a real client.
#   - Vous Physique: offboarded 2026-08-13, no longer a client -- kept in
#     this set (not deleted) so historical scoring stays consistent.
EXCLUDED_CLIENTS = {"Flow Company", "Vous Physique"}


def compute_layer1_scores(*, call_tool, ai, client_entries: list, grouped: dict,
                           meetings_by_client: dict, today: str) -> list:
    """Attaches entry["scores"] to each entry in client_entries (in place),
    except EXCLUDED_CLIENTS which are skipped entirely. Returns the flat rows
    meant to be appended to scores-history.json."""
    cadence_map = _load_cadence_config()
    cadence_state = _load_json(CADENCE_STATE_PATH, {})
    scored_grouped = {c: v for c, v in grouped.items() if c not in EXCLUDED_CLIENTS}
    comms_scores = _score_comms_quality_all(call_tool, ai, scored_grouped, today)

    rows = []
    for entry in client_entries:
        client = entry["client"]
        if client in EXCLUDED_CLIENTS:
            continue
        sub_scores = {
            "task_stalling": _score_task_stalling(entry),
            "comms_quality": comms_scores.get(client, {"score": None, "reason": "no data"}),
            "meeting_cadence": _score_meeting_cadence(
                client, meetings_by_client.get(client, []), today, cadence_map, cadence_state,
            ),
            "team_load": _score_team_load(),
        }
        comp = _composite(sub_scores)
        entry["scores"] = {
            "composite": comp["composite"],
            "label": comp["label"],
            "sub_scores": sub_scores,
            "flags": _derive_flags(entry, sub_scores),
        }
        rows.append({
            "date": today,
            "client": client,
            "composite_health": comp["composite"],
            "composite_label": comp["label"],  # red/yellow/green -- extra vs. the doc's shape, saves the frontend from re-deriving thresholds
            "sub_scores": sub_scores,
            "composite_risk": None,  # Layer 2 -- not built yet
            "risk_sub_scores": None,
        })

    _save_json(CADENCE_STATE_PATH, cadence_state)
    return rows


def append_scores_history(rows: list, path: Path = SCORES_HISTORY_PATH) -> None:
    existing = _load_json(path, [])
    if not isinstance(existing, list):
        existing = []
    existing.extend(rows)
    _save_json(path, existing)
