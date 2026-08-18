"""
validate.py -- the deterministic half of the draft-queue drafter.

Everything in here used to be done by a model reading its own markdown back out
of ~/Claude/memory/projects/fireflies-pending-review/*.md. That round trip is
what produced four malformed payloads in a single run on 2026-08-18 (three
different wrong shapes), and roughly 900 words of increasingly emphatic prose in
SKILL.md A6a trying to prevent it.

The model no longer writes payload JSON into a document for a later pass to
re-parse. It emits a payload object, this file validates it, and an invalid
payload never becomes a sendable card.

Pure functions, no network. See state.py for the GitHub API side.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any


# ---------------------------------------------------------------------------
# payload validation  (replaces SKILL.md A6a)
# ---------------------------------------------------------------------------

# Fields each mode requires. updateBody is required by all three.
REQUIRED_BY_MODE: dict[str, tuple[str, ...]] = {
    "create_item":    ("boardId", "groupId", "itemName", "updateBody"),
    "create_subitem": ("boardId", "parentItemId", "itemName", "updateBody"),
    "update_only":    ("existingItemId", "itemName", "updateBody"),
}

# Fields that must never appear. columnValues is server-computed at send time by
# lib/monday.js -- a hand-authored one silently overrode assignment and shipped
# updates that notified nobody (11 cards, 2026-08-14). "board" and "group" are
# human-readable display labels, not payload fields; they leaked in once when a
# model copied the wrong fenced block.
FORBIDDEN = ("columnValues", "board", "group")

VALID_STATUSES = ("ready", "confirm", "blocked", "exists", "sent", "done", "ignored")
VALID_NULL_REASONS = ("multi-item", "content-conflict", "unmapped-client", "parse-error")


class PayloadError(ValueError):
    """Raised with a message that lands verbatim in the card's note field."""


def validate_payload(payload: Any) -> dict:
    """Return the payload unchanged, or raise PayloadError describing the problem.

    The error text is written straight onto the card so Naz sees what failed
    without opening a log.
    """
    if not isinstance(payload, dict):
        raise PayloadError(
            f"payload is {type(payload).__name__}, expected an object"
        )

    mode = payload.get("mode")
    if mode not in REQUIRED_BY_MODE:
        raise PayloadError(
            f"unknown mode {mode!r} -- expected one of {', '.join(REQUIRED_BY_MODE)}"
        )

    missing = [f for f in REQUIRED_BY_MODE[mode] if not payload.get(f)]
    if missing:
        raise PayloadError(
            f"mode {mode} is missing required field(s): {', '.join(missing)}"
        )

    present_forbidden = [f for f in FORBIDDEN if f in payload]
    if present_forbidden:
        raise PayloadError(
            f"payload must not carry {', '.join(present_forbidden)} "
            "(columnValues is server-computed; board/group are display labels)"
        )

    # Monday ids are numeric but stored as strings everywhere in this codebase.
    # Accepting an int here would produce a card that looks fine and fails on send.
    for id_field in ("boardId", "groupId", "parentItemId", "existingItemId"):
        val = payload.get(id_field)
        if val is not None and not isinstance(val, str):
            raise PayloadError(
                f"{id_field} must be a string, got {type(val).__name__} ({val!r})"
            )

    body = payload.get("updateBody", "")
    if not isinstance(body, str) or "<" not in body:
        raise PayloadError("updateBody must be the full §7-format HTML string")
    if "Salam" not in body:
        raise PayloadError("updateBody does not open with the §7 Salam greeting")

    # A subitem's parent lives on one board -- board and parentItemId disagreeing
    # is the documented cause of create_subitem's misleading 403.
    if mode == "create_subitem" and payload.get("groupId"):
        raise PayloadError("create_subitem takes parentItemId, never groupId")

    return payload


def build_card(
    *,
    card_id: str,
    title: str,
    note: str,
    status: str,
    board: str | None,
    group: str | None,
    source: str,
    source_label: str,
    priority: int,
    payload: Any = None,
    null_reason: str | None = None,
    potential_client: str | None = None,
) -> dict:
    """Assemble one queue card, validating the payload if there is one.

    A payload that fails validation does not sink the card -- it becomes a
    parse-error card with status 'confirm' so it surfaces prominently instead of
    vanishing. That was the point of the fail-loud rule and it stays.
    """
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid status {status!r}")

    # §25: group is a real board group name or genuinely null. Never a placeholder.
    # Seven live cards carried the literal string "n/a" in 2026-07 and rendered as
    # a phantom client on Daily Ops.
    if group is not None and str(group).strip().lower() in ("n/a", "na", "none", "", "null"):
        group = None

    if payload is not None:
        try:
            payload = validate_payload(payload)
            null_reason = None
        except PayloadError as exc:
            note = f"parse-error: {exc}"
            payload = None
            null_reason = "parse-error"
            status = "confirm"

    if payload is None and null_reason not in VALID_NULL_REASONS:
        raise ValueError(
            f"card {card_id} has no payload and no valid nullReason (got {null_reason!r})"
        )

    if payload is not None:
        # title must mirror what actually lands on Monday
        title = payload["itemName"]

    return {
        "id": card_id,
        "title": title,
        "note": note,
        "status": status,
        "board": board,
        "group": group,
        "potentialClient": potential_client,
        "source": source,
        "sourceLabel": source_label,
        "payload": payload,
        "nullReason": null_reason,
        "priority": int(priority),
    }


