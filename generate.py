"""
generate.py — Main orchestrator for the weekly standup.

Architecture (v2): instead of one giant Claude call that produces the whole
standup (which reliably truncated at max_tokens), this makes ONE SMALL CALL
PER CLIENT plus one small wrap-up call, then assembles the final standup in
Python. Mirrors the proven flow-analyst per-client pattern.

Run: python generate.py
"""

import difflib
import hashlib
import html
import io
import json
import os
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

from fetch_monday import fetch_all_boards, resolve_client, set_monday_status_done
from fetch_fireflies import fetch_transcripts
from fetch_whatsapp import fetch_whatsapp
from send_email import send_standup_email, markdown_to_simple_html
import archive_monday
import pulse_story
import drive_pulse

MODEL = "claude-sonnet-4-5"


# ── config / playbooks ────────────────────────────────────────────────────────

def load_config() -> dict:
    with open("config.json") as f:
        return json.load(f)


def _match_playbook_to_client(stem: str, clients_config: dict) -> str:
    result = resolve_client(stem, clients_config, fuzzy=True)
    return result if result != "Unmapped" else stem


def load_playbooks(clients_config: dict) -> dict[str, str]:
    """Load local playbooks/*.md files. Returns {canonical_client_or_stem: content}."""
    playbooks_dir = Path("playbooks")
    result: dict[str, str] = {}
    if not playbooks_dir.exists():
        return result
    for filepath in sorted(playbooks_dir.glob("*.md")):
        content = filepath.read_text(encoding="utf-8").strip()
        if content:
            client = _match_playbook_to_client(filepath.stem, clients_config)
            result[client] = content
    return result


def load_playbooks_drive(config: dict, clients_config: dict) -> dict[str, str]:
    """Load playbooks from the configured Google Drive folder. {} on any failure."""
    folder_id = config.get("playbooks_drive_folder_id", "")
    sa_json_str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not folder_id or not sa_json_str:
        return {}

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload

        sa_info = json.loads(sa_json_str)
        creds = service_account.Credentials.from_service_account_info(
            sa_info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
        )
        service = build("drive", "v3", credentials=creds, cache_discovery=False)

        # List everything and filter in code - Drive's mime stamps for uploaded
        # .md/.txt files are unpredictable (text/x-markdown, octet-stream, etc).
        query = f"'{folder_id}' in parents and trashed = false"
        resp = service.files().list(
            q=query,
            fields="files(id, name, mimeType)",
            pageSize=50,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()

        result: dict[str, str] = {}
        for file in resp.get("files", []):
            file_id = file["id"]
            name = file["name"]
            mime = file["mimeType"]
            is_gdoc = mime == "application/vnd.google-apps.document"
            is_text = name.lower().endswith((".md", ".txt", ".markdown"))
            if not (is_gdoc or is_text):
                continue
            stem = name
            for ext in (".md", ".txt", ".markdown"):
                if name.lower().endswith(ext):
                    stem = name[: -len(ext)]
                    break

            try:
                if mime == "application/vnd.google-apps.document":
                    raw = service.files().export(
                        fileId=file_id, mimeType="text/plain"
                    ).execute()
                    content = raw.decode("utf-8", errors="replace").strip()
                else:
                    buf = io.BytesIO()
                    downloader = MediaIoBaseDownload(
                        buf, service.files().get_media(fileId=file_id, supportsAllDrives=True)
                    )
                    done = False
                    while not done:
                        _, done = downloader.next_chunk()
                    content = buf.getvalue().decode("utf-8", errors="replace").strip()

                if content:
                    client = _match_playbook_to_client(stem, clients_config)
                    result[client] = content
                    print(f"    ✓ '{name}' → {client}")
            except Exception as exc:
                print(f"    ⚠️  Drive: could not read '{name}': {exc}")

        return result
    except Exception as exc:
        print(f"  ⚠️  Drive playbooks unavailable: {exc}")
        return {}


# ── pulse window (live items only) ────────────────────────────────────────────

def filter_live_items(monday_data: list, config: dict) -> tuple[list, int]:
    """Keep only items created or updated within the pulse window, UNLESS the
    item's Monday group already resolved (at fetch time) to a real configured
    client rather than "Unmapped" -- a signed client shouldn't silently lose
    their standup card just because their work has gone quiet for
    pulse_window_days. This filter exists to keep noise (stale items in
    unmapped/random groups) out of the AI's context, not to prune a real
    client's history out from under them. Dormant/archived Unmapped items
    never reach the AI. Returns (filtered, pruned_count)."""
    from datetime import timedelta
    pulse_days = int(config.get("pulse_window_days", 45))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=pulse_days)).date().isoformat()

    pruned = 0
    filtered = []
    for board in monday_data:
        if "error" in board:
            filtered.append(board)
            continue
        live = []
        for item in board.get("items", []):
            if item.get("client", "Unmapped") != "Unmapped":
                live.append(item)
                continue
            last = item.get("last_updated") or ""
            created = item.get("created_at") or ""
            if (last and last >= cutoff) or (created and created >= cutoff):
                live.append(item)
            else:
                pruned += 1
        filtered.append({**board, "items": live})
    return filtered, pruned


# ── client grouping ───────────────────────────────────────────────────────────

def group_items_by_client(
    monday_data: list, clients_config: dict
) -> tuple[dict, dict]:
    raw: dict[str, dict[str, list]] = {}
    board_errors: dict[str, str] = {}

    for board in monday_data:
        dept = board["board_name"]
        if "error" in board:
            board_errors[dept] = board["error"]
            continue
        for item in board["items"]:
            client = item.get("client", "Unmapped")
            raw.setdefault(client, {}).setdefault(dept, []).append(item)

    ordered: dict[str, dict] = {}
    for canonical in clients_config:
        if canonical in raw:
            ordered[canonical] = raw[canonical]
    for client in raw:
        if client not in ordered and client != "Unmapped":
            ordered[client] = raw[client]
    if "Unmapped" in raw:
        ordered["Unmapped"] = raw["Unmapped"]

    return ordered, board_errors


def _match_comms_to_client(text: str, clients_config: dict, active_clients: set[str] | None = None) -> str:
    """active_clients, when given, gates the match: a fuzzy alias hit only
    counts if that client also has real activity on the actual Monday boards
    this pulse window. Without that corroboration a superficial resemblance
    (shared word, similar industry) can't force-assign onto a signed client's
    card -- it falls through to General comms, which build_potential_clients
    then decides whether to surface as its own prospect card."""
    result = resolve_client(text, clients_config, fuzzy=True)
    if result == "Unmapped":
        return "General comms"
    if active_clients is not None and result not in active_clients:
        return "General comms"
    return result


# Fireflies auto-titles and transcript content naturally include a client's
# own name whenever a call is genuinely about their work -- for every other
# client that's a real signal. Flow Company is different: it's the agency's
# OWN name, so it shows up in the title and/or content of nearly any call it
# participates in, whether that's real internal work or a sales pitch to an
# unrelated prospect. Confirmed live: a call titled "Parth Patel and Flow
# Company" title-matched Flow Company, and even past that, the transcript's
# own content ("Send Flow Company's marketing deck to Parth Patel") matches
# too -- there's no text signal left that can tell the two apart. Flow
# Company is never a valid meeting-match target here at all; its standup
# presence comes entirely from its own real Monday board activity instead.
NEVER_MATCH_VIA_MEETING_TEXT = {"Flow Company"}


def match_meeting_clients(mt: dict, clients_config: dict, active_clients: set[str]) -> list[str]:
    """Match a meeting to one or more clients.
    1) Title match (strongest signal) — trusted even for a currently-quiet
       client, since a meeting literally titled with the client's name is
       strong evidence on its own. Can return several clients (a title that
       genuinely names more than one).
    2) Else scan the summary CONTENT for client aliases — but a content-only
       hit is corroboration-only: it's only trusted when that client also has
       real activity on the actual Monday boards this pulse window
       (active_clients). Otherwise a prospect that merely resembles a signed
       client (same industry, an overlapping word) would get force-assigned
       onto that client's card instead of surfacing as its own prospect.
       Further restricted to exactly ONE confirmed client -- confirmed live:
       a meeting titled "goh-xgjm-nza" (a bare Google Meet room code, not a
       real title) whose content briefly touched four different active
       clients' campaigns was a generic internal status sync, not any one
       of their real meetings. A real single-client meeting is never
       legitimately about several different clients at once, so content
       matching several is the internal-sync signature, not corroboration --
       treated the same as no match at all, rather than guessing which one
       (if any) it's "really" about.
    3) Else empty -- caller treats this as unmatched (General comms / a
       potential-client candidate), never guessed.
    NEVER_MATCH_VIA_MEETING_TEXT is filtered out of both title and content
    matches before any of the above logic even applies."""
    from fetch_monday import all_alias_matches
    title_matches = [c for c in all_alias_matches(mt.get("title", ""), clients_config)
                      if c not in NEVER_MATCH_VIA_MEETING_TEXT]
    if title_matches:
        return title_matches[:4]

    confirmed = _confirmed_content_matches(mt, clients_config, active_clients)
    return confirmed if len(confirmed) == 1 else []


def _confirmed_content_matches(mt: dict, clients_config: dict, active_clients: set[str]) -> list[str]:
    """Client aliases found in a meeting's summary/sentence CONTENT, ANDed
    against active_clients for corroboration -- the raw candidate set
    match_meeting_clients decides whether to trust (exactly one) or treat
    as an internal-sync signal instead (more than one). Factored out so
    is_ambiguous_internal_meeting can reuse the exact same candidate set
    rather than a second, possibly-drifting copy of this scan."""
    from fetch_monday import all_alias_matches
    summary = mt.get("summary") or {}
    haystack = " ".join([
        str(summary.get("overview") or ""),
        str(summary.get("action_items") or ""),
        " ".join(summary.get("keywords") or []) if isinstance(summary.get("keywords"), list) else "",
    ]).lower()
    if mt.get("sentences"):
        haystack += " " + " ".join(s.get("text", "") for s in mt["sentences"][:60]).lower()

    matches = [c for c in all_alias_matches(haystack, clients_config) if c not in NEVER_MATCH_VIA_MEETING_TEXT]
    return [m for m in matches if m in active_clients]


def is_ambiguous_internal_meeting(mt: dict, clients_config: dict, active_clients: set[str]) -> bool:
    """True when a meeting's own content references more than one
    currently-active client at once, with no title match of its own --
    the exact signature of a generic internal status sync (confirmed live:
    a bare Google Meet room code "goh-xgjm-nza" whose content briefly
    touched four different clients' campaigns), not a genuine unmatched
    prospect. match_meeting_clients already keeps a meeting like this from
    landing on any one client's own review (see the "exactly one" rule
    above) -- this keeps it from ALSO resurfacing as a fabricated
    potential-client card just because nothing else claimed it. Callers
    should still let it into meetings_by_client["General comms"] (so it's
    visible in the meetings digest) and only filter it out of whatever
    feeds build_potential_clients specifically."""
    from fetch_monday import all_alias_matches
    if all_alias_matches(mt.get("title", ""), clients_config):
        return False
    return len(_confirmed_content_matches(mt, clients_config, active_clients)) > 1


