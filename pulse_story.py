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
        f"- TOPICAL FILTER (checked before anything else): a meeting or chat below was "
        f"matched to {client} as a WHOLE (e.g. by its title), but a single meeting can "
        f"still cover more than one distinct business in passing -- a different prospect's "
        f"pilot proposal, a follow-up call with someone else's contact, an unrelated aside. "
        f"For EVERY candidate highlight/stalled item, ask: is this actually about {client}, "
        f"or about a different named business/person's deal? If it names a different "
        f"specific entity than {client} and isn't genuinely {client}'s own work, EXCLUDE it "
        f"from highlights/stalled_items and instead add it to other_entities_mentioned "
        f"(entity name + short blurb) -- never let it ride into this card just because the "
        f"source as a whole matched {client}.\n"
        "- headline: terse phrase, max 8 words, never a sentence. If health shifted vs "
        "yesterday, note direction (improving / degrading).\n"
        "- highlights = CHANGED: max 3, ONLY from NEW events below AND only ones that pass "
        "the topical filter above. Substance over meta: the decision, the number, the name. "
        "Phrases max 10 words. If a new event resolves an open loop, that resolution IS a "
        "highlight.\n"
        "- stalled_items = OPEN: the most consequential unresolved loops, max 2, with "
        "days_stalled as age. Carry from yesterday unless a new event closed them. An open "
        "loop nothing touched today is carried, not re-announced as news.\n"
        "- other_entities_mentioned: max 4, any candidate the topical filter excluded above. "
        "Each needs entity (the other business/person's name) and text (short blurb of what "
        "was said about them, max 14 words). Empty is normal and fine.\n"
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


# -- completion scan (Fireflies/WhatsApp -> genuine, unhedged completions) ----

def build_completion_scan_prompt(
    meetings_by_client: dict, chats_by_client: dict, grouped: dict, today: str
) -> str:
    """Cross-client, one shot -- scans meeting transcripts and WhatsApp
    messages already fetched this run for genuine completions of specific
    named work. The board snapshot is included ONLY so the model can match a
    completion to a real monday_item_id when one is obvious -- never to
    invent one."""
    parts: list[str] = []
    parts.append(
        f"# Completion scan - {today}\n\n"
        "Scan the meetings and WhatsApp messages below for GENUINE completions of a "
        "specific, named piece of work. Be strict about hedging.\n\n"
        "COUNTS AS DONE (examples): 'done', 'completed', 'finished', 'live now', "
        "'shipped', 'that's fixed', 'pushed live', 'wrapped that up'.\n"
        "DOES NOT COUNT -- exclude these (examples): 'almost done', 'should be done "
        "soon', 'working on finishing it', 'close to done', 'will be done by Friday', "
        "'mostly there'.\n\n"
        "For each genuine completion, emit:\n"
        "- client: which client this belongs to, using the client names shown below.\n"
        "- text: a short PLAIN-LANGUAGE SUMMARY of what was actually done, max ~14 "
        "words -- a real sentence fragment describing the work, not just the task's "
        "name restated. E.g. 'cleaned up duplicate contacts and added a lookup before "
        "create' rather than 'Duplicate Contacts'. If the source explains WHY or HOW, "
        "fold that in -- substance over label.\n"
        "- who: the person who said/did it, if named. Null if not clear.\n"
        "- source: 'MTG' if from a meeting, 'WA' if from WhatsApp.\n"
        "- sourceDate: the date of that meeting/message if known (YYYY-MM-DD), else null.\n"
        "- monday_item_id: ONLY if you can confidently match this completion to a "
        "specific item or subitem id shown in the board snapshot below. Null if there's "
        "any doubt at all -- never guess an id.\n\n"
        "If the same underlying piece of work is described more than once (e.g. a "
        "WhatsApp message and a near-duplicate follow-up, or two people confirming the "
        "same thing), emit it ONCE -- don't produce one row per mention.\n\n"
        "If nothing genuinely completed is mentioned anywhere, return an empty list. "
        "Don't manufacture completions just to have something to report.\n"
    )

    parts.append("\n## MEETINGS (Fireflies)\n")
    any_meeting = False
    for client, meetings in (meetings_by_client or {}).items():
        for mt in meetings:
            any_meeting = True
            parts.append(f"### {client} - {mt.get('title', 'Untitled')} ({mt.get('date', 'no date')})")
            summary = mt.get("summary") or {}
            if summary.get("overview"):
                parts.append(f"  Overview: {str(summary['overview'])[:800]}")
            if summary.get("action_items"):
                parts.append(f"  Action items: {str(summary['action_items'])[:500]}")
            if mt.get("sentences"):
                for s in mt["sentences"][:15]:
                    parts.append(f"    {s.get('speaker_name', '?')}: {s.get('text', '')}")
    if not any_meeting:
        parts.append("None.")

    parts.append("\n## WHATSAPP\n")
    any_chat = False
    for client, chats in (chats_by_client or {}).items():
        for chat_name, msgs in chats:
            if not isinstance(msgs, list):
                continue
            for msg in msgs[:30]:
                any_chat = True
                ts = (msg.get("datetime") or "")[:16]
                parts.append(
                    f"[{client} / {chat_name} / {ts}] {msg.get('sender', '?')}: "
                    f"{(msg.get('text') or '')[:220]}"
                )
    if not any_chat:
        parts.append("None.")

    parts.append("\n## BOARD SNAPSHOT (item/subitem ids for matching only -- never invent one)\n")
    any_board = False
    for client, departments in (grouped or {}).items():
        for dept, items in departments.items():
            for item in items:
                any_board = True
                parts.append(f"[{client}] [id: {item.get('item_id', '?')}] {item.get('name', '')} ({dept})")
                for sub in item.get("subitems", []) or []:
                    if sub.get("id"):
                        parts.append(
                            f"  [{client}] [id: {sub['id']}] {sub.get('name', '')} "
                            f"(subitem of {item.get('name', '')})"
                        )
    if not any_board:
        parts.append("None.")

    return "\n".join(parts)


