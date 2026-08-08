"""
backfill_done_archived_last_30d.py — one-off + re-runnable backfill for items
that went Done AND got archived, where the archiving happened before a Daily
Standup run ever saw the Done status.

Scans parent boards AND their subitem boards (subitems live on separate
linked boards with independent activity logs). For subitem-board items,
client is resolved via the item's parent_item's group title, not its own.

Run: python backfill_done_archived_last_30d.py
Needs env vars: MONDAY_API_TOKEN, GH_STATE_TOKEN
"""

import json
import os
import time
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv

load_dotenv()

MONDAY_API_URL = "https://api.monday.com/v2"
GITHUB_REPO = "flow-co-ai/flow-standup"
ACCUMULATOR_PATH = "standups/completed-accumulator.json"
LOOKBACK_DAYS = 100

PARENT_BOARDS = [
    {"id": "18418241405", "name": "CRM"},
    {"id": "18405754310", "name": "Ads"},
    {"id": "18100257069", "name": "Video"},
    {"id": "18099807701", "name": "Web + SEO"},
]
SUBITEM_BOARDS = [
    {"id": "18418241406", "name": "Subitems of CRM", "is_subitem": True},
    {"id": "18405754312", "name": "Subitems of Ads", "is_subitem": True},
    {"id": "18100257245", "name": "Subitems of Video", "is_subitem": True},
    {"id": "18099807884", "name": "Subitems of Web + SEO", "is_subitem": True},
]
ALL_BOARDS = PARENT_BOARDS + SUBITEM_BOARDS


def _monday_headers():
    return {
        "Authorization": os.environ["MONDAY_API_TOKEN"],
        "Content-Type": "application/json",
        "API-Version": "2023-10",
    }


def _gh_headers():
    return {
        "Authorization": f"Bearer {os.environ['GH_STATE_TOKEN']}",
        "Accept": "application/vnd.github+json",
    }


def load_config():
    with open("config.json") as f:
        return json.load(f)


def resolve_client(text, clients_config):
    """Word-boundary match, not a plain substring check -- mirrors
    fetch_monday.py's all_alias_matches() and the same fix already applied to
    monday-done-webhook.js's resolveClient (same bug class: "Flow" must match
    "Flow OS" but never a name that merely contains "flow" as a substring)."""
    import re
    needle = (text or "").lower().strip()
    for canonical, aliases in clients_config.items():
        for alias in aliases:
            a = alias.lower().strip()
            if not a:
                continue
            if needle == a or re.search(r"(?<!\w)" + re.escape(a) + r"(?!\w)", needle):
                return canonical
    return "Unmapped"


def get_activity_log(board_id, from_date):
    query = """
    query($ids: [ID!]!, $from: ISO8601DateTime!) {
      boards(ids: $ids) {
        activity_logs(from: $from, limit: 5000) {
          created_at
          event
          data
        }
      }
    }
    """
    resp = requests.post(
        MONDAY_API_URL,
        headers=_monday_headers(),
        json={"query": query, "variables": {"ids": [str(board_id)], "from": from_date}},
        timeout=60,
    )
    resp.raise_for_status()
    payload = resp.json()
    if "errors" in payload:
        raise ValueError(payload["errors"])
    return payload["data"]["boards"][0]["activity_logs"]


def find_done_and_archived(board_id):
    from_date = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat()
    logs = get_activity_log(board_id, from_date)

    done_ids = set()
    archived_ids = set()
    for entry in logs:
        try:
            data = json.loads(entry["data"])
        except (json.JSONDecodeError, TypeError):
            continue
        if entry["event"] == "update_column_value":
            label = ((data.get("value") or {}).get("label") or {})
            # column_type ("color"), not column_title -- confirmed live
            # 2026-08-09: the Ads board's status column was renamed
            # "Current Status" -> "Status" mid-window, and Monday's activity
            # log preserves the HISTORICAL title as of each event, not the
            # current one. A title match would silently miss every Done
            # transition from before the rename, still well within this
            # script's 100-day lookback. column_type is stable across the
            # rename (matches the same type-not-title philosophy
            # fetch_monday.py's _status_column already uses, and
            # monday-done-webhook.js's ev.columnType check).
            if data.get("column_type") == "color" and label.get("text") == "Done":
                done_ids.add(str(data.get("pulse_id")))
        elif entry["event"] in ("archive_pulse", "archive_group_pulse"):
            pid = data.get("pulse_id") or data.get("item_id")
            if pid:
                archived_ids.add(str(pid))

    return done_ids & archived_ids


