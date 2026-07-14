"""
pulse_story.py - the story engine for the daily pulse.

Turns per-client data from separate source piles into ONE chronological
story, split into: NEW since yesterday's pulse, EARLIER context, OPEN
loops carried from yesterday, and UPCOMING scheduled things. The model
answers three questions: what changed, what's open, what's coming.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


# -- yesterday's pulse (memory) ------------------------------------------------

def load_yesterday_pulse(today: str, standups_dir: str = "standups"):
    """Return (data, filename) for the newest dated pulse json before today
    within the last 3 days, else (None, None)."""
    d = Path(standups_dir)
    if not d.exists():
        return None, None
    today_dt = datetime.strptime(today, "%Y-%m-%d")
    for back in (1, 2, 3):
        candidate = d / f"{(today_dt - timedelta(days=back)).strftime('%Y-%m-%d')}.json"
        if candidate.exists():
            try:
                return json.loads(candidate.read_text(encoding="utf-8")), candidate.name
            except Exception:
                continue
    return None, None


def yesterday_entry_for(yesterday_pulse: dict | None, client: str) -> dict | None:
    if not yesterday_pulse:
        return None
    for e in yesterday_pulse.get("by_client", []):
        if e.get("client") == client:
            return e
    return None


# -- event stream (cross-source, chronological) --------------------------------

def _norm_ts(raw) -> str:
    """Normalize a timestamp-ish value to a sortable ISO-ish string."""
    s = str(raw or "")[:16].replace("T", " ").strip()
    return s


def _collect_events(departments: dict, meetings: list, chats: list) -> list[dict]:
    events: list[dict] = []

    for mt in meetings or []:
        summary = mt.get("summary") or {}
        body = str(summary.get("overview") or "")[:600]
        actions = str(summary.get("action_items") or "")[:500]
        text = f"MEETING '{mt.get('title', 'Untitled')}'"
        if body:
            text += f" - overview: {body}"
        if actions:
            text += f" | action items: {actions}"
        events.append({"ts": _norm_ts(mt.get("date")), "source": "meeting", "text": text})

    for dept, items in (departments or {}).items():
        for item in items:
            for upd in (item.get("recent_updates") or [])[:6]:
                body = (upd.get("body") or "").strip()[:300]
                if not body:
                    continue
                events.append({
                    "ts": _norm_ts(upd.get("created_at")),
                    "source": "monday",
                    "text": f"{upd.get('creator', '?')} on \"{item.get('name', '')}\" ({dept}): {body}",
                })

    for chat_name, msgs in chats or []:
        if not isinstance(msgs, list):
            continue
        for m in msgs:
            body = (m.get("text") or "").strip()[:220]
            if not body:
                continue
            events.append({
                "ts": _norm_ts(m.get("datetime")),
                "source": "whatsapp",
                "text": f"{m.get('sender', '?')} in '{chat_name}': {body}",
            })

    return sorted(events, key=lambda e: e["ts"])


def _split_new(events: list[dict], now_utc: datetime) -> tuple[list, list]:
    cutoff = now_utc - timedelta(hours=24)
    cutoff_full = cutoff.strftime("%Y-%m-%d %H:%M")
    cutoff_date = cutoff.strftime("%Y-%m-%d")
    new, earlier = [], []
    for e in events:
        ts = e["ts"]
        is_new = ts[:10] >= cutoff_date if len(ts) <= 10 else ts >= cutoff_full
        (new if is_new else earlier).append(e)
    return new, earlier


# -- scheduled things on the board ----------------------------------------------

def _board_scheduled(departments: dict, today: str, horizon_days: int = 14) -> list[str]:
    """Date and timeline column values in the next N days become upcoming candidates."""
    limit = (datetime.strptime(today, "%Y-%m-%d") + timedelta(days=horizon_days)).strftime("%Y-%m-%d")
    lines = []
    for dept, items in (departments or {}).items():
        for item in items:
            for col_id, val in (item.get("columns") or {}).items():
                v = str(val or "").strip()
                if len(v) >= 10 and v[:4].isdigit() and v[4] == "-" and today <= v[:10] <= limit:
                    lines.append(
                        f"  - [id: {item.get('item_id', '?')}] {item.get('name', '')} ({dept}) "
                        f"- {col_id}: {v[:10]}"
                    )
    return lines[:12]


def _board_line(item: dict) -> str:
    bits = [f"[id: {item.get('item_id', '?')}] {item.get('name', '')}"]
    cols = item.get("columns") or {}
    status = next((v for k, v in cols.items() if "status" in k.lower()), None)
    if status:
        bits.append(f"status: {status}")
    if item.get("last_updated"):
        bits.append(f"last activity: {item['last_updated']}")
    elif item.get("created_at"):
        bits.append(f"created: {item['created_at']}")
    return "  - " + "  |  ".join(bits)


# -- the prompt ------------------------------------------------------------------

def build_story_prompt(client: str, departments: dict, meetings: list, chats: list,
                       playbook: str | None, today: str,
                       yesterday_entry: dict | None) -> str:
    now_utc = datetime.now(timezone.utc)
    events = _collect_events(departments, meetings, chats)
    new_events, earlier_events = _split_new(events, now_utc)
    scheduled = _board_scheduled(departments, today)

    parts: list[str] = []
    parts.append(
        f"# Daily pulse - {client} - {today}\n\n"
        "You write a CALM DAILY PULSE for one client of Flow Co., a marketing agency. "
        "The client's project is one evolving STORY told across meetings, Monday messages, "
        "and WhatsApp. Below, all sources are merged into one chronological feed. Newer "
        "events reframe older ones. Yesterday's pulse is a checkpoint in that story; today "
        "you report the diff. Answer three questions: what CHANGED since yesterday, what is "
        "OPEN, what is COMING.\n\n"
        "OUTPUT RULES:\n"
        "- headline: terse phrase, max 8 words, never a sentence. If health shifted vs "
        "yesterday, note direction (improving / degrading).\n"
        "- highlights = CHANGED: max 3, ONLY from NEW events below. Substance over meta: "
        "the decision, the number, the name. Phrases max 10 words. If a new event resolves "
        "an open loop, that resolution IS a highlight.\n"
        "- stalled_items = OPEN: the most consequential unresolved loops, max 2, with "
        "days_stalled as age. Carry from yesterday unless a new event closed them. An open "
        "loop nothing touched today is carried, not re-announced as news.\n"
        "- upcoming = COMING: max 3 scheduled things ahead (calls, deadlines, deliveries). "
        "Each needs text (max 8 words) and when (like 'Wed Jul 15 3pm' or '2026-07-20'). "
        "Only from dated mentions in the feed or the SCHEDULED list. NEVER infer an event "
        "nobody scheduled. Empty is fine.\n"
        "- next_up: the single nearest upcoming as one line 'Wed 3pm - MedStation kickoff'. "
        "Null if none.\n"
        "- health: on_track / needs_attention / at_risk, judged comms-first.\n"
        "- status_change_suggestions: usually empty; only when comms contradict the board.\n"
        "- risks: max 1, only if real.\n"
        "- monday_item_id verbatim from [id: N] when a row concerns a board item; else null. "
        "NEVER invent ids.\n"
        "- Yesterday's pulse is continuity, NEVER evidence: every claim traces to the feed "
        "or board below. Newest comms beat the board and beat yesterday. Quiet is a valid "
        f"answer; never pad. Today is {today}.\n"
    )

    if playbook:
        parts.append("\n## CLIENT PLAYBOOK (what good looks like)\n" + playbook[:3000])

    if yesterday_entry:
        parts.append("\n## YESTERDAY'S PULSE (checkpoint - continuity only, NOT evidence)\n")
        parts.append(f"Headline: {yesterday_entry.get('headline', '')}")
        parts.append(f"Health: {yesterday_entry.get('health', '')}")
        open_rows = []
        for dept in yesterday_entry.get("work_by_department", []):
            for row in dept.get("stalled_items", []):
                d = row.get("days_stalled")
                open_rows.append(f"  OPEN: {row.get('text', '')}" + (f" ({d}d)" if d else ""))
            for row in dept.get("highlights", []):
                open_rows.append(f"  reported: {row.get('text', '')}")
        for row in (yesterday_entry.get("upcoming") or []):
            open_rows.append(f"  UPCOMING (carried): {row.get('text', '')} - {row.get('when', '')}")
        parts.extend(open_rows or ["  (empty)"])
        parts.append("For each OPEN and UPCOMING above: resolve it (if a NEW event closed it), "
                     "carry it (aged), or escalate it. Do not re-report 'reported' lines "
                     "unless something new happened to them.")

    parts.append(f"\n## THE STORY - NEW SINCE YESTERDAY'S PULSE ({len(new_events)} events, primary)\n")
    if new_events:
        for e in new_events:
            parts.append(f"  [{e['ts']}] [{e['source']}] {e['text']}")
    else:
        parts.append("  Nothing new since yesterday.")

    parts.append(f"\n## EARLIER THIS WEEK (context only - already reported in prior pulses)\n")
    if earlier_events:
        for e in earlier_events[-20:]:
            parts.append(f"  [{e['ts']}] [{e['source']}] {e['text'][:200]}")
    else:
        parts.append("  None.")

    parts.append("\n## SCHEDULED ON THE BOARD (next 14 days - upcoming candidates)\n")
    parts.extend(scheduled or ["  None."])

    parts.append("\n## BOARD SNAPSHOT (background corroboration only)\n")
    if departments:
        for dept in sorted(departments):
            parts.append(f"### {dept}")
            for item in departments[dept]:
                parts.append(_board_line(item))
    else:
        parts.append("No live board items in the pulse window.")

    return "\n".join(parts)