# ---------------------------------------------------------------------------
# queue merge  (replaces SKILL.md A6f)
# ---------------------------------------------------------------------------

TERMINAL = ("done", "ignored", "sent")


def merge_queue(existing: list[dict], fresh: list[dict], *, now: str | None = None) -> list[dict]:
    """Merge this run's cards into the live queue.

    Rules, all of which exist because something was lost once:
      - a card already terminal remotely is never downgraded
      - an ignored card is kept whole (ignoreReason/ignoredAt are set by Naz on
        the dashboard; this side has no way to know them, so overwriting drops them)
      - createdAt is stamped once by whoever created the card and never touched again
      - a card awaiting finalize keeps its clarification fields
      - nothing is ever deleted here; deletion happens only in the weekly archive
    """
    now = now or datetime.now(timezone.utc).isoformat()
    by_id = {c["id"]: c for c in existing}
    out: dict[str, dict] = dict(by_id)

    for card in fresh:
        cid = card["id"]
        prior = by_id.get(cid)

        if prior is None:
            out[cid] = {**card, "createdAt": now}
            continue

        if prior.get("status") in TERMINAL:
            continue  # never downgrade, never reconstruct

        if prior.get("awaitingFinalize") is True:
            continue  # Naz's clarification is still pending; leave it alone

        out[cid] = {
            **card,
            "createdAt": prior.get("createdAt", now),
        }

    return list(out.values())


# ---------------------------------------------------------------------------
# weekly archive  (replaces SKILL.md A7)
# ---------------------------------------------------------------------------

def split_for_archive(items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Return (archive_now, keep). Items move verbatim -- never re-authored."""
    archive_now = [i for i in items if i.get("status") in TERMINAL]
    keep = [i for i in items if i.get("status") not in TERMINAL]
    return archive_now, keep


def iso_week(dt: datetime | None = None) -> str:
    dt = dt or datetime.now(timezone.utc)
    year, week, _ = dt.isocalendar()
    return f"{year}-W{week:02d}"


def dedupe_by_id(items: list[dict]) -> list[dict]:
    """Keep the last occurrence of each id."""
    out: dict[str, dict] = {}
    for i in items:
        out[i["id"]] = i
    return list(out.values())


# ---------------------------------------------------------------------------
# self-check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # The four shapes that actually failed on 2026-08-18, as regression cases.
    cases = [
        ("plain prose, no object", "not a dict at all"),
        ("key:value not JSON", {"mode": "create_item", "boardId": "18405754310"}),
        ("display labels leaked", {
            "mode": "create_item", "boardId": "18405754310", "groupId": "g",
            "itemName": "X", "updateBody": "<p>Salam,</p>", "board": "CRM",
        }),
        ("int id", {
            "mode": "update_only", "existingItemId": 12471734017,
            "itemName": "X", "updateBody": "<p>Salam,</p>",
        }),
        ("hand-authored columnValues", {
            "mode": "create_item", "boardId": "1", "groupId": "g", "itemName": "X",
            "updateBody": "<p>Salam,</p>", "columnValues": {"person": "..."},
        }),
    ]
    for label, bad in cases:
        try:
            validate_payload(bad)
            print(f"FAIL  {label}: accepted a payload it should have rejected")
        except PayloadError as e:
            print(f"ok    {label}: {e}")

    good = {
        "mode": "create_item",
        "boardId": "18405754310",
        "groupId": "group_abc123",
        "itemName": "Campaign Setup",
        "updateBody": "<p>Salam,</p><p>Adding injury-type questions.</p>",
        "blocked": False,
        "needsNaz": False,
    }
    validate_payload(good)
    print("ok    valid create_item accepted")

    card = build_card(
        card_id="maadilaw-campaign-setup",
        title="ignored, overwritten by itemName",
        note="...",
        status="ready",
        board="Ads",
        group="n/a",              # placeholder -> must become None
        source="fireflies",
        source_label="Meeting with Maadi Law, 8/10",
        priority=2,
        payload=good,
    )
    assert card["group"] is None, "placeholder group survived"
    assert card["title"] == "Campaign Setup"
    print("ok    build_card normalizes placeholder group and syncs title")
