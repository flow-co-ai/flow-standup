"""
fetch_monday.py — Pulls items and recent updates from Monday.com boards.
Each item is tagged with its resolved canonical client name.
Run standalone to test: python fetch_monday.py
"""

import os
import json
import requests
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv

load_dotenv()

MONDAY_API_URL = "https://api.monday.com/v2"


# ── client resolution (shared by generate.py) ─────────────────────────────────

def resolve_client(text: str, clients_config: dict, fuzzy: bool = False) -> str:
    """
    Map text to a canonical client name using the alias table from config.json.

    fuzzy=False (default): text must exactly equal one alias (case-insensitive).
                           Used for Monday group titles.
    fuzzy=True:            any alias that appears as a substring of text matches.
                           Used for meeting titles and chat file names.

    Returns "Unmapped" when nothing matches.
    """
    needle = text.lower().strip()

    # Exact equality always wins first (original strict behavior).
    for canonical, aliases in clients_config.items():
        for alias in aliases:
            if needle == alias.lower().strip():
                return canonical

    # Word-boundary matching: an alias must appear as whole word(s), so
    # "Flow" matches "Flow OS" but never "workflow". Spaced and unspaced
    # spellings are treated as equal ("Med Station" == "MedStation").
    matches = all_alias_matches(text, clients_config)
    return matches[0] if matches else "Unmapped"


def all_alias_matches(text: str, clients_config: dict) -> list[str]:
    """All clients whose alias appears as a whole word in text, spacing-tolerant."""
    import re
    needle = text.lower()
    found = []
    for canonical, aliases in clients_config.items():
        variants = set()
        for alias in aliases:
            a = alias.lower().strip()
            if a:
                variants.add(a)
                variants.add(a.replace(" ", ""))
        for v in variants:
            if re.search(r"(?<!\w)" + re.escape(v) + r"(?!\w)", needle):
                found.append(canonical)
                break
    return found


# ── Monday API ────────────────────────────────────────────────────────────────

def _token() -> str:
    t = os.environ.get("MONDAY_API_TOKEN", "")
    if not t:
        raise ValueError("MONDAY_API_TOKEN is not set")
    return t


def _status_column(column_values: list | None) -> tuple[str | None, str | None]:
    """(column_id, text) for the first status-type column, or (None, None).
    Matches by type rather than a hardcoded column id, since it needs to work
    across boards (Ads/CRM/Web+SEO/Video) that may not share the same id."""
    for cv in column_values or []:
        if cv.get("type") == "status":
            return cv.get("id"), cv.get("text")
    return None, None