# ── potential clients (prospects, not signed clients) ────────────────────────
#
# Anything that doesn't clearly match an existing client in the active roster
# no longer gets force-merged into whichever signed client it superficially
# resembles. It lands here instead -- one card per distinct prospect -- fed by
# meetings/chats that matched nothing (General comms pool), real Monday items
# sitting under a group title that matches no configured client alias at all,
# and off-topic content the per-client summarization filtered out of a
# correctly-matched client's own card.
#
# non_client_entities (config.json) is an explicit, maintained exclusion list
# for known-not-a-prospect entities -- Flow's own internal department
# WhatsApp channels, known vendor/tool contacts helping with Flow's own
# platform setup, etc. This replaces a keyword-guess heuristic that only
# scanned meeting titles (missed WhatsApp chat names entirely) and had no
# concept of specific known non-client entities -- add an entry here whenever
# a genuinely-internal channel or vendor contact starts showing up as a fake
# prospect card. Matched fuzzily (via _text_similarity below), never by exact
# string equality, so a WhatsApp export's OS-appended "(2)"/"(3)" duplicate
# suffix or a slightly reworded meeting title still matches the entry.

# ── shared fuzzy-name matching (dedup, exclusions, alias-gap detection) ───────
#
# One mechanism, reused everywhere two free-text names might refer to the
# same real-world thing: completion dedup (a WhatsApp message vs. a
# near-duplicate follow-up), the non_client_entities exclusion list (a known
# channel/vendor name vs. however it actually appears in the data), prospect
# bucketing (two different sources naming the same business differently),
# and alias-gap detection (an unmapped Monday group vs. an existing client's
# configured aliases). Adding a case to any of these should never require a
# new one-off string comparison -- extend this shared function instead.

SIMILARITY_DUP_THRESHOLD = 0.6