# -- monday-done summarization (raw status flips -> one real summary line) ----

def build_monday_done_prompt(candidates: list[dict], today: str) -> str:
    """candidates: [{client, item_name, item_id, subitem_names, recent_updates:
    [{creator, body, created_at}]}]. Each candidate is everything that flipped to
    Done on Monday for ONE parent item since it was last checked -- the item
    itself, its just-finished subitems, or both together. Turns the raw
    item/subitem names into one short plain-language line per candidate,
    grounded in whatever update text is available, instead of the site just
    listing Monday titles verbatim."""
    parts: list[str] = []
    parts.append(
        f"# Monday completions - {today}\n\n"
        "Each candidate below is one Monday item (and, if listed, its subitems) "
        "that just turned Done. For EACH candidate, write ONE short plain-language "
        "line summarizing what was actually completed -- read like a real person "
        "describing the work, not a restatement of the item/subitem names.\n\n"
        "If a candidate has subitems listed, your one line must cover the parent "
        "AND all its listed subitems together (e.g. 'cleaned up existing "
        "duplicates, fixed update logic, added contact lookup before create' for a "
        "parent 'Duplicate Contacts' with subitems 'Cleanup', 'Fix updates', 'Add "
        "lookup') -- never emit more than one line per candidate.\n\n"
        "Use the recent update text (if present) to say WHAT was done, not just "
        "THAT something was done -- if updates give no real detail beyond the "
        "names, write the most concrete plain-language line the names support "
        "(e.g. 'Duplicate Contacts' + subitem 'Cleanup' -> 'cleaned up duplicate "
        "contact records'), still phrased as a summary, never the raw title "
        "verbatim.\n\n"
        "For each candidate emit:\n"
        "- client: exactly as given.\n"
        "- text: the plain-language summary line, max ~16 words.\n"
        "- item_id: exactly as given, verbatim -- never invent or alter.\n\n"
        "Emit exactly one row per candidate below, same order, none skipped.\n"
    )

    parts.append("\n## CANDIDATES\n")
    for i, c in enumerate(candidates):
        parts.append(f"### Candidate {i + 1} -- client: {c.get('client', '')}")
        parts.append(f"item_id: {c.get('item_id', '')}")
        parts.append(f"Parent item: {c.get('item_name', '')}"
                     + (" (itself just marked Done)" if c.get("item_done") else " (not itself done -- only subitems below are new)"))
        subs = c.get("subitem_names") or []
        if subs:
            parts.append("Subitems just marked Done: " + "; ".join(subs))
        updates = c.get("recent_updates") or []
        if updates:
            parts.append("Recent updates (context for what happened):")
            for u in updates[:4]:
                body = (u.get("body") or "").strip()[:250]
                if body:
                    parts.append(f"  [{(u.get('created_at') or '')[:10]} - {u.get('creator', '?')}] {body}")
        parts.append("")

    return "\n".join(parts)


