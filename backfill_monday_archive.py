"""
backfill_monday_archive.py — One-shot script to populate the Monday updates
archive from the full item history of all four configured boards.

Run once (locally or via the backfill GitHub Actions workflow):
    python backfill_monday_archive.py
"""

import json
import requests
from dotenv import load_dotenv

load_dotenv()

from fetch_monday import MONDAY_API_URL, _token, resolve_client
import archive_monday

API_VERSION = "2023-10"


def _headers() -> dict:
    return {
        "Authorization": _token(),
        "Content-Type": "application/json",
        "API-Version": API_VERSION,
    }


_ITEMS_FRAGMENT = """
  cursor
  items {
    id
    name
    created_at
    group { title }
    updates(limit: 100) {
      id
      body
      created_at
      creator { name }
    }
    subitems {
      id
      name
      updates(limit: 100) {
        id
        body
        created_at
        creator { name }
      }
    }
  }
"""

_QUERY_FIRST = """
query GetBoard($ids: [ID!]!) {
  boards(ids: $ids) {
    id
    name
    items_page(limit: 100) {
""" + _ITEMS_FRAGMENT + """
    }
  }
}
"""

_QUERY_NEXT = """
query GetBoardPage($ids: [ID!]!, $cursor: String!) {
  boards(ids: $ids) {
    id
    name
    items_page(limit: 100, cursor: $cursor) {
""" + _ITEMS_FRAGMENT + """
    }
  }
}
"""


def fetch_board_all_items(board_id: str, board_name: str) -> dict:
    """Fetch ALL items from a board via cursor pagination, with full update history."""
    all_items = []
    cursor = None

    while True:
        if cursor:
            body = {"query": _QUERY_NEXT, "variables": {"ids": [str(board_id)], "cursor": cursor}}
        else:
            body = {"query": _QUERY_FIRST, "variables": {"ids": [str(board_id)]}}

        resp = requests.post(MONDAY_API_URL, headers=_headers(), json=body, timeout=60)
        resp.raise_for_status()
        payload = resp.json()

        if "errors" in payload:
            raise ValueError(f"Monday API errors: {payload['errors']}")

        page = payload["data"]["boards"][0]["items_page"]
        items = page.get("items") or []
        all_items.extend(items)

        cursor = page.get("cursor")
        if not cursor or not items:
            break

    # Shape items so archive_monday can process them — the "updates" key holds
    # raw update dicts; archive_monday checks both "updates" and "recent_updates".
    processed = []
    for item in all_items:
        group_title = (item.get("group") or {}).get("title", "")
        subitems = [
            {"name": sub.get("name", ""), "updates": sub.get("updates") or []}
            for sub in (item.get("subitems") or [])
        ]
        processed.append({
            "name":           item.get("name", ""),
            "item_id":        str(item.get("id", "")),
            "board_id":       str(board_id),
            "group":          group_title,
            "client":         "",   # archive_monday resolves from group_title
            "recent_updates": [],
            "updates":        item.get("updates") or [],
            "subitems":       subitems,
        })

    return {"board_name": board_name, "board_id": str(board_id), "items": processed}


def main() -> None:
    with open("config.json") as f:
        cfg = json.load(f)

    clients_config = cfg.get("clients", {})
    boards = cfg.get("boards", [])

    print(f"Backfilling Monday updates archive for {len(boards)} board(s)...\n")

    monday_data = []
    for board in boards:
        bid, bname = board["id"], board["name"]
        print(f"  [{bname}] fetching (id={bid})…")
        try:
            data = fetch_board_all_items(bid, bname)
            n_items   = len(data["items"])
            n_updates = sum(len(it.get("updates") or []) for it in data["items"])
            print(f"    {n_items} items, {n_updates} raw updates")
            monday_data.append(data)
        except Exception as exc:
            print(f"    ⚠️  Failed: {exc}")
            monday_data.append({
                "board_name": bname, "board_id": str(bid),
                "error": str(exc), "items": [],
            })

    print()
    archive_monday.archive_updates(monday_data, clients_config)
    print("Done.")


if __name__ == "__main__":
    main()