def _norm_dedup_text(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def _text_similarity(a: str, b: str) -> float:
    """0.0-1.0. A plain SequenceMatcher ratio() on the full strings penalizes
    a short name that's simply CONTAINED in a longer one (e.g. a concise
    extracted entity name vs. a fuller title for the same thing) for the
    length gap alone -- 'Citrus Smiles' vs 'Citrus Smiles Marketing Systems'
    scores only ~0.59 on ratio() alone, below any reasonable dup threshold,
    even though every character of the shorter name appears verbatim in the
    longer one. Full containment (either direction) of a non-trivial-length
    string (8+ chars, so a short generic word like 'Cotton' can't
    single-handedly match a longer unrelated name) is treated as a perfect
    match; everything else falls back to the plain ratio."""
    na, nb = _norm_dedup_text(a), _norm_dedup_text(b)
    if not na or not nb:
        return 0.0
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(shorter) >= 8 and shorter in longer:
        return 1.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


# Client names/aliases are typically short (1-3 words), where plain
# character-ratio similarity is noisy -- e.g. "Citrus Smiles" vs "Full
# Smile" scores 0.609 on _text_similarity purely from sharing "smile(s)",
# comfortably clearing SIMILARITY_DUP_THRESHOLD (0.6) despite being
# unrelated businesses. Real near-matches (typos, minor renames) score much
# higher: "Full Smile Dentle" vs "Full Smile" = 1.0, "Fibbid" vs "Fibid" =
# 0.909, "MedStaton" vs "MedStation" = 0.947. A stricter threshold for this
# specific short-string comparison cleanly separates the two -- same shared
# _text_similarity function, just calibrated for where it's applied.
ALIAS_GAP_SIMILARITY_THRESHOLD = 0.8


def _find_near_client_match(name: str, clients_config: dict) -> str | None:
    """A Monday group with no exact alias match might not be a new prospect
    at all -- it could be an EXISTING client's group that silently fell out
    of the roster (renamed on the board, a typo, a missing alias entry that
    was never added). Checked against every configured client's canonical
    name and all its aliases with the same shared fuzzy-match mechanism used
    everywhere else here (just a stricter threshold -- see
    ALIAS_GAP_SIMILARITY_THRESHOLD above). Returns the canonical client name
    on a probable match, else None (a genuinely new, unconfigured business,
    e.g. an early-stage client with no roster entry yet at all)."""
    for canonical, aliases in clients_config.items():
        for candidate in [canonical, *(aliases or [])]:
            if _text_similarity(name, candidate) >= ALIAS_GAP_SIMILARITY_THRESHOLD:
                return canonical
    return None


def _strip_markdown(text: str) -> str:
    """Defense in depth, not a substitute for the prompt asking for plain
    prose: strips **bold** markers and leading bullet dashes a model
    sometimes reaches for out of habit even when told not to, so unrendered
    markdown syntax never reaches the page."""
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text or "")
    text = re.sub(r"(?m)^\s*[-*•]\s+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def synthesize_meeting_prospects(ai: "anthropic.Anthropic", meetings: list[dict], today: str) -> list[dict]:
    """One batched Claude call turns each unmatched meeting into a clean
    {entity_name, summary, action_items} -- entity_name specifically so the
    existing name-similarity dedup in build_potential_clients (unchanged)
    can recognize two differently-titled meetings as the same real prospect,
    the same general mechanism already used for a model-extracted entity
    name elsewhere in this pipeline; summary/action_items so a single-
    meeting prospect never needs a raw bullet dump or a second AI pass to
    read cleanly. Falls back per-meeting (raw title as entity_name, a
    markdown-stripped overview slice as summary) if the call fails or a
    given meeting's row comes back missing/bare -- a degraded synthesis,
    never a lost one."""
    if not meetings:
        return []

    by_index: dict[int, dict] = {}
    try:
        prompt = pulse_story.build_meeting_prospect_synthesis_prompt(meetings, today)
        result = _call_tool(ai, prompt, EMIT_MEETING_PROSPECT_SYNTHESIS_TOOL, label="prospect-meetings", max_tokens=3000)
        for row in (result.get("meetings", []) or []):
            idx = row.get("index")
            if isinstance(idx, int):
                by_index[idx] = row
    except Exception as exc:
        print(f"  ⚠️  Prospect meeting synthesis failed ({exc}) -- using raw titles/overviews as a fallback")

    out = []
    for i, mt in enumerate(meetings):
        row = by_index.get(i)
        title = mt.get("title") or "Untitled"
        entity_name = (row.get("entity_name") or "").strip() if row else ""
        summary = _strip_markdown(row.get("summary") or "") if row else ""
        action_items = [a for a in (row.get("action_items") or []) if a] if row else []
        if not entity_name or not summary:
            fallback_overview = str((mt.get("summary") or {}).get("overview") or "").strip()
            entity_name = entity_name or title
            summary = summary or _strip_markdown(fallback_overview)[:400]
            action_items = action_items or _summary_lines((mt.get("summary") or {}).get("action_items"), 6)
        out.append({
            "title": title,
            "date": mt.get("date", ""),
            "entity_name": entity_name,
            "summary": summary or None,
            "action_items": action_items,
        })
    return out


def finalize_prospect_summaries(ai: "anthropic.Anthropic", prospects: list[dict], today: str) -> None:
    """Mutates each prospect in place: lifts its meeting content into ONE
    top-level summary/action_items field instead of leaving it scattered
    per-item (which is what caused meeting content to render as several
    raw bullet dumps back to back). A prospect with exactly one meeting
    just lifts that meeting's already-clean synthesis directly -- no
    second AI call needed. A prospect with two or more (post-dedup, so
    these are genuinely the same real prospect under different meeting
    titles) gets ONE combined batched call across every such prospect.
    Per-item overview/action_items are cleared afterward either way --
    the top-level fields are the only rendering surface now."""
    single: list[dict] = []
    multi: list[dict] = []
    for p in prospects:
        meeting_items = [it for it in p.get("items", []) if it.get("source") == "meeting" and it.get("overview")]
        if not meeting_items:
            continue
        elif len(meeting_items) == 1:
            single.append((p, meeting_items))
        else:
            multi.append((p, meeting_items))

    for p, meeting_items in single:
        p["summary"] = meeting_items[0]["overview"]
        p["action_items"] = meeting_items[0]["action_items"]

    if multi:
        try:
            prompt = pulse_story.build_prospect_group_synthesis_prompt(
                [{"name": p["name"], "meeting_summaries": [
                    {"summary": it["overview"], "action_items": it["action_items"]} for it in items
                ]} for p, items in multi],
                today,
            )
            result = _call_tool(ai, prompt, EMIT_PROSPECT_GROUP_SYNTHESIS_TOOL, label="prospect-groups", max_tokens=3000)
            by_name = {row.get("name"): row for row in (result.get("prospects", []) or []) if row.get("name")}
        except Exception as exc:
            print(f"  ⚠️  Prospect group synthesis failed ({exc}) -- falling back to each prospect's most recent meeting")
            by_name = {}

        for p, meeting_items in multi:
            row = by_name.get(p["name"])
            if row and row.get("summary"):
                p["summary"] = _strip_markdown(row["summary"])
                p["action_items"] = [a for a in (row.get("action_items") or []) if a]
            else:
                # Degraded but not lost: the single most recent meeting's
                # own clean synthesis, never a multi-meeting raw dump.
                most_recent = max(meeting_items, key=lambda it: it.get("when") or "")
                p["summary"] = most_recent["overview"]
                p["action_items"] = most_recent["action_items"]

    # Per-item overview/action_items were only ever scratch space for this
    # function -- the top-level fields set above are the one rendering
    # surface for meeting content from here on.
    for p in prospects:
        for it in p.get("items", []):
            it.pop("overview", None)
            it.pop("action_items", None)


def build_potential_clients(
    monday_data: list, general_meetings: list, general_chats: list,
    clients_config: dict,
    non_client_entities: list[str],
    off_topic_mentions: list[dict] | None = None,
) -> list[dict]:
    prospects: dict[str, dict] = {}
    exclusions = [e for e in (non_client_entities or []) if (e or "").strip()]

    def _is_known_non_client(name: str) -> bool:
        needle = (name or "").lower()
        for e in exclusions:
            if _text_similarity(name, e) >= SIMILARITY_DUP_THRESHOLD:
                return True
            # A short exclusion entry (a person's first name, say) often shows
            # up as just one word inside a differently-shaped meeting title
            # ("Sohib X Ziad" for an excluded "Ziad") -- whole-string fuzzy
            # similarity alone misses that, since the rest of the title
            # doesn't overlap enough to clear the ratio threshold. Whole-word
            # containment (same mechanism as real client alias matching,
            # fetch_monday.all_alias_matches) catches it directly -- no
            # length floor here, unlike _text_similarity's full-containment
            # shortcut: a short exclusion word is exactly the case this is
            # for, not a false-positive risk to guard against, since this
            # list is a maintained, human-curated exclusion list, not
            # arbitrary fuzzy client-name matching.
            e_low = (e or "").strip().lower()
            if e_low and re.search(r"(?<!\w)" + re.escape(e_low) + r"(?!\w)", needle):
                return True
        return False

    def _bucket(name: str, source: str, blurb: str, when: str, possible_existing_client: str | None = None,
                overview: str | None = None, action_items: list[str] | None = None):
        name = (name or "").strip()
        if not name or _is_known_non_client(name):
            return
        key = name.lower()
        # Merge into an existing card for the same prospect under a
        # different spelling instead of creating a second one -- the exact
        # same fuzzy-match mechanism (and threshold) used for completion
        # dedup, so any future pair of differently-worded mentions of the
        # same prospect merges automatically, not just this one.
        for existing_key, existing in prospects.items():
            if _text_similarity(name, existing["name"]) >= SIMILARITY_DUP_THRESHOLD:
                key = existing_key
                break
        if key not in prospects:
            prospects[key] = {"name": name, "sources": [], "items": [], "possible_existing_client": None}
        elif len(name) < len(prospects[key]["name"]):
            # Prefer the shorter/cleaner name as the card title -- a concise
            # extracted entity name reads better than a full meeting title.
            prospects[key]["name"] = name
        if source not in prospects[key]["sources"]:
            prospects[key]["sources"].append(source)
        prospects[key]["items"].append({
            "source": source, "blurb": blurb, "when": when,
            # Only meeting-sourced items have real Fireflies summary data
            # behind them -- None/empty for whatsapp/monday_group/mention,
            # the detail view just falls back to the blurb for those.
            "overview": overview or None,
            "action_items": action_items or [],
        })
        if possible_existing_client:
            prospects[key]["possible_existing_client"] = possible_existing_client

    for sm in general_meetings or []:
        # sm is a pre-synthesized meeting dict from synthesize_meeting_prospects
        # (entity_name/summary/action_items), NOT a raw Fireflies transcript --
        # bucketing by the clean entity_name (rather than the raw, often noisy
        # meeting title) is what lets the unchanged name-similarity merge
        # below actually recognize two differently-titled meetings as the
        # same real prospect.
        entity_name = sm.get("entity_name") or sm.get("title") or "Untitled"
        overview = (sm.get("summary") or "").strip()
        blurb = overview[:200] or "Meeting — no summary available."
        _bucket(entity_name, "meeting", blurb, sm.get("date", ""),
                overview=overview or None, action_items=sm.get("action_items") or [])

    for chat_name, msgs in general_chats or []:
        n = len(msgs) if isinstance(msgs, list) else 0
        if not n:
            continue
        last = msgs[-1] if isinstance(msgs, list) and msgs else {}
        blurb = f"{n} message(s); most recent: {(last.get('text') or '')[:160]}"
        _bucket(chat_name, "whatsapp", blurb, (last.get("datetime") or "")[:16])

    for board in monday_data:
        if "error" in board:
            continue
        for item in board.get("items", []):
            if item.get("client") == "Unmapped" and item.get("group"):
                group = item["group"]
                # A Monday group with no matching alias might not be a new
                # prospect at all -- it could be a real signed client's board
                # activity that silently fell out of the roster (renamed
                # group, typo, a missing alias entry never added). Checked
                # against every configured client's canonical name AND all
                # its aliases with the same shared fuzzy match, so this is
                # never a client-specific special case.
                near_client = _find_near_client_match(group, clients_config)
                if near_client:
                    blurb = (f"\"{item.get('name', '')}\" on {board['board_name']} — group \"{group}\" has no "
                             f"configured alias, but closely resembles the existing client \"{near_client}\". "
                             f"Possible alias gap, not necessarily a new business.")
                else:
                    blurb = f"\"{item.get('name', '')}\" on {board['board_name']} — unrecognized group \"{group}\"."
                _bucket(group, "monday_group", blurb, item.get("last_updated") or item.get("created_at") or "",
                        possible_existing_client=near_client)

    for m in off_topic_mentions or []:
        entity = (m.get("entity") or "").strip()
        text = (m.get("text") or "").strip()
        if not entity or not text:
            continue
        _bucket(entity, "mention", text, "")

    return sorted(prospects.values(), key=lambda p: p["name"].lower())


def assess_prospect_likelihood(ai: "anthropic.Anthropic", prospects: list[dict], today: str) -> None:
    """Mutates each prospect in place with likelihood_percent/likelihood_reason
    -- a subjective tone read (enthusiasm, objections, next-step commitment,
    budget talk), never treated as measured data. Skipped entirely (no
    fields set, no placeholder number) for a prospect the model judged too
    thin to read, and for the whole list if the call fails outright -- an
    absent estimate is honest; a guessed one isn't. The site is responsible
    for always rendering this flagged as an estimate, the same way it flags
    a generated (as opposed to real) completion summary."""
    if not prospects:
        return
    try:
        prompt = pulse_story.build_prospect_likelihood_prompt(prospects, today)
        result = _call_tool(ai, prompt, EMIT_PROSPECT_LIKELIHOOD_TOOL, label="prospect-likelihood", max_tokens=1500)
        by_name = {}
        for row in (result.get("assessments", []) or []):
            name = (row.get("name") or "").strip()
            if name:
                by_name[name] = row
    except Exception as exc:
        print(f"  ⚠️  Prospect likelihood assessment failed ({exc}) -- no estimates shown this run")
        return

    for p in prospects:
        row = by_name.get(p.get("name", ""))
        if not row:
            continue
        pct = row.get("percent")
        if isinstance(pct, (int, float)) and 0 <= pct <= 100:
            p["likelihood_percent"] = int(round(pct))
            p["likelihood_reason"] = (row.get("reason") or "").strip()


# ── URL lookup (Python owns URLs — the model never writes them) ──────────────

def build_url_lookup(monday_data: list) -> dict[str, str]:
    """item_id (and subitem id) -> monday_url, from fetched data only.
    Guarantees no invented URLs. Subitems live on a linked board, so their
    URL uses their OWN board id, not the parent's."""
    lookup: dict[str, str] = {}
    for board in monday_data:
        for item in board.get("items", []):
            iid = item.get("item_id")
            url = item.get("monday_url")
            if iid and url:
                lookup[str(iid)] = url
            for sub in item.get("subitems", []) or []:
                sid = sub.get("id")
                surl = sub.get("monday_url")
                if sid and surl:
                    lookup[str(sid)] = surl
    return lookup


# ── per-client prompt ─────────────────────────────────────────────────────────

def _board_line(item: dict, today: str) -> str:
    """One compact line per board item — a snapshot, not an audit."""
    bits = [f"[id: {item.get('item_id', '?')}] {item['name']}"]
    cols = item.get("columns") or {}
    status = next((v for k, v in cols.items() if "status" in k.lower()), None)
    if status:
        bits.append(f"status: {status}")
    if item.get("last_updated"):
        bits.append(f"last activity: {item['last_updated']}")
    elif item.get("created_at"):
        bits.append(f"created: {item['created_at']}")
    n_subs = len(item.get("subitems") or [])
    if n_subs:
        bits.append(f"{n_subs} subitems")
    return "  - " + "  |  ".join(bits)


def _collect_monday_messages(departments: dict[str, list]) -> list[str]:
    """Pull update threads out of items into a first-class comms feed."""
    msgs = []
    for dept, items in departments.items():
        for item in items:
            for upd in (item.get("recent_updates") or [])[:4]:
                ts = (upd.get("created_at") or "")[:10]
                who = upd.get("creator", "?")
                body = (upd.get("body") or "").strip()[:300]
                if body:
                    msgs.append(f"  [{ts} — {who}] on \"{item['name']}\" ({dept}): {body}")
    return sorted(msgs, reverse=True)


def build_client_prompt(
    client: str,
    departments: dict[str, list],
    meetings: list,
    chats: list[tuple],
    playbook: str | None,
    today: str,
    days_back: int,
) -> str:
    parts: list[str] = []
    parts.append(
        f"# Weekly pulse — {client} — week ending {today}\n\n"
        "You are writing a CALM WEEKLY PULSE for one client of Flow Co., a marketing agency. "
        "The reader wants a clear picture of where this project stands — not an audit, not a "
        "task list, not a call to action.\n\n"
        "SOURCE PRIORITY — this ordering is the whole point:\n"
        "1. MEETINGS and MONDAY MESSAGES are the primary truth: what was said, agreed, "
        "delivered, or raised this week IS the pulse.\n"
        "2. WHATSAPP messages are secondary color.\n"
        "3. The BOARD SNAPSHOT is background corroboration only. Do NOT narrate board items "
        "or statuses that nobody talked about, unless one is strikingly stalled or brand new.\n\n"
        "OUTPUT RULES:\n"
        "- headline: terse phrase, max 8 words, NOT a full sentence. State, not urgency.\n"
        "- Every row text is a phrase max 10 words — substance over meta.\n"
        "- health: on_track / needs_attention / at_risk, judged comms-first (silence + stalls "
        "can mean needs_attention; an unhappy message outweighs a green board).\n"
        "- highlights: MAX 3, what actually happened this week, drawn from comms first. "
        "SUBSTANCE over meta: say WHAT was said or delivered (the decision, the number, the "
        "name, the change) — NEVER 'posted an update', 'discussed X', or 'had a meeting'. "
        "If an update's content is in the data, the row carries that content.\n"
        "- stalled_items: MAX 2, only things genuinely stuck that matter. Skip minor ones.\n"
        "- status_change_suggestions: usually EMPTY. Only when comms directly contradict the "
        "board (e.g. delivered in a meeting but board says Working).\n"
        "- risks: MAX 1, only if real. Otherwise empty.\n"
        "- Every row cites monday_item_id verbatim from [id: N] when it concerns a board item; "
        "null for meeting/whatsapp rows. NEVER invent ids.\n"
        f"- Today is {today}. Newest signal wins. If sources are quiet, say the week was quiet — "
        "that is a valid pulse. Never pad.\n"
    )

    if playbook:
        parts.append("\n## CLIENT PLAYBOOK (context for what good looks like)\n" + playbook[:3000])

    parts.append("\n## 1. MEETINGS THIS WEEK (primary)\n")
    if meetings:
        for mt in meetings:
            parts.append(f"**{mt.get('title', 'Untitled')}** — {mt.get('date', 'no date')}")
            summary = mt.get("summary") or {}
            if summary.get("overview"):
                parts.append(f"  Overview: {str(summary['overview'])[:700]}")
            if summary.get("action_items"):
                parts.append(f"  Action items: {str(summary['action_items'])[:500]}")
            if mt.get("sentences"):
                parts.append("  [No summary — excerpt:]")
                for s in mt["sentences"][:10]:
                    parts.append(f"    {s.get('speaker_name', '?')}: {s.get('text', '')}")
            parts.append("")
    else:
        parts.append("None.\n")

    monday_msgs = _collect_monday_messages(departments)
    parts.append("\n## 2. MONDAY MESSAGES THIS WEEK (primary)\n")
    if monday_msgs:
        parts.extend(monday_msgs[:25])
    else:
        parts.append("None.")

    parts.append("\n\n## 3. WHATSAPP (secondary)\n")
    if chats:
        for chat_name, msgs in chats:
            parts.append(f"**Chat: {chat_name}**")
            if isinstance(msgs, list):
                for msg in msgs[:30]:
                    ts = (msg.get("datetime") or "")[:16]
                    parts.append(f"  [{ts}] {msg.get('sender', '?')}: {(msg.get('text') or '')[:220]}")
            parts.append("")
    else:
        parts.append("None.\n")

    parts.append("\n## 4. BOARD SNAPSHOT (background only)\n")
    if departments:
        for dept in sorted(departments):
            parts.append(f"### {dept}")
            for item in departments[dept]:
                parts.append(_board_line(item, today))
            parts.append("")
    else:
        parts.append("No live board items in the pulse window.\n")

    return "\n".join(parts)


# ── tool schemas ──────────────────────────────────────────────────────────────

_CLIENT_ROW = {
    "type": "object",
    "required": ["text", "department", "source"],
    "properties": {
        "text": {"type": "string", "description": "Phrase max 10 words — no full sentences."},
        "department": {"type": "string", "description": "CRM, Ads, Video, or Web + SEO. Empty string if not board work."},
        "source": {"type": "string", "enum": ["monday", "meeting", "whatsapp"]},
        "item_name": {"type": ["string", "null"], "description": "Monday item name if source=monday."},
        "monday_item_id": {"type": ["string", "null"], "description": "Verbatim [id: N] value from the data. Null otherwise. NEVER invent."},
        "days_stalled": {"type": ["integer", "null"]},
    },
}

EMIT_CLIENT_TOOL = {
    "name": "emit_client",
    "description": "Emit the weekly review for ONE client.",
    "input_schema": {
        "type": "object",
        "required": ["headline", "health", "highlights", "stalled_items",
                     "status_change_suggestions", "risks"],
        "properties": {
            "headline": {"type": "string", "description": "Terse status phrase, max 8 words, telegraphic, never a full sentence."},
            "health": {"type": "string", "enum": ["on_track", "needs_attention", "at_risk"]},
            "highlights": {"type": "array", "maxItems": 3, "items": _CLIENT_ROW},
            "stalled_items": {"type": "array", "maxItems": 2, "items": _CLIENT_ROW},
            "status_change_suggestions": {
                "type": "array",
                "maxItems": 3,
                "description": "SUGGESTIONS ONLY, never decisions.",
                "items": {
                    "type": "object",
                    "required": ["item_name", "department", "current_status", "suggested_status", "reason"],
                    "properties": {
                        "item_name": {"type": "string"},
                        "department": {"type": "string"},
                        "current_status": {"type": "string"},
                        "suggested_status": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                },
            },
            "risks": {"type": "array", "maxItems": 1, "items": {"type": "string"}},
            "upcoming": {"type": "array", "maxItems": 3, "items": {
                "type": "object", "required": ["text", "when"],
                "properties": {
                    "text": {"type": "string", "description": "Max 8 words."},
                    "when": {"type": "string", "description": "Day/time or date."},
                    "source": {"type": "string"},
                    "monday_item_id": {"type": ["string", "null"]},
                }}},
            "next_up": {"type": ["string", "null"], "description": "Single nearest upcoming, one line, null if none."},
            "other_entities_mentioned": {
                "type": "array",
                "maxItems": 4,
                "description": "Candidates the topical filter excluded -- content from this client's own meetings/chats that was actually about a DIFFERENT named business/person, mentioned only in passing. Never merged into highlights/stalled_items.",
                "items": {
                    "type": "object",
                    "required": ["entity", "text"],
                    "properties": {
                        "entity": {"type": "string", "description": "The other business/person's name."},
                        "text": {"type": "string", "description": "Short blurb of what was said about them, max ~14 words."},
                    },
                },
            },
        },
    },
}

EMIT_WRAPUP_TOOL = {
    "name": "emit_wrapup",
    "description": "Emit the cross-client wrap-up for the weekly standup.",
    "input_schema": {
        "type": "object",
        "required": ["executive_summary", "departments_overview", "comms_flags",
                     "blockers", "this_week_priorities"],
        "properties": {
            "executive_summary": {
                "type": "string",
                "description": "3–5 sentences. The most important things across all clients.",
            },
            "departments_overview": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["department", "summary"],
                    "properties": {
                        "department": {"type": "string"},
                        "summary": {"type": "string", "description": "One sentence on load + anything stuck."},
                    },
                },
            },
            "comms_flags": {
                "type": "array", "maxItems": 6, "items": {"type": "string"},
                "description": "Items needing the founder's attention. Prefix with client name.",
            },
            "blockers": {
                "type": "array", "maxItems": 6, "items": {"type": "string"},
                "description": "Clear blockers. Prefix with client name.",
            },
            "this_week_priorities": {
                "type": "array",
                "maxItems": 7,
                "items": {
                    "type": "object",
                    "required": ["text"],
                    "properties": {
                        "text": {"type": "string", "description": "Prefixed with client name, e.g. 'Billy Doe Meats: Draft holiday page'."},
                        "client": {"type": "string"},
                        "action": {
                            "type": ["object", "null"],
                            "description": "Optional draft for founder review only, never sent automatically.",
                            "required": ["type", "body"],
                            "properties": {
                                "type": {"type": "string", "enum": ["email", "copy"]},
                                "to": {"type": ["string", "null"]},
                                "subject": {"type": ["string", "null"]},
                                "body": {"type": "string"},
                            },
                        },
                    },
                },
            },
        },
    },
}