# -- prospect likelihood-to-close (subjective, never treated as fact) ---------

def build_prospect_likelihood_prompt(prospects: list[dict], today: str) -> str:
    """prospects: [{name, items: [{source, blurb, when, overview, action_items}]}]
    -- whatever real text exists per prospect (a meeting's full summary and
    action items, a WhatsApp thread, a bare mention). Asks for a tone/interest
    read, not a measurement -- the site always renders this flagged as an
    estimate, same as it does for a generated (as opposed to real) completion
    summary."""
    parts: list[str] = []
    parts.append(
        f"# Prospect likelihood assessment - {today}\n\n"
        "For each prospect below, judge how likely they are to close as a "
        "paying client based on tone and interest signals in the text: "
        "enthusiasm, objections raised, commitment to a concrete next step "
        "(a scheduled call, a signed form, a stated start date), budget or "
        "pricing discussion, urgency. This is a SUBJECTIVE judgment call about "
        "tone, not a measurement -- there is no ground truth to check it "
        "against, so don't hedge by clustering everything near 50.\n\n"
        "For each prospect you can actually judge, emit:\n"
        "- name: exactly as given below.\n"
        "- percent: 0-100, your estimate of likelihood to close.\n"
        "- reason: one short sentence (max ~20 words) citing the SPECIFIC "
        "signal that drove your number -- e.g. 'asked about pricing and "
        "proposed a start date' or 'no response since initial outreach, no "
        "budget discussed'.\n\n"
        "If a prospect's text is too thin to form any real judgment (a bare "
        "one-line mention with no tone or content to read) -- SKIP it "
        "entirely. Don't invent a number just to have one for every prospect "
        "on the list.\n"
    )
    parts.append("\n## PROSPECTS\n")
    for p in prospects:
        parts.append(f"### {p.get('name', '')}")
        for item in p.get("items", []) or []:
            when = item.get("when") or "no date"
            parts.append(f"  [{item.get('source', '?')} / {when}] {item.get('blurb', '')}")
        # The synthesized summary (one or more merged meetings) is the
        # richest signal available -- prefer it over the raw per-item
        # blurbs above when present.
        if p.get("summary"):
            parts.append(f"    Full summary: {str(p['summary'])[:600]}")
        if p.get("action_items"):
            parts.append(f"    Action items: {'; '.join(p['action_items'][:6])}")
        parts.append("")
    return "\n".join(parts)


# -- prospect meeting synthesis (clean entity name + one summary per meeting) --

