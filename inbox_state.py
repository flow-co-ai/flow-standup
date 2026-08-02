"""
inbox_state.py — Consolidated Inbox: per Monday item/subitem, one of four
deterministic read/reply states, derived purely from Monday's own
update creator_id/viewers (no LLM, no fuzzy matching).

Writes site/inbox.json, read by site/app.js. Staleness/urgency display
(elapsed time, badge color tiers) is computed client-side in app.js from
latest_update.created_at, not baked in here.
"""

OUR_MONDAY_USER_IDS = {"70062990", "69662034"}  # Nacer Amrouch, Sohib Boundaoui

STATE_READ_NOT_REPLIED = "read_not_replied"
STATE_UNREAD_NOT_REPLIED = "unread_not_replied"
STATE_UNREAD_TEAM_REPLIED = "unread_team_replied"
STATE_REPLIED_AWAITING_TEAM = "replied_awaiting_team"

STATE_LABELS = {
    STATE_READ_NOT_REPLIED: "Read, not replied",
    STATE_UNREAD_NOT_REPLIED: "Not read, not replied",
    STATE_UNREAD_TEAM_REPLIED: "Not read, team has replied",
    STATE_REPLIED_AWAITING_TEAM: "Replied, no response yet",
}


def _thread_state(updates_full: list) -> tuple:
    """updates_full must already be newest-first (fetch_monday.py sorts this).
    Returns (state, latest_update_dict), or None if the item has no updates."""
    if not updates_full:
        return None
    latest = updates_full[0]
    if latest.get("creator_id") in OUR_MONDAY_USER_IDS:
        return STATE_REPLIED_AWAITING_TEAM, latest
    read_by_us = any(uid in OUR_MONDAY_USER_IDS for uid in latest.get("viewer_ids", []))
    if read_by_us:
        return STATE_READ_NOT_REPLIED, latest
    we_replied_before = any(
        u.get("creator_id") in OUR_MONDAY_USER_IDS for u in updates_full[1:]
    )
    if we_replied_before:
        return STATE_UNREAD_TEAM_REPLIED, latest
    return STATE_UNREAD_NOT_REPLIED, latest


def _build_entry(item: dict, board: str, parent_item_id):
    result = _thread_state(item.get("updates_full") or [])
    if result is None:
        return None
    state, latest = result
    return {
        "monday_item_id": item.get("item_id") or item.get("id"),
        "item_name": item.get("name"),
        "board": board,
        "parent_item_id": parent_item_id,
        "url": item.get("monday_url"),
        "state": state,
        "state_label": STATE_LABELS[state],
        "latest_update": {
            "update_id": latest.get("update_id"),
            "created_at": latest.get("created_at"),
            "creator_name": latest.get("creator_name"),
            "is_ours": latest.get("creator_id") in OUR_MONDAY_USER_IDS,
        },
    }


def build_inbox(grouped: dict, today: str) -> dict:
    """grouped: generate.py's group_items_by_client() output, {client: {dept: [items]}}.
    Returns the full site/inbox.json payload -- items/subitems with zero updates
    ever are excluded (nothing to triage)."""
    by_client = {}
    for client, departments in grouped.items():
        if client == "Unmapped":
            continue
        entries = []
        for dept, items in departments.items():
            for item in items:
                entry = _build_entry(item, dept, None)
                if entry:
                    entries.append(entry)
                for sub in item.get("subitems") or []:
                    sub_entry = _build_entry(sub, dept, item.get("item_id"))
                    if sub_entry:
                        entries.append(sub_entry)
        if entries:
            by_client[client] = entries
    return {"generated_at": today, "by_client": by_client}