EMIT_COMPLETIONS_TOOL = {
    "name": "emit_completions",
    "description": "Emit genuine, unhedged completions of specific named work found in meetings/WhatsApp this run.",
    "input_schema": {
        "type": "object",
        "required": ["completions"],
        "properties": {
            "completions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["client", "text", "source"],
                    "properties": {
                        "client": {"type": "string"},
                        "text": {"type": "string", "description": "Short plain-language summary of what was actually done, max ~14 words -- not the raw task/item name restated."},
                        "who": {"type": ["string", "null"], "description": "Person who said/did it, if named."},
                        "source": {"type": "string", "enum": ["MTG", "WA"]},
                        "sourceDate": {"type": ["string", "null"], "description": "YYYY-MM-DD if known, else null."},
                        "monday_item_id": {"type": ["string", "null"], "description": "ONLY if confidently matched to an id shown in the board snapshot. Null if any doubt -- never guess."},
                    },
                },
            },
        },
    },
}

EMIT_MONDAY_DONE_TOOL = {
    "name": "emit_monday_done",
    "description": "Emit one summarized completion line per candidate Monday item that just turned Done.",
    "input_schema": {
        "type": "object",
        "required": ["completions"],
        "properties": {
            "completions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["client", "text", "item_id"],
                    "properties": {
                        "client": {"type": "string"},
                        "text": {"type": "string", "description": "Plain-language summary of what was completed, max ~16 words, covering the parent item and any listed subitems together."},
                        "item_id": {"type": "string", "description": "Verbatim from the candidate's item_id. Never invent or alter."},
                    },
                },
            },
        },
    },
}

EMIT_PROSPECT_LIKELIHOOD_TOOL = {
    "name": "emit_prospect_likelihood",
    "description": "Emit a subjective likelihood-to-close estimate for each prospect there's enough real signal to judge. Skip prospects with too little text to read tone from.",
    "input_schema": {
        "type": "object",
        "required": ["assessments"],
        "properties": {
            "assessments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["name", "percent", "reason"],
                    "properties": {
                        "name": {"type": "string", "description": "Verbatim from the prospect name given. Never invent or alter."},
                        "percent": {"type": "integer", "minimum": 0, "maximum": 100},
                        "reason": {"type": "string", "description": "One short sentence, max ~20 words, citing the specific tone/interest signal behind the number."},
                    },
                },
            },
        },
    },
}

EMIT_MEETING_PROSPECT_SYNTHESIS_TOOL = {
    "name": "emit_meeting_prospect_synthesis",
    "description": "For each unmatched meeting, identify the real prospect (clean short name) and synthesize what that one meeting was about, plain prose, no markdown.",
    "input_schema": {
        "type": "object",
        "required": ["meetings"],
        "properties": {
            "meetings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["index", "entity_name", "summary"],
                    "properties": {
                        "index": {"type": "integer", "description": "Verbatim from the meeting's index. Never invent or alter."},
                        "entity_name": {"type": "string", "description": "Short, clean business/person name -- never the raw meeting title. Same exact string across meetings that are clearly the same prospect."},
                        "summary": {"type": "string", "description": "2-4 plain sentences, no markdown, synthesizing this one meeting."},
                        "action_items": {"type": "array", "items": {"type": "string"}, "description": "Max 5, deduplicated, plain sentences."},
                    },
                },
            },
        },
    },
}

EMIT_PROSPECT_GROUP_SYNTHESIS_TOOL = {
    "name": "emit_prospect_group_synthesis",
    "description": "For each prospect with more than one real meeting, combine their per-meeting summaries into one cohesive synthesis, plain prose, no markdown.",
    "input_schema": {
        "type": "object",
        "required": ["prospects"],
        "properties": {
            "prospects": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["name", "summary"],
                    "properties": {
                        "name": {"type": "string", "description": "Verbatim from the prospect name given. Never invent or alter."},
                        "summary": {"type": "string", "description": "2-5 plain sentences covering the whole relationship arc, no markdown."},
                        "action_items": {"type": "array", "items": {"type": "string"}, "description": "Max 6, deduplicated across all their meetings, plain sentences."},
                    },
                },
            },
        },
    },
}


# ── Claude calls ──────────────────────────────────────────────────────────────

def _anthropic_client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


def _call_tool(client: anthropic.Anthropic, prompt: str, tool: dict, label: str,
               max_tokens: int = 3000) -> dict:
    response = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        temperature=0,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": prompt}],
    )
    print(
        f"  [{label}] stop={response.stop_reason} "
        f"tokens={response.usage.input_tokens}in/{response.usage.output_tokens}out"
    )
    if response.stop_reason == "max_tokens":
        raise ValueError(f"{label}: output truncated at max_tokens")
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool["name"]:
            return block.input
    raise ValueError(f"{label}: model did not call {tool['name']}")


# ── assembly ──────────────────────────────────────────────────────────────────

def _attach_urls(rows: list, url_lookup: dict[str, str]) -> list:
    """Stamp real monday_urls onto rows via monday_item_id. Never invents."""
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        iid = row.get("monday_item_id")
        row["monday_url"] = url_lookup.get(str(iid)) if iid else None
        out.append(row)
    return out


def assemble_client_entry(client: str, result: dict, url_lookup: dict[str, str]) -> dict:
    """Convert the flat per-client model output into the nested shape the
    renderer and webpage already consume (work_by_department)."""
    highlights = _attach_urls(result.get("highlights"), url_lookup)
    stalled = _attach_urls(result.get("stalled_items"), url_lookup)

    dept_map: dict[str, dict] = {}
    for row in highlights:
        dept = row.get("department") or "General"
        dept_map.setdefault(dept, {"department": dept, "highlights": [], "stalled_items": []})
        dept_map[dept]["highlights"].append(row)
    for row in stalled:
        dept = row.get("department") or "General"
        dept_map.setdefault(dept, {"department": dept, "highlights": [], "stalled_items": []})
        dept_map[dept]["stalled_items"].append(row)

    return {
        "client": client,
        "headline": result.get("headline", ""),
        "health": result.get("health", "needs_attention"),
        "work_by_department": list(dept_map.values()),
        "status_change_suggestions": result.get("status_change_suggestions", []) or [],
        "risks": result.get("risks", []) or [],
        "upcoming": result.get("upcoming", []) or [],
        "next_up": result.get("next_up"),
        # Transient -- main() pulls this into potential_clients and pops it
        # before the entry is written to standup.json. Content the topical
        # filter excluded from this client's own highlights/stalled_items
        # because it was actually about a different named business/person
        # mentioned in passing within an otherwise correctly-matched meeting
        # or chat.
        "_off_topic_mentions": result.get("other_entities_mentioned", []) or [],
    }


