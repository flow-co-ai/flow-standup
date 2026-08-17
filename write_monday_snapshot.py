"""
write_monday_snapshot.py — pulls every item + subitem from the four boards
listed in config.json and writes a client-grouped snapshot to
site/monday-items.json. Every row carries a status column value, so downstream
matchers (apply_task_matching.js, build_timeline.js) can see Done items that
have long since left the inbox.

Separate from fetch_monday.py + generate.py (which are Nacer's). Uses the same
GraphQL query pattern and imports the alias resolver so this and the pulse
pipeline resolve group titles → clients the same way.

Env: MONDAY_API_TOKEN required. Without it, exits non-zero.
Run standalone: python write_monday_snapshot.py
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

# Reuse the alias resolver and pagination query fragments from fetch_monday.py
# rather than duplicating them. fetch_monday.py is read-only for us.
from fetch_monday import (
    resolve_client,
    _status_column,
    _QUERY_FIRST_PAGE,
    _QUERY_NEXT_PAGE,
)

load_dotenv()

MONDAY_API_URL = "https://api.monday.com/v2"


def _token() -> str:
    t = os.environ.get("MONDAY_API_TOKEN", "")
    if not t:
        sys.exit("MONDAY_API_TOKEN is not set")
    return t


def _fetch_board_items(board_id: str, headers: dict) -> list:
    """Paginated items_page fetch, mirroring fetch_monday._fetch_all_items_paginated."""
    all_items = []
    cursor = None
    while True:
        if cursor:
            body = {"query": _QUERY_NEXT_PAGE, "variables": {"ids": [str(board_id)], "cursor": cursor}}
        else:
            body = {"query": _QUERY_FIRST_PAGE, "variables": {"ids": [str(board_id)]}}
        resp = requests.post(MONDAY_API_URL, headers=headers, json=body, timeout=30)
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
    return all_items


def _latest_update_ts(updates: list) -> str | None:
    """Newest created_at across the item's own updates. None when no updates."""
    if not updates:
        return None
    best = None
    for u in updates:
        ts = u.get("created_at") or ""
        if ts and (best is None or ts > best):
            best = ts
    return best


def _pulse_url(board_id: str, item_id: str) -> str | None:
    if not (board_id and item_id):
        return None
    return f"https://flowcompany.monday.com/boards/{board_id}/pulses/{item_id}"


def _shape_subitem(sub: dict, parent_board_name: str) -> dict:
    _, status_text = _status_column(sub.get("column_values"))
    sub_id = str(sub.get("id") or "")
    sub_board_id = str((sub.get("board") or {}).get("id") or "")
    return {
        "monday_item_id": sub_id,
        "name":           sub.get("name") or "",
        "board":          parent_board_name,
        "status":         status_text,
        "monday_url":     _pulse_url(sub_board_id, sub_id),
        "updated_at":     _latest_update_ts(sub.get("updates") or []),
    }


def _shape_item(item: dict, board_id: str, board_name: str) -> dict:
    _, status_text = _status_column(item.get("column_values"))
    item_id = str(item.get("id") or "")
    return {
        "monday_item_id": item_id,
        "name":           item.get("name") or "",
        "board":          board_name,
        "status":         status_text,
        "monday_url":     _pulse_url(str(board_id), item_id),
        "updated_at":     _latest_update_ts(item.get("updates") or []),
        "subitems":       [_shape_subitem(s, board_name) for s in (item.get("subitems") or [])],
    }


def build_snapshot(config: dict) -> dict:
    """{generated_at, by_client: {client: [items…]}}. Skips 'Unmapped' groups."""
    headers = {
        "Authorization": _token(),
        "Content-Type": "application/json",
        "API-Version": "2023-10",
    }
    clients_config = config.get("clients", {})

    by_client: dict[str, list] = {}

    for board in config["boards"]:
        board_id   = str(board["id"])
        board_name = board["name"]
        try:
            items = _fetch_board_items(board_id, headers)
        except Exception as exc:
            print(f"  ✗ {board_name}: {exc}")
            continue
        print(f"  ✓ {board_name}: {len(items)} items")

        for it in items:
            group_title = (it.get("group") or {}).get("title", "")
            client = resolve_client(group_title, clients_config) if clients_config else "Unmapped"
            if client == "Unmapped":
                continue
            by_client.setdefault(client, []).append(_shape_item(it, board_id, board_name))

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "by_client":    by_client,
    }


def main() -> int:
    print("=== Write Monday snapshot ===")
    config_path = Path("config.json")
    if not config_path.exists():
        sys.exit("config.json missing")
    config = json.loads(config_path.read_text())

    snapshot = build_snapshot(config)

    out_path = Path("site") / "monday-items.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")

    n_clients = len(snapshot["by_client"])
    n_items   = sum(len(v) for v in snapshot["by_client"].values())
    n_subs    = sum(len(it.get("subitems") or []) for v in snapshot["by_client"].values() for it in v)
    print(f"\nWrote {out_path} — {n_clients} clients, {n_items} items, {n_subs} subitems")
    return 0


if __name__ == "__main__":
    sys.exit(main())