def build_meeting_prospect_synthesis_prompt(meetings: list[dict], today: str) -> str:
    """meetings: [{title, date, overview, action_items}] -- unmatched Fireflies
    calls (already filtered clear of internal syncs -- see
    is_ambiguous_internal_meeting). Fireflies titles are noisy ("Citrus
    Smiles Marketing Systems", "Parth Patel and Flow Company") and the same
    real prospect often gets a differently-worded title call to call --
    this asks for a CLEAN, SHORT entity name per meeting specifically so the
    existing name-similarity dedup (SIMILARITY_DUP_THRESHOLD) has a fair
    shot at recognizing two calls as the same prospect, the same way it
    already does for a clean model-extracted name elsewhere in this
    pipeline. Also asks for a one-meeting synthesis (not a raw bullet dump)
    so a prospect with only one meeting never needs a second AI pass to get
    a clean summary."""
    parts: list[str] = []
    parts.append(
        f"# Prospect meeting synthesis - {today}\n\n"
        "Each meeting below is an unmatched Fireflies call -- not identified "
        "as any existing signed client's own meeting. For EACH meeting, "
        "identify the actual prospect (the specific outside business or "
        "person this call is with) and write a clean synthesis of it.\n\n"
        "For each meeting emit:\n"
        "- index: exactly as given, verbatim.\n"
        "- entity_name: the SHORT, clean name of the specific business or "
        "person this call is with -- e.g. 'Citrus Smiles' or 'Parth Patel', "
        "never the raw meeting title verbatim (titles are often noisy: "
        "'Citrus Smiles Marketing Systems', 'Parth Patel and Flow Company'). "
        "If the SAME prospect is clearly the subject across several meetings "
        "in this batch, use the EXACT SAME entity_name string for all of "
        "them, so they can be recognized as the same prospect.\n"
        "- summary: 2-4 plain sentences synthesizing what this ONE meeting "
        "was actually about -- read like a real person's account, not a "
        "restated bullet list. Plain prose only: no markdown (no ** bold, "
        "no leading '-' bullets), no headers.\n"
        "- action_items: a clean, deduplicated list of concrete next steps "
        "from this meeting, max 5, plain sentences (no markdown, no "
        "speaker-name-only entries).\n\n"
        "Emit exactly one row per meeting below, same order, none skipped.\n"
    )
    parts.append("\n## MEETINGS\n")
    for i, mt in enumerate(meetings):
        summary = mt.get("summary") or {}
        parts.append(f"### index {i} -- {mt.get('title', 'Untitled')} ({mt.get('date', 'no date')})")
        if summary.get("overview"):
            parts.append(f"  Overview: {str(summary['overview'])[:1000]}")
        if summary.get("action_items"):
            parts.append(f"  Action items: {str(summary['action_items'])[:600]}")
        parts.append("")
    return "\n".join(parts)


def build_prospect_group_synthesis_prompt(prospects: list[dict], today: str) -> str:
    """prospects: [{name, meeting_summaries: [{summary, action_items}]}] --
    prospects whose meetings merged into ONE card (2+ real meetings under
    possibly-different titles, already deduped by clean entity name). Each
    already has a clean per-meeting synthesis from
    build_meeting_prospect_synthesis_prompt; this combines those into ONE
    cohesive summary per prospect instead of showing several back to back."""
    parts: list[str] = []
    parts.append(
        f"# Prospect multi-meeting synthesis - {today}\n\n"
        "Each prospect below has had more than one real meeting. Combine "
        "that prospect's separate per-meeting summaries into ONE cohesive "
        "synthesis of the whole relationship so far -- not a list of "
        "separate meeting recaps stitched together.\n\n"
        "For each prospect emit:\n"
        "- name: exactly as given below.\n"
        "- summary: 2-5 plain sentences covering the overall arc across all "
        "their meetings -- what's been discussed, how it's progressed, "
        "where it stands now. Plain prose only: no markdown (no ** bold, no "
        "leading '-' bullets), no headers.\n"
        "- action_items: ONE deduplicated list of concrete next steps across "
        "ALL their meetings combined, max 6, plain sentences -- merge "
        "near-duplicate items from different meetings into one.\n\n"
        "Emit exactly one row per prospect below, same order, none skipped.\n"
    )
    parts.append("\n## PROSPECTS\n")
    for p in prospects:
        parts.append(f"### {p.get('name', '')}")
        for i, ms in enumerate(p.get("meeting_summaries", []) or []):
            parts.append(f"  Meeting {i + 1}: {ms.get('summary', '')}")
            if ms.get("action_items"):
                parts.append(f"    Action items: {'; '.join(ms['action_items'])}")
        parts.append("")
    return "\n".join(parts)