def compute_client_stats(departments: dict, meetings: list, chats: list) -> dict:
    STATUS_MAP = {
        "start": "todo",
        "in progress": "working", "working on it": "working", "ongoing": "working",
        "for review": "review",
        "stuck": "stuck", "waiting": "stuck",
        "done": "done",
    }
    tasks = todo = working = review = stuck = done = 0
    monday_msgs = 0
    for dept_items in departments.values():
        for item in dept_items:
            tasks += 1
            cols = item.get("columns") or {}
            status_val = next((v for k, v in cols.items() if "status" in k.lower()), "")
            bucket = STATUS_MAP.get(status_val.lower().strip(), "working")
            if bucket == "todo": todo += 1
            elif bucket == "working": working += 1
            elif bucket == "review": review += 1
            elif bucket == "stuck": stuck += 1
            elif bucket == "done": done += 1
            monday_msgs += len(item.get("recent_updates") or [])
    wa_msgs = sum(
        len(msgs) for _, msgs in chats if isinstance(msgs, list)
    )
    return {
        "tasks": tasks, "todo": todo, "working": working,
        "review": review, "stuck": stuck, "done": done,
        "monday_msgs": monday_msgs, "meetings": len(meetings), "wa_msgs": wa_msgs,
    }


def _summary_lines(text, cap: int) -> list[str]:
    """Fireflies' summary.overview/action_items come back as either a plain
    string (markdown-ish, one bullet per line) or already a list -- normalizes
    either into a clean list of short lines, stripped of bullet/bold markup.
    Shared by build_meetings_digest and build_potential_clients so a prospect's
    detail view reads the same real Fireflies content a client's card does,
    not a separately-truncated one-off."""
    if not text:
        return []
    if isinstance(text, list):
        items = [str(x).strip() for x in text]
    else:
        items = [
            ln.strip().lstrip("-*• ").strip()
            for ln in str(text).replace("\r", "").split("\n")
        ]
    items = [i.replace("**", "").strip() for i in items]
    items = [i for i in items if i and not i.endswith(":")][:cap]
    return items


def build_meetings_digest(fireflies_data, clients_config: dict, active_clients: set[str]) -> list:
    """Deterministic — built in Python from Fireflies data. No model call."""
    if not isinstance(fireflies_data, list):
        return []

    digest = []
    seen_titles = set()
    for mt in fireflies_data:
        title = mt.get("title") or "Untitled"
        date = mt.get("date") or ""
        key = (title, date)
        if key in seen_titles:
            continue  # Fireflies often records duplicates of the same call
        seen_titles.add(key)
        summary = mt.get("summary") or {}
        matched = match_meeting_clients(mt, clients_config, active_clients)
        digest.append({
            "title": title,
            "date": date,
            "client": ", ".join(m for m in matched if m != "General comms") or "General comms",
            "key_points": _summary_lines(summary.get("overview"), 5),
            "action_items": _summary_lines(summary.get("action_items"), 6),
        })
    return digest


def build_wrapup_prompt(client_entries: list, board_errors: dict,
                        general_meetings: list, today: str) -> str:
    parts = [
        f"# Cross-client wrap-up — week ending {today}\n\n"
        "You are writing the wrap-up sections of Flow Co.'s Monday standup. Below are the "
        "already-written per-client reviews. Synthesize across them.\n\n"
        "INSTRUCTIONS:\n"
        "1. executive_summary: 2–3 sentences max, plain and calm. A read, not a siren.\n"
        "2. departments_overview: one entry each for CRM, Ads, Video, Web + SEO — one sentence "
        "on load and anything stuck, drawn from the client reviews below.\n"
        "3. comms_flags / blockers: only real, grounded items from the reviews. Prefix with "
        "client name. Empty arrays are fine.\n"
        "4. this_week_priorities: max 4, short plain lines prefixed with client name. "
        "Set action to null — no drafts, this is a pulse, not a task machine.\n"
        "5. Never invent facts not present below.\n"
    ]
    if board_errors:
        parts.append("\n## BOARD FETCH ERRORS (mention in blockers)\n")
        for dept, err in board_errors.items():
            parts.append(f"- {dept}: {err[:200]}")

    parts.append("\n## PER-CLIENT REVIEWS\n")
    for e in client_entries:
        parts.append(f"### {e['client']} — {e['health']}")
        parts.append(f"Headline: {e['headline']}")
        for dept in e.get("work_by_department", []):
            for row in dept.get("highlights", []):
                parts.append(f"  + [{dept['department']}] {row.get('text', '')}")
            for row in dept.get("stalled_items", []):
                d = row.get("days_stalled")
                parts.append(f"  ! [{dept['department']}] {row.get('text', '')}"
                             + (f" ({d}d stalled)" if d else ""))
        for r in e.get("risks", []):
            parts.append(f"  RISK: {r}")
        parts.append("")

    if general_meetings:
        parts.append("\n## GENERAL COMMS (meetings not matched to a client)\n")
        for mt in general_meetings:
            parts.append(f"- {mt.get('title', '')} ({mt.get('date', '')}): "
                         + "; ".join(mt.get("key_points", [])[:3]))

    return "\n".join(parts)


# ── row-id injection ──────────────────────────────────────────────────────────

def _row_id(client: str, text: str) -> str:
    return hashlib.sha1(f"{client}:{text}".encode()).hexdigest()[:8]


def inject_ids(standup: dict) -> dict:
    """Inject stable id fields into every row object."""
    for entry in standup.get("by_client", []):
        client = entry.get("client", "")
        for dept in entry.get("work_by_department", []):
            for item in dept.get("highlights", []):
                if isinstance(item, dict):
                    item["id"] = _row_id(client, item.get("text", ""))
            for item in dept.get("stalled_items", []):
                if isinstance(item, dict):
                    item["id"] = _row_id(client, item.get("text", ""))
    for item in standup.get("this_week_priorities", []):
        if isinstance(item, dict):
            item["id"] = _row_id(item.get("client", "priority"), item.get("text", ""))
    return standup


# ── completion tracking (accumulator + alerts) ────────────────────────────────
#
# standups/completed-accumulator.json persists across runs: the current ISO
# week's found completions (items), plus a rolling window of the most
# recently finished PRIOR weeks (history) so finished work stays visible for
# HISTORY_WINDOW_WEEKS weeks after the week it was completed in, instead of
# vanishing (or getting wholesale overwritten) the instant the week rolls
# over. Whatever ages out of that live window is never discarded -- it's
# appended to a permanent per-week file under history/completed-archive/, so
# "did we ever do X for this client" can be checked later instead of guessed
# at. alerts/auto-completed.json is append-only -- every time this pipeline
# fires its one allowed Monday write (flipping a comms-confirmed completion to
# Done), a record gets appended so multiple firings across a day/week all show
# until Naz dismisses them in the UI.

ACCUMULATOR_PATH = Path("standups") / "completed-accumulator.json"
ALERTS_PATH = Path("alerts") / "auto-completed.json"
COMPLETED_ARCHIVE_DIR = Path("history") / "completed-archive"
HISTORY_WINDOW_WEEKS = 11  # + the current week = 12 rolling weeks shown live


def _iso_week(d: datetime) -> str:
    iso = d.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def _completion_id(client: str, text: str) -> str:
    """Internal bookkeeping label only (logs/debugging) -- NOT the dedup key.
    See _is_duplicate_completion for how duplicates are actually decided."""
    return hashlib.sha1(f"{client}:{text}".encode()).hexdigest()[:12]


def load_accumulator(path: Path = ACCUMULATOR_PATH) -> dict:
    default = {"isoWeek": None, "items": [], "history": [], "monday_ids_seen": []}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data.setdefault("monday_ids_seen", [])  # older accumulator files predate this field
            if "history" not in data:
                # Migrate the old single-slot priorWeek shape into the new
                # rolling history list instead of losing it on the first run
                # after this change.
                prior = data.pop("priorWeek", None) or {}
                data["history"] = [prior] if prior.get("isoWeek") else []
            return data
        except Exception:
            pass
    return default


def _archive_completed_week(week: dict, archive_dir: Path = COMPLETED_ARCHIVE_DIR) -> None:
    """Appends a week's items to its permanent per-ISO-week archive file.
    Append (not overwrite) because a week could in principle be archived more
    than once across accumulator lifetimes; the archive is meant to never
    lose anything that once aged out of the live window."""
    iso_week = week.get("isoWeek")
    items = week.get("items", [])
    if not iso_week or not items:
        return
    archive_dir.mkdir(parents=True, exist_ok=True)
    path = archive_dir / f"{iso_week}.json"
    existing = []
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                existing = []
        except Exception:
            existing = []
    existing.extend(items)
    path.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")


def apply_weekly_reset(acc: dict, current_iso_week: str) -> dict:
    """If the accumulator's isoWeek differs from the current one, this is the
    first run of a new week: the just-finished week's items are pushed onto
    the front of the rolling `history` list (most recent first) and the new
    week's items start empty. `history` is capped at HISTORY_WINDOW_WEEKS
    entries -- together with the current week that's a HISTORY_WINDOW_WEEKS+1
    rolling window shown live; anything older gets archived (never dropped)
    via _archive_completed_week. monday_ids_seen is untouched here -- it
    tracks which real Monday ids have EVER been turned into a completion
    line, so a status that was already summarized doesn't get re-summarized
    just because the display week rolled over."""
    if acc.get("isoWeek") != current_iso_week:
        history = acc.setdefault("history", [])
        if acc.get("isoWeek"):
            history.insert(0, {"isoWeek": acc.get("isoWeek"), "items": acc.get("items", [])})
        while len(history) > HISTORY_WINDOW_WEEKS:
            _archive_completed_week(history.pop())
        acc["isoWeek"] = current_iso_week
        acc["items"] = []
    return acc


def load_alerts(path: Path = ALERTS_PATH) -> list:
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


# Some genuine same-work completion pairs get reworded heavily enough (by
# the summarizer, or by whoever typed the WhatsApp message) that they land
# below SIMILARITY_DUP_THRESHOLD on plain text similarity alone -- e.g.
# "First 3 video cuts" vs "Delivered first three video cuts for review"
# scores 0.557; "Website — First Draft" vs "Completed first draft of
# website." scores 0.577. Both real dupes, both below the shared 0.6
# threshold used everywhere else (exclusions, prospect bucketing, alias-gap
# detection) -- lowering that shared threshold to catch these risks new
# false positives in those other places. Corroboration lets completions
# specifically use a lower floor instead: same client AND same source AND
# same sourceDate AND same who is strong enough independent evidence of the
# same event that a looser text match becomes safe to trust. Same-client
# pairs that are genuinely unrelated score well below this floor in
# practice (e.g. "Website — First Draft" vs "First 3 video cuts" = 0.421).
COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD = 0.45