def set_monday_status_done(board_id: str, item_id: str, status_column_id: str) -> None:
    """Sets one item/subitem's status column to "Done". This is the ONLY write
    generate.py is allowed to make to Monday -- mirrors the same rule already
    live in the fireflies-monday-watch automation. Raises on failure; the
    caller is responsible for deciding whether that's fatal."""
    headers = {
        "Authorization": _token(),
        "Content-Type": "application/json",
        "API-Version": "2023-10",
    }
    mutation = """
    mutation SetDone($board: ID!, $item: ID!, $col: String!, $val: JSON!) {
      change_column_value(board_id: $board, item_id: $item, column_id: $col, value: $val) {
        id
      }
    }
    """
    resp = requests.post(
        MONDAY_API_URL,
        headers=headers,
        json={
            "query": mutation,
            "variables": {
                "board": str(board_id),
                "item": str(item_id),
                "col": status_column_id,
                "val": json.dumps({"label": "Done"}),
            },
        },
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    if "errors" in payload:
        raise ValueError(f"Monday API errors: {payload['errors']}")


def fetch_board(
    board_id: str,
    board_name: str,
    days_back: int = 7,
    clients_config: dict | None = None,
) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)

    headers = {
        "Authorization": _token(),
        "Content-Type": "application/json",
        "API-Version": "2023-10",
    }

    query = """
    query GetBoard($ids: [ID!]!) {
      boards(ids: $ids) {
        id
        name
        groups { id title }
        items_page(limit: 100) {
          items {
            id
            name
            created_at
            group { id title }
            column_values {
              id
              text
              value
              type
            }
            subitems {
              id
              name
              board { id }
              column_values {
                id
                text
                value
                type
              }
            }
            updates(limit: 25) {
              body
              created_at
              creator { name }
            }
          }
        }
      }
    }
    """

    resp = requests.post(
        MONDAY_API_URL,
        headers=headers,
        json={"query": query, "variables": {"ids": [str(board_id)]}},
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()

    if "errors" in payload:
        raise ValueError(f"Monday API errors: {payload['errors']}")

    raw_items = payload["data"]["boards"][0]["items_page"]["items"]
    processed = []

    for item in raw_items:
        group_title = (item.get("group") or {}).get("title", "")

        # Resolve to canonical client (or "Unmapped")
        client = (
            resolve_client(group_title, clients_config)
            if clients_config
            else "Unmapped"
        )

        columns = {
            cv["id"]: cv["text"]
            for cv in item.get("column_values", [])
            if cv.get("text")
        }
        status_col_id, status_text = _status_column(item.get("column_values"))

        subitems = []
        for sub in item.get("subitems", []):
            sub_cols = {
                cv["id"]: cv["text"]
                for cv in sub.get("column_values", [])
                if cv.get("text")
            }
            sub_status_col_id, sub_status_text = _status_column(sub.get("column_values"))
            sub_id = str(sub.get("id", ""))
            sub_board_id = str((sub.get("board") or {}).get("id") or "")
            sub_url = (
                f"https://flowcompany.monday.com/boards/{sub_board_id}/pulses/{sub_id}"
                if sub_board_id and sub_id else None
            )
            subitems.append({
                "id": sub_id,
                "name": sub["name"],
                "columns": sub_cols,
                "status": sub_status_text,
                "status_column_id": sub_status_col_id,
                "board_id": sub_board_id or None,
                "monday_url": sub_url,
            })

        item_id = str(item.get("id", ""))
        monday_url = (
            f"https://flowcompany.monday.com/boards/{board_id}/pulses/{item_id}"
            if item_id else None
        )

        last_updated_dt = None
        recent_updates = []
        for upd in item.get("updates", []):
            raw_ts = upd.get("created_at", "")
            if not raw_ts:
                continue
            try:
                ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
                if last_updated_dt is None or ts > last_updated_dt:
                    last_updated_dt = ts
                if ts >= cutoff:
                    recent_updates.append(
                        {
                            "body": upd.get("body", ""),
                            "created_at": raw_ts,
                            "creator": (upd.get("creator") or {}).get("name", "Unknown"),
                        }
                    )
            except (ValueError, TypeError):
                pass

        created_at = (item.get("created_at") or "")[:10] or None

        processed.append(
            {
                "name": item["name"],
                "item_id": item_id,
                "created_at": created_at,
                "board_id": str(board_id),
                "monday_url": monday_url,
                "last_updated": last_updated_dt.date().isoformat() if last_updated_dt else None,
                "group": group_title,
                "client": client,
                "columns": columns,
                "status": status_text,
                "status_column_id": status_col_id,
                "subitems": subitems,
                "recent_updates": recent_updates,
            }
        )

    return {"board_name": board_name, "board_id": str(board_id), "items": processed}


def fetch_all_boards(config: dict) -> tuple[list, list]:
    """Returns (results_list, errors_list). Never raises — errors land in results."""
    clients_config = config.get("clients", {})
    results = []
    errors = []

    for board in config["boards"]:
        try:
            data = fetch_board(
                board["id"],
                board["name"],
                config.get("days_back", 7),
                clients_config,
            )
            results.append(data)
            print(f"  ✓ {board['name']}: {len(data['items'])} items")
        except Exception as exc:
            msg = str(exc)
            errors.append(f"{board['name']}: {msg}")
            print(f"  ✗ {board['name']}: {msg}")
            results.append(
                {
                    "board_name": board["name"],
                    "board_id": str(board["id"]),
                    "error": msg,
                    "items": [],
                }
            )

    return results, errors


# ── standalone test ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    with open("config.json") as f:
        cfg = json.load(f)

    print(f"Fetching {len(cfg['boards'])} Monday.com boards...\n")
    results, errors = fetch_all_boards(cfg)

    total_items = sum(len(r["items"]) for r in results)
    total_updates = sum(
        len(item["recent_updates"])
        for r in results
        for item in r["items"]
    )

    print(f"\n── Board summary ────────────────────────")
    ok = len([r for r in results if "error" not in r])
    print(f"  Boards OK : {ok}/{len(results)}")
    print(f"  Items     : {total_items}")
    print(f"  Updates (last {cfg.get('days_back', 7)} days): {total_updates}")

    # Client breakdown
    client_counts: dict[str, dict[str, int]] = {}
    for board in results:
        dept = board["board_name"]
        for item in board.get("items", []):
            c = item.get("client", "Unmapped")
            client_counts.setdefault(c, {}).setdefault(dept, 0)
            client_counts[c][dept] += 1

    print(f"\n── Client breakdown ─────────────────────")
    # Config order first, Unmapped last
    ordered = list(cfg.get("clients", {}).keys()) + ["Unmapped"]
    for client in ordered:
        if client not in client_counts:
            continue
        dept_str = ", ".join(f"{d}:{n}" for d, n in sorted(client_counts[client].items()))
        total = sum(client_counts[client].values())
        print(f"  {client:<25}  {total:>3} items  ({dept_str})")

    unmapped_groups = {
        item["group"]
        for board in results
        for item in board.get("items", [])
        if item.get("client") == "Unmapped" and item.get("group")
    }
    if unmapped_groups:
        print(f"\n  ⚠️  Unmapped group names: {sorted(unmapped_groups)}")
        print("     Add aliases to config.json to assign these to a client.")

    if errors:
        print(f"\n  Errors: {errors}")
