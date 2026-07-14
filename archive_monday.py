"""
archive_monday.py — Append-only archive of Monday.com item updates.

Writes to archive/monday_updates/YYYY-MM.jsonl, one JSON record per line.
Called from generate.py after every successful board fetch; never raises.
"""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from fetch_monday import resolve_client

ARCHIVE_DIR = Path("archive/monday_updates")


def _synthetic_id(item_id: str, created_at: str, body: str) -> str:
    raw = f"{item_id}:{created_at}:{body}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _prev_ym(ym: str) -> str | None:
    try:
        dt = datetime.strptime(ym, "%Y-%m")
        if dt.month == 1:
            return f"{dt.year - 1}-12"
        return f"{dt.year}-{dt.month - 1:02d}"
    except ValueError:
        return None


def _load_known_ids(ym: str) -> set:
    """Return the set of update_ids already stored in the current and previous month's file."""
    known: set = set()
    for month in filter(None, [_prev_ym(ym), ym]):
        path = ARCHIVE_DIR / f"{month}.jsonl"
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    uid = json.loads(line).get("update_id")
                    if uid:
                        known.add(uid)
                except json.JSONDecodeError:
                    pass
    return known


def archive_updates(monday_data: list, clients_config: dict) -> None:
    """
    Iterate monday_data, extract every update (item + subitem), dedupe, and
    append new records to the appropriate monthly .jsonl file.
    Never raises — all exceptions are caught and printed as warnings.
    """
    try:
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

        # Collect new records grouped by YYYY-MM bucket
        by_month: dict[str, list] = {}

        for board in monday_data:
            if "error" in board:
                continue
            board_id   = str(board.get("board_id") or "")
            board_name = board.get("board_name", "")

            for item in board.get("items", []):
                item_id     = str(item.get("item_id") or item.get("id") or "")
                item_name   = item.get("name", "")
                group_title = item.get("group", "")
                client      = resolve_client(group_title, clients_config, fuzzy=True)

                # Gather all update dicts from item-level and subitem-level fields.
                # "recent_updates" is the field name in regular fetch_monday output;
                # "updates" is the raw field name from the backfill query.
                update_sources = list(item.get("recent_updates") or [])
                update_sources.extend(item.get("updates") or [])
                for sub in (item.get("subitems") or []):
                    update_sources.extend(sub.get("recent_updates") or [])
                    update_sources.extend(sub.get("updates") or [])

                for upd in update_sources:
                    created_at = (upd.get("created_at") or "").strip()
                    body       = (upd.get("body") or "").strip()
                    creator    = ((upd.get("creator") or {}).get("name") or "").strip()
                    raw_id     = upd.get("id") or upd.get("update_id") or ""
                    update_id  = str(raw_id) if raw_id else _synthetic_id(item_id, created_at, body)

                    ym = created_at[:7]  # "YYYY-MM"
                    if len(ym) != 7:
                        ym = datetime.now(timezone.utc).strftime("%Y-%m")

                    by_month.setdefault(ym, []).append({
                        "update_id":   update_id,
                        "board_id":    board_id,
                        "board_name":  board_name,
                        "group_title": group_title,
                        "client":      client,
                        "item_id":     item_id,
                        "item_name":   item_name,
                        "created_at":  created_at,
                        "creator":     creator,
                        "body":        body,
                    })

        total_new = 0
        total_dup = 0

        for ym, records in sorted(by_month.items()):
            known = _load_known_ids(ym)
            new_records = []
            for rec in records:
                uid = rec["update_id"]
                if uid in known:
                    total_dup += 1
                else:
                    known.add(uid)   # prevent intra-batch duplicates
                    new_records.append(rec)
                    total_new += 1

            if new_records:
                path = ARCHIVE_DIR / f"{ym}.jsonl"
                with open(path, "a", encoding="utf-8") as fh:
                    for rec in new_records:
                        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

        print(f"  Archive: +{total_new} new updates ({total_dup} already stored)")

    except Exception as exc:
        print(f"  ⚠️  archive_monday failed (non-blocking): {exc}")