def _is_duplicate_completion(candidate: dict, existing: list[dict]) -> bool:
    """A Monday-id match is a fast-path shortcut, not a gate: it never skips
    the text-similarity check for same-client pairs, since two different (or
    absent) Monday ids can still describe the exact same finished work in
    different wording (e.g. a Monday item and a WhatsApp mention of it)."""
    mid = candidate.get("monday_item_id")
    client = candidate.get("client")
    text = candidate.get("text", "")
    source = candidate.get("source")
    source_date = candidate.get("sourceDate")
    who = candidate.get("who")
    for it in existing:
        if mid and it.get("monday_item_id") and str(it["monday_item_id"]) == str(mid):
            return True
        if client and it.get("client") == client:
            score = _text_similarity(text, it.get("text", ""))
            if score >= SIMILARITY_DUP_THRESHOLD:
                return True
            corroborated = (
                source and it.get("source") == source
                and source_date and it.get("sourceDate") == source_date
                and who == it.get("who")
            )
            if corroborated and score >= COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD:
                return True
    return False


def collect_monday_done_candidates(monday_data: list, seen_ids: set) -> list[dict]:
    """Deterministic grouping only (no text yet) -- for each Monday item,
    checks whether the item itself and/or any of its subitems just turned
    Done and haven't been summarized before (tracked by real Monday id in
    seen_ids, never by eventual display text). When a parent and its
    subitems are newly Done in the same run, they collapse into ONE
    candidate so summarize_monday_done can turn them into a single
    summarized line instead of one row per item/subitem."""
    candidates = []
    for board in monday_data:
        if "error" in board:
            continue
        for item in board.get("items", []):
            client = item.get("client", "Unmapped")
            item_id = str(item.get("item_id") or "")
            item_done = (
                (item.get("status") or "").strip().lower() == "done"
                and item_id and item_id not in seen_ids
            )
            new_subs = [
                sub for sub in (item.get("subitems", []) or [])
                if (sub.get("status") or "").strip().lower() == "done"
                and str(sub.get("id") or "") not in seen_ids
            ]
            if not item_done and not new_subs:
                continue
            new_ids = ([item_id] if item_done else []) + [str(s["id"]) for s in new_subs if s.get("id")]
            candidates.append({
                "client": client,
                "item_name": item.get("name", ""),
                "item_id": item_id,
                "item_done": item_done,
                "subitem_names": [s.get("name", "") for s in new_subs],
                "recent_updates": item.get("recent_updates") or [],
                "sourceDate": item.get("last_updated") or item.get("created_at"),
                "new_ids": new_ids,
            })
    return candidates