def fetch_items_by_id(item_ids):
    if not item_ids:
        return []
    query = """
    query($ids: [ID!]!) {
      items(ids: $ids) {
        id
        name
        state
        group { title }
        parent_item { id name group { title } }
        column_values { column { title } text type }
      }
    }
    """
    resp = requests.post(
        MONDAY_API_URL,
        headers=_monday_headers(),
        json={"query": query, "variables": {"ids": list(item_ids)}},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"]["items"]


def already_seen(item_id, accumulator):
    seen = set(accumulator.get("monday_ids_seen") or [])
    for wk in accumulator.get("history") or []:
        seen |= set(wk.get("monday_ids_seen") or [])
    return str(item_id) in seen


def get_accumulator():
    resp = requests.get(
        f"https://api.github.com/repos/{GITHUB_REPO}/contents/{ACCUMULATOR_PATH}?ref=main",
        headers=_gh_headers(),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    import base64
    content = json.loads(base64.b64decode(data["content"]).decode("utf-8"))
    return content, data["sha"]


def put_accumulator(content, sha, message):
    import base64
    resp = requests.put(
        f"https://api.github.com/repos/{GITHUB_REPO}/contents/{ACCUMULATOR_PATH}",
        headers=_gh_headers(),
        json={
            "message": message,
            "content": base64.b64encode((json.dumps(content, indent=2, ensure_ascii=False) + "\n").encode()).decode(),
            "sha": sha,
            "branch": "main",
        },
        timeout=30,
    )
    return resp


def find_candidates():
    """Detection phase only, no writes -- split out so it can be dry-run in
    isolation before touching the shared accumulator."""
    cfg = load_config()
    clients_config = cfg.get("clients", {})

    candidates = {}
    for board in ALL_BOARDS:
        print(f"Scanning {board['name']} activity log (last {LOOKBACK_DAYS}d)...")
        ids = find_done_and_archived(board["id"])
        for i in ids:
            candidates[i] = board

    print(f"\n{len(candidates)} candidate item(s) went Done + archived in the window.")
    if not candidates:
        return []

    items = fetch_items_by_id(list(candidates.keys()))
    to_add = []
    for item in items:
        status_col = next((cv for cv in item["column_values"] if cv["type"] == "status"), None)
        if not status_col or status_col.get("text") != "Done":
            continue

        board = candidates.get(str(item["id"]), {})
        if board.get("is_subitem"):
            parent = item.get("parent_item") or {}
            group_title = (parent.get("group") or {}).get("title", "")
        else:
            group_title = (item.get("group") or {}).get("title", "")

        client = resolve_client(group_title, clients_config)
        to_add.append({"item_id": str(item["id"]), "name": item["name"], "client": client})

    print(f"{len(to_add)} confirmed still-Done candidate(s) after re-checking current status.")
    return to_add


def main():
    to_add = find_candidates()
    if not to_add:
        return

    for attempt in range(1, 6):
        acc, sha = get_accumulator()
        fresh = [c for c in to_add if not already_seen(c["item_id"], acc)]
        if not fresh:
            print("All candidates already recorded. Nothing to do.")
            return

        acc.setdefault("items", [])
        acc.setdefault("monday_ids_seen", [])
        for c in fresh:
            print(f"  + {c['client']}: {c['name']} ({c['item_id']})")
            acc["items"].append({
                "id": f"backfill-{c['item_id']}",
                "client": c["client"],
                "text": f"Marked Done on Monday: {c['name']}",
                "who": None,
                "source": "MON",
                "sourceDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                "monday_item_id": c["item_id"],
                "generated": False,
            })
            acc["monday_ids_seen"].append(c["item_id"])

        resp = put_accumulator(acc, sha, f"backfill: {len(fresh)} done+archived item(s) missed by the batch pipeline (incl. subitem boards)")
        if resp.status_code in (200, 201):
            print(f"\nWrote {len(fresh)} backfilled completion(s).")
            return
        if resp.status_code == 409:
            print(f"Conflict (attempt {attempt}/5), retrying...")
            time.sleep(1.5 * attempt)
            continue
        resp.raise_for_status()

    raise RuntimeError("Gave up after 5 conflicting writes")


if __name__ == "__main__":
    main()