def _strip_html(raw: str) -> str:
    """Monday update bodies are stored as HTML (mentions, formatting tags).
    Plain text only, for when this gets shown directly rather than read by
    the model (which can parse the markup itself fine)."""
    text = raw or ""
    # @mentions render as an anchor wrapping just the mentioned name -- never
    # part of the actual message, so the whole anchor goes, not just its
    # tags (otherwise a trailing "@Ads Team" ends up looking like part of
    # the sentence once tags are stripped).
    text = re.sub(r"<a\b[^>]*data-mention-id[^>]*>.*?</a>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    # Monday's rich-text editor sprinkles in zero-width/BOM characters that
    # are invisible but real -- seen in actual archived update bodies.
    text = re.sub(r"[​‌‍﻿]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    # A bare greeting carries no information -- strip it so a one-line
    # snippet reads as content, not a salutation ("Salam," is this team's
    # own convention, seen throughout the real update text).
    text = re.sub(r"^(salam|salaam|hi|hey|hello)[,:]?\s+(team[,:]?\s+)?", "", text, flags=re.I)
    return text.strip()


def _looks_like_bare_title(text: str, item_name: str, subitem_names: list) -> bool:
    """True if the model's `text` is empty, or is just the item/subitem
    name(s) restated -- exactly the "site just listing Monday titles
    verbatim" outcome build_monday_done_prompt explicitly asks it to avoid.
    Comparison ignores case/punctuation so 'LSA.' still matches 'LSA'."""
    norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
    nt = norm(text)
    if not nt:
        return True
    return any(nt == norm(n) for n in [item_name, *(subitem_names or [])] if n)


# Real Monday comments skew heavily toward task assignment ("please do X",
# "can you fix Y") rather than completion reports ("done", "shipped") --
# unsurprising, since a status flip to Done is usually itself the
# completion signal, and comments exist for everything else. Surfacing a
# request verbatim under a "Completed" heading reads as a claim that the
# request was fulfilled, which isn't something the comment itself confirms
# -- so these get treated the same as having no usable update at all,
# rather than accepted as a description of what was done.
_REQUEST_PHRASE_RE = re.compile(
    r"^(please|pls|kindly|can you|could you|would you|make sure|need you to)\b", re.I
)


def _looks_like_a_request(text: str) -> bool:
    stripped = text.strip()
    if stripped.endswith("?"):
        return True
    if _REQUEST_PHRASE_RE.match(stripped):
        return True
    # A collapsed <ul><li> checklist (2+ dash-led fragments) reads as a
    # garbled instruction dump, not one coherent sentence describing work.
    return len(re.findall(r"(?:^|\s)-\s", text)) >= 2


def _fallback_completion_text(item_name: str, subitem_names: list, recent_updates: list) -> tuple[str, bool]:
    """Used when the model's own summary is missing or a bare title echo.
    Prefers a real snippet pulled straight from the item's own most recent
    update/comment that actually reads like a description of work (genuine
    source text, not invented -- so NOT flagged as generated) over a
    synthesized line built only from the item/subitem names (which IS
    flagged, since there's no real description behind it). Returns
    (text, generated)."""
    dated_bodies = [
        (u.get("created_at") or "", _strip_html(u.get("body") or ""))
        for u in (recent_updates or [])
    ]
    dated_bodies = [(d, b) for d, b in dated_bodies if len(b) >= 15 and not _looks_like_a_request(b)]
    if dated_bodies:
        dated_bodies.sort(key=lambda db: db[0])
        snippet = dated_bodies[-1][1]
        max_len = 140
        if len(snippet) > max_len:
            cut = snippet.rfind(" ", 0, max_len)
            snippet = (snippet[:cut] if cut > 40 else snippet[:max_len]).rstrip() + "…"
        return snippet, False

    bits = [b for b in [item_name, *(subitem_names or [])] if b]
    if len(bits) > 1:
        return f"Completed: {', '.join(bits)}", True
    return f"{item_name} marked complete", True


def summarize_monday_done(ai: "anthropic.Anthropic", candidates: list[dict], today: str) -> list[dict]:
    """One batched Claude call turns every candidate's raw item/subitem names
    into a real plain-language summary line. If the call fails outright, OR
    it comes back with just the bare title restated for a given candidate
    (see _looks_like_bare_title), falls back to real text pulled from that
    item's own recent updates when there is any, or a clearly-flagged
    generated one-liner when there truly is nothing richer -- so a thin
    model output never silently ships as a bare title, and a genuinely
    invented line is always distinguishable from real source text."""
    if not candidates:
        return []

    by_id: dict[str, dict] = {}
    try:
        prompt = pulse_story.build_monday_done_prompt(candidates, today)
        result = _call_tool(ai, prompt, EMIT_MONDAY_DONE_TOOL, label="monday-completions", max_tokens=2000)
        for row in (result.get("completions", []) or []):
            iid = row.get("item_id")
            if iid:
                by_id[str(iid)] = row
    except Exception as exc:
        print(f"  ⚠️  Monday completion summarization failed ({exc}) -- using a plain fallback summary")

    out = []
    for c in candidates:
        row = by_id.get(str(c["item_id"]))
        text = (row.get("text") or "").strip() if row else ""
        generated = False
        if _looks_like_bare_title(text, c["item_name"], c.get("subitem_names")):
            text, generated = _fallback_completion_text(
                c["item_name"], c.get("subitem_names"), c.get("recent_updates")
            )
            print(f"  ⚠️  Monday completion for [{c['client']}] {c['item_name']!r} had no real summary -- "
                  f"{'used its own recent update text' if not generated else 'generated a placeholder line'}")
        out.append({
            "client": c["client"],
            "text": text,
            "who": None,
            "source": "MON",
            "sourceDate": c.get("sourceDate"),
            "monday_item_id": c["item_id"],
            "new_ids": c.get("new_ids", []),
            "generated": generated,
        })
    return out


def build_monday_meta(monday_data: list) -> dict[str, dict]:
    """monday_item_id (item or subitem) -> {status, status_column_id, board_id,
    board_name} -- everything needed to decide whether a comms-confirmed
    completion needs the one allowed Monday write, and to actually make it."""
    meta: dict[str, dict] = {}
    for board in monday_data:
        if "error" in board:
            continue
        for item in board.get("items", []):
            if item.get("item_id"):
                meta[str(item["item_id"])] = {
                    "status": item.get("status"),
                    "status_column_id": item.get("status_column_id"),
                    "board_id": item.get("board_id"),
                    "board_name": board["board_name"],
                }
            for sub in item.get("subitems", []) or []:
                if sub.get("id"):
                    meta[str(sub["id"])] = {
                        "status": sub.get("status"),
                        "status_column_id": sub.get("status_column_id"),
                        "board_id": sub.get("board_id"),
                        "board_name": board["board_name"],
                    }
    return meta


def _client_completions(items: list, client: str, url_lookup: dict[str, str]) -> list[dict]:
    """Project accumulator items down to the {text, who, source, date,
    generated, monday_url} shape the site renders, filtered to one client.
    `date` is sourceDate verbatim -- for MON items that's the item's most
    recent comment/update date (falling back to created_at), for WA/MTG
    items it's the real message/meeting date the completion-scan extracted.
    Neither is "the day this pipeline happened to run" -- both already
    point at the real-world event, which is what the site should show.
    `generated` (MON-only) flags a synthesized one-liner with no real
    source text behind it, so it's easy to spot-check against the others,
    which are all genuine text (an AI paraphrase or a real update/message
    snippet) -- see summarize_monday_done / _fallback_completion_text."""
    out = []
    for it in items:
        if it.get("client") != client:
            continue
        mid = it.get("monday_item_id")
        out.append({
            "text": it.get("text", ""),
            "who": it.get("who"),
            "source": it.get("source", "MON"),
            "date": it.get("sourceDate"),
            "generated": bool(it.get("generated")),
            "monday_url": url_lookup.get(str(mid)) if mid else None,
        })
    return out


# ── site copy ────────────────────────────────────────────────────────────────

def copy_to_site(src: Path) -> None:
    dst = Path("site") / "latest.json"
    dst.parent.mkdir(exist_ok=True)
    shutil.copy2(src, dst)
    print(f"  Copied → {dst}")


# ── markdown renderer (unchanged output shape) ────────────────────────────────

def _md_row(item) -> str:
    if isinstance(item, str):
        return f"- {item}"
    text = item.get("text", "")
    url = item.get("monday_url")
    days = item.get("days_stalled")
    suffix = f" *({days}d stalled)*" if days else ""
    return f"- [{text}]({url}){suffix}" if url else f"- {text}{suffix}"


def _md_priority(p) -> str:
    if isinstance(p, str):
        return f"- {p}"
    text = p.get("text", "")
    action = p.get("action") or {}
    if action.get("type") == "email":
        return f"- {text}  *(email draft: {action.get('subject', '')})*"
    if action.get("type") == "copy":
        return f"- {text}  *(copy draft)*"
    return f"- {text}"


def render_markdown(standup: dict) -> str:
    week_of = standup.get("week_of", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = []

    lines += [f"# Flow Pulse - {week_of}", ""]
    lines += ["## Executive Summary", "", standup.get("executive_summary", ""), ""]

    dept_overview = standup.get("departments_overview", [])
    if dept_overview:
        lines += ["## Departments Overview", ""]
        for d in dept_overview:
            lines.append(f"- **{d.get('department', '')}**: {d.get('summary', '')}")
        lines.append("")

    lines += ["## By Client", ""]
    for entry in (standup.get("by_client") or []):
        client = entry.get("client", "Unknown")
        health = entry.get("health", "on_track")
        health_label = {
            "on_track": "On Track",
            "needs_attention": "Needs Attention",
            "at_risk": "At Risk",
        }.get(health, health)

        lines.append(f"### {client}  `{health_label}`")
        lines.append("")

        if entry.get("headline"):
            lines.append(f"*{entry['headline']}*")
            lines.append("")

        for dept_entry in (entry.get("work_by_department") or []):
            lines.append(f"#### {dept_entry.get('department', '')}")
            lines.append("")
            highlights = dept_entry.get("highlights") or []
            if highlights:
                lines.append("**Highlights:**")
                lines += [_md_row(h) for h in highlights]
                lines.append("")
            stalled = dept_entry.get("stalled_items") or []
            if stalled:
                lines.append("**Stalled:**")
                lines += [_md_row(s) for s in stalled]
                lines.append("")

        if entry.get("upcoming"):
            lines.append("**Upcoming:**")
            for u in entry.get("upcoming") or []:
                lines.append(f"- {u.get('when', '')} - {u.get('text', '')}")
            lines.append("")

        if entry.get("status_change_suggestions"):
            lines.append("**Status Change Suggestions** *(suggestions only)*:")
        for sug in (entry.get("status_change_suggestions") or []):
            dept_tag = f" [{sug.get('department', '')}]" if sug.get("department") else ""
            lines.append(
                f"- **{sug.get('item_name', '')}**{dept_tag}: "
                f"{sug.get('current_status', '')} → {sug.get('suggested_status', '')}  "
                f"*(reason: {sug.get('reason', '')})*"
            )
        if entry.get("status_change_suggestions"):
            lines.append("")

        if entry.get("risks"):
            lines.append("**Risks:**")
        for r in (entry.get("risks") or []):
            lines.append(f"- {r}")
        if entry.get("risks"):
            lines.append("")

    potential_clients = standup.get("potential_clients") or []
    if potential_clients:
        lines += ["## Potential Clients", "",
                   "*Doesn't clearly match a signed client on the active roster -- not "
                   "merged into any existing client's card. Confirm before treating as a "
                   "real onboarding.*", ""]
        for p in potential_clients:
            sources = ", ".join(p.get("sources") or [])
            lines.append(f"### {p.get('name', 'Unknown')}" + (f"  `{sources}`" if sources else ""))
            if p.get("possible_existing_client"):
                lines.append(f"**Possible existing client, alias mismatch:** may actually be "
                             f"**{p['possible_existing_client']}** -- add a config.json alias if so, "
                             "rather than treating this as a new business.")
            for it in (p.get("items") or [])[:5]:
                when = f" ({it['when']})" if it.get("when") else ""
                lines.append(f"- {it.get('blurb', '')}{when}")
            lines.append("")

    lines += ["## Meetings Digest", ""]
    for mt in (standup.get("meetings_digest") or []):
        client_tag = f" — *{mt.get('client')}*" if mt.get("client") else ""
        lines.append(f"### {mt.get('title', 'Untitled')} — {mt.get('date', '')}{client_tag}")
        lines.append("")
        if mt.get("key_points"):
            lines.append("**Key Points:**")
        for kp in (mt.get("key_points") or []):
            lines.append(f"- {kp}")
        if mt.get("key_points"):
            lines.append("")
        if mt.get("action_items"):
            lines.append("**Action Items:**")
        for ai in (mt.get("action_items") or []):
            lines.append(f"- {ai}")
        if mt.get("action_items"):
            lines.append("")
    if not (standup.get("meetings_digest") or []):
        lines += ["No meetings this week.", ""]

    lines += ["## Communications Flags", ""]
    comms = standup.get("comms_flags") or []
    lines += ([f"- {c}" for c in comms] if comms else ["Nothing flagged."]) + [""]

    lines += ["## Blockers", ""]
    blockers = standup.get("blockers") or []
    lines += ([f"- {b}" for b in blockers] if blockers else ["No blockers identified."]) + [""]

    lines += ["## This Week's Priorities", ""]
    lines += [_md_priority(p) for p in (standup.get("this_week_priorities") or [])]
    lines.append("")

    lines += ["---", f"*Generated by flow-standup on {generated_at}*"]
    return "\n".join(lines)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    config = load_config()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    days_back = config.get("days_back", 7)
    clients_config = config.get("clients", {})

    print("=" * 60)
    print(f"Flow Standup Generator — {today}")
    print("=" * 60)

    print(f"\n[1/4] Fetching Monday.com boards...")
    monday_data = []
    try:
        monday_data, _ = fetch_all_boards(config)
        try:
            archive_monday.archive_updates(monday_data, clients_config)
        except Exception as _arc_exc:
            print(f"  ⚠️  Archive step failed (non-blocking): {_arc_exc}")
        monday_data, pruned = filter_live_items(monday_data, config)
        if pruned:
            print(f"  Pulse window: pruned {pruned} dormant item(s) "
                  f"older than {config.get('pulse_window_days', 45)}d")
    except Exception as exc:
        print(f"  ⚠️  Monday.com fetch failed: {exc}")
        monday_data = [{"board_name": "ALL BOARDS", "error": str(exc), "items": []}]

    print(f"\n[2/4] Fetching Fireflies transcripts...")
    fireflies_data: list | dict = []
    try:
        fireflies_data = fetch_transcripts(days_back)
        print(f"  ✓ {len(fireflies_data)} meetings")
    except Exception as exc:
        print(f"  ⚠️  Fireflies fetch failed: {exc}")
        fireflies_data = {"error": str(exc)}

    print(f"\n[3/4] Reading WhatsApp exports...")
    whatsapp_data: dict = {}
    try:
        whatsapp_data = fetch_whatsapp(days_back, config=config)
        if whatsapp_data:
            total_msgs = sum(len(v) for v in whatsapp_data.values() if isinstance(v, list))
            print(f"  ✓ {len(whatsapp_data)} chats, {total_msgs} messages")
        else:
            print("  — No exports found, skipping")
    except Exception as exc:
        print(f"  ⚠️  WhatsApp read failed: {exc}")

    print(f"\n[4/4] Loading playbooks...")
    print("  Checking Google Drive...")
    drive_playbooks = load_playbooks_drive(config, clients_config)
    local_playbooks = load_playbooks(clients_config)
    playbooks_by_client = {**local_playbooks, **drive_playbooks}
    if playbooks_by_client:
        print(f"  ✓ {len(playbooks_by_client)} playbook(s): {', '.join(playbooks_by_client.keys())}")
    else:
        print("  — No playbooks found (Drive empty or unavailable, no local files)")

    # ── organise inputs per client ────────────────────────────────────────────
    grouped, board_errors = group_items_by_client(monday_data, clients_config)
    url_lookup = build_url_lookup(monday_data)

    # Clients with real activity on the actual Monday boards this pulse window --
    # the only clients a content-only fuzzy match (not a title/chat-name match)
    # is allowed to land on. See match_meeting_clients / _match_comms_to_client.
    active_clients_set = {c for c in grouped if c != "Unmapped"}

    meetings_by_client: dict[str, list] = {}
    if isinstance(fireflies_data, list):
        for mt in fireflies_data:
            matched = match_meeting_clients(mt, clients_config, active_clients_set)
            for c in (matched or ["General comms"]):
                meetings_by_client.setdefault(c, []).append(mt)
            print(f"  meeting '{(mt.get('title') or 'Untitled')[:45]}' → {', '.join(matched) if matched else 'General comms'}")

    chats_by_client: dict[str, list[tuple]] = {}
    for chat_name, msgs in (whatsapp_data or {}).items():
        c = _match_comms_to_client(chat_name, clients_config, active_clients_set)
        n = len(msgs) if isinstance(msgs, list) else 0
        print(f"  chat '{chat_name}' ({n} msgs) → {c}")
        chats_by_client.setdefault(c, []).append((chat_name, msgs))

    # Clients with any signal this week (Monday items OR meetings OR chats),
    # in config order. Unmapped Monday groups and unmatched meetings/chats no
    # longer get force-merged into a signed client's card or a full pulse call
    # of their own -- they feed build_potential_clients below instead.
    active: list[str] = []
    for c in clients_config:
        if c in grouped or c in meetings_by_client or c in chats_by_client:
            active.append(c)
    for c in grouped:
        if c not in active and c != "Unmapped":
            active.append(c)

    # potential_clients is assembled further below, after the per-client Claude
    # calls -- it also folds in other_entities_mentioned, content those calls
    # themselves filtered out of a correctly-matched client's own card because
    # it was actually about a different named business/person.

    # ── per-client Claude calls ───────────────────────────────────────────────
    yesterday_pulse, y_name = pulse_story.load_yesterday_pulse(today)
    print(f"  memory: {'loaded ' + y_name if y_name else 'no prior pulse found'}")

    ai = _anthropic_client()

    # ── completion tracking (accumulator + alerts) ────────────────────────────
    print("\nScanning for completions (Monday status + Fireflies/WhatsApp mentions)...")
    accumulator = load_accumulator()
    current_iso_week = _iso_week(datetime.now(timezone.utc))
    apply_weekly_reset(accumulator, current_iso_week)
    seen_monday_ids = set(accumulator.get("monday_ids_seen", []))

    monday_candidates = collect_monday_done_candidates(monday_data, seen_monday_ids)
    monday_completions = summarize_monday_done(ai, monday_candidates, today)

    try:
        completion_prompt = pulse_story.build_completion_scan_prompt(
            meetings_by_client, chats_by_client, grouped, today
        )
        completion_result = _call_tool(ai, completion_prompt, EMIT_COMPLETIONS_TOOL, label="completions")
        raw_completions = completion_result.get("completions", []) or []
    except Exception as exc:
        print(f"  ⚠️  Completion scan (Fireflies/WhatsApp) failed: {exc}")
        raw_completions = []

    comms_completions = []
    for c in raw_completions:
        client = c.get("client") or "Unmapped"
        text = (c.get("text") or "").strip()
        if not text:
            continue
        comms_completions.append({
            "client": client,
            "text": text,
            "who": c.get("who"),
            "source": c.get("source") if c.get("source") in ("MTG", "WA") else "MTG",
            "sourceDate": c.get("sourceDate"),
            "monday_item_id": c.get("monday_item_id"),
        })

    # Dedup by underlying work, not literal text: monday_item_id wins when
    # available (exact -- two mentions of the same linked Monday item are the
    # same completion no matter how differently worded); otherwise a
    # similarity check against this week's already-recorded completions for
    # the same client catches two differently-worded mentions of the same
    # finished work (e.g. a WhatsApp message and a near-duplicate follow-up).
    # Checked against a running pool that grows as candidates are accepted, so
    # cross-source dupes within the same run (Monday's own Done status and a
    # WhatsApp message about that same item) also collapse into one line.
    existing_for_dedup = list(accumulator["items"])
    newly_seen_monday_ids: set[str] = set()
    deduped_new = []
    for c in monday_completions + comms_completions:
        is_dup = _is_duplicate_completion(c, existing_for_dedup)
        if c.get("source") == "MON":
            newly_seen_monday_ids.update(c.get("new_ids", []))
        if is_dup:
            continue
        record = {
            "id": _completion_id(c["client"], c["text"]),
            "client": c["client"],
            "text": c["text"],
            "who": c.get("who"),
            "source": c["source"],
            "sourceDate": c.get("sourceDate"),
            "monday_item_id": c.get("monday_item_id"),
            "generated": bool(c.get("generated")),
        }
        deduped_new.append(record)
        existing_for_dedup.append(record)
    print(f"  Found {len(monday_completions)} Monday-side + {len(comms_completions)} comms-side "
          f"candidate(s) ({len(deduped_new)} new after dedupe)")

    # The one write generate.py is allowed to make to Monday: flip a
    # comms-confirmed completion's status to Done -- only when a
    # monday_item_id was confidently identified and Monday doesn't already
    # say Done. Mirrors the same rule already live in the
    # fireflies-monday-watch automation.
    monday_meta = build_monday_meta(monday_data)
    alerts = load_alerts()
    for c in comms_completions:
        mid = c.get("monday_item_id")
        if not mid:
            continue
        meta = monday_meta.get(str(mid))
        if not meta:
            print(f"  ⚠️  '{c['text']}' cites monday_item_id {mid}, not found in this run's "
                  "board data -- skipping the Monday write.")
            continue
        if (meta.get("status") or "").strip().lower() == "done":
            continue
        if not meta.get("status_column_id") or not meta.get("board_id"):
            print(f"  ⚠️  Couldn't determine the status column for item {mid} -- skipping "
                  f"the Monday write for '{c['text']}'.")
            continue
        try:
            set_monday_status_done(meta["board_id"], mid, meta["status_column_id"])
            alerts.append({
                "item": c["text"],
                "board": meta.get("board_name") or "Unknown",
                "evidence_source": c["source"],
                "evidence_text": c["text"],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            print(f"  ⚠️  Auto-marked Done on Monday: {c['text']} ({meta.get('board_name')})")
        except Exception as exc:
            print(f"  ✗ Failed to auto-mark Done for {mid}: {exc}")

    accumulator["items"].extend(deduped_new)
    accumulator["monday_ids_seen"] = sorted(seen_monday_ids | newly_seen_monday_ids)
    ACCUMULATOR_PATH.parent.mkdir(exist_ok=True)
    ACCUMULATOR_PATH.write_text(json.dumps(accumulator, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Wrote {ACCUMULATOR_PATH}")

    ALERTS_PATH.parent.mkdir(exist_ok=True)
    ALERTS_PATH.write_text(json.dumps(alerts, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Wrote {ALERTS_PATH} ({len(alerts)} total pending alert(s))")

    print(f"\nGenerating per-client reviews ({len(active)} clients, model {MODEL})...")

    def _generate_client_entry(c: str) -> dict:
        """One client's review -- independent of every other client's, so
        these run concurrently below. Same success/fallback shape as before,
        just factored out of the loop body."""
        prompt = pulse_story.build_story_prompt(
            client=c,
            departments=grouped.get(c, {}),
            meetings=meetings_by_client.get(c, []),
            chats=chats_by_client.get(c, []),
            playbook=playbooks_by_client.get(c),
            today=today,
            yesterday_entry=pulse_story.yesterday_entry_for(yesterday_pulse, c),
        )
        try:
            result = _call_tool(ai, prompt, EMIT_CLIENT_TOOL, label=c)
            entry = assemble_client_entry(c, result, url_lookup)
        except Exception as exc:
            print(f"  ✗ {c}: {exc}")
            entry = {
                "client": c,
                "headline": "Generation failed for this client — see workflow log.",
                "health": "needs_attention",
                "work_by_department": [],
                "status_change_suggestions": [],
                "risks": [],
            }
        entry["stats"] = compute_client_stats(
            grouped.get(c, {}), meetings_by_client.get(c, []), chats_by_client.get(c, [])
        )
        return entry

    # Each client's review is an independent Claude call -- running them
    # sequentially was most of this pipeline's wall-clock time. A thread pool
    # is enough here (the wait is on network I/O, which releases the GIL) --
    # no need for a full async rewrite. Bounded to 8 concurrent calls so this
    # doesn't hammer Anthropic's rate limits with a large client list.
    # as_completed() finishes in whatever order calls actually return, so
    # results are collected by client name and then reassembled in the
    # original `active` order (config order) -- unrelated code downstream
    # (the wrap-up prompt, the site) shouldn't see client order change run
    # to run.
    results_by_client: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(active)) or 1) as pool:
        futures = {pool.submit(_generate_client_entry, c): c for c in active}
        for future in as_completed(futures):
            c = futures[future]
            results_by_client[c] = future.result()

    client_entries: list[dict] = [results_by_client[c] for c in active]

    # Content the per-client call itself filtered out of a correctly-matched
    # client's own card -- a meeting/chat matched this client as a whole, but
    # a piece of it was actually about a different named business/person
    # mentioned in passing. Pulled out here (never shipped in standup.json)
    # and folded into potential_clients below instead of silently riding
    # along inside the client card it was excluded from.
    off_topic_mentions: list[dict] = []
    for entry in client_entries:
        off_topic_mentions.extend(entry.pop("_off_topic_mentions", []) or [])

    # A meeting that content-matched several active clients at once (an
    # internal status sync, not a real client meeting -- see
    # is_ambiguous_internal_meeting) still lands in "General comms" above
    # for meetings_digest visibility, but has no business becoming a
    # fabricated potential-client card just because nothing else claimed
    # it -- filtered out of prospect-building specifically, not out of the
    # digest.
    prospect_meetings_raw = [
        m for m in meetings_by_client.get("General comms", [])
        if not is_ambiguous_internal_meeting(m, clients_config, active_clients_set)
    ]
    # Clean entity name + one-meeting synthesis BEFORE bucketing -- feeding
    # build_potential_clients's unchanged name-similarity dedup a clean name
    # per meeting (instead of the raw, often noisy Fireflies title) is what
    # lets it recognize two differently-titled meetings as the same real
    # prospect, the same general mechanism already used for other sources.
    prospect_meetings = synthesize_meeting_prospects(ai, prospect_meetings_raw, today)
    potential_clients = build_potential_clients(
        monday_data, prospect_meetings, chats_by_client.get("General comms", []),
        clients_config,
        config.get("non_client_entities", []),
        off_topic_mentions,
    )
    if potential_clients:
        print(f"  Potential clients (unmatched, not merged into a signed client): "
              f"{', '.join(p['name'] for p in potential_clients)}")
        # Lifts each prospect's meeting content into ONE top-level summary
        # (single meeting: direct lift; 2+ meetings -- the same real prospect
        # under different titles, now merged by the clean-name dedup above --
        # one combined AI synthesis) before likelihood assessment reads it.
        finalize_prospect_summaries(ai, potential_clients, today)
        assess_prospect_likelihood(ai, potential_clients, today)

    # ── meetings digest (deterministic) ───────────────────────────────────────
    meetings_digest = build_meetings_digest(fireflies_data, clients_config, active_clients_set)
    general_meetings = [m for m in meetings_digest if m.get("client") == "General comms"]

    # ── wrap-up call ──────────────────────────────────────────────────────────
    print("\nGenerating wrap-up...")
    if isinstance(fireflies_data, dict) and "error" in fireflies_data:
        board_errors = dict(board_errors)
        board_errors["Fireflies"] = fireflies_data["error"]

    try:
        wrapup = _call_tool(
            ai,
            build_wrapup_prompt(client_entries, board_errors, general_meetings, today),
            EMIT_WRAPUP_TOOL,
            label="wrap-up",
            max_tokens=4000,
        )
    except Exception as exc:
        print(f"  ✗ wrap-up failed ({exc}) — using fallback")
        headlines = [
            f"{e['client']}: {e['headline']}" for e in client_entries if e.get("headline")
        ]
        wrapup = {
            "executive_summary": " ".join(headlines[:5]) or "No summary available this week.",
            "departments_overview": [],
            "comms_flags": [],
            "blockers": [f"{d}: {err}" for d, err in board_errors.items()],
            "this_week_priorities": [],
        }

    # ── fold completions into each client entry ───────────────────────────────
    history_weeks = accumulator.get("history", [])
    for entry in client_entries:
        client = entry["client"]
        entry["completed_this_week"] = _client_completions(accumulator.get("items", []), client, url_lookup)
        entry["completed_history"] = [
            {"week_of": wk.get("isoWeek"), "items": _client_completions(wk.get("items", []), client, url_lookup)}
            for wk in history_weeks
        ]

    # ── assemble + write ──────────────────────────────────────────────────────
    standup = {
        "week_of": today,
        "executive_summary": wrapup.get("executive_summary", ""),
        "departments_overview": wrapup.get("departments_overview", []),
        "by_client": client_entries,
        "potential_clients": potential_clients,
        "meetings_digest": meetings_digest,
        "comms_flags": wrapup.get("comms_flags", []),
        "blockers": wrapup.get("blockers", []),
        "this_week_priorities": wrapup.get("this_week_priorities", []),
        "auto_completed_alerts": alerts,
    }
    inject_ids(standup)
    print(f"\n  ✓ Standup assembled: {len(client_entries)} clients, "
          f"{len(potential_clients)} potential client(s), {len(meetings_digest)} meetings")

    standups_dir = Path("standups")
    standups_dir.mkdir(exist_ok=True)

    json_path = standups_dir / "latest.json"
    json_path.write_text(json.dumps(standup, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Wrote {json_path}")

    dated_path = standups_dir / f"{today}.json"
    dated_path.write_text(json.dumps(standup, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Wrote {dated_path}")

    copy_to_site(json_path)

    md_content = render_markdown(standup)
    md_path = standups_dir / f"{today}.md"
    md_path.write_text(md_content, encoding="utf-8")
    print(f"  Wrote {md_path}")

    print("\nSending email...")
    try:
        to_address = config.get("email", "")
        if not to_address or to_address == "EMAIL_HERE":
            print("  ⚠️  No valid email in config.json — skipping")
        else:
            subject = f"Flow Pulse - {today}"
            send_standup_email(
                subject, md_content, markdown_to_simple_html(md_content), to_address
            )
    except Exception as exc:
        print(f"  ⚠️  Email failed: {exc}")

    try:
        drive_pulse.upload_daily_pulse(md_content, today, config.get("pulse_archive_folder_id", ""))
    except Exception as exc:
        print(f"  Drive pulse warning: {exc}")

    print("\n✓ Done.")


if __name__ == "__main__":
    main()
