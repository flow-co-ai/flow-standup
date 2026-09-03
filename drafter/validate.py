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

import difflib
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

# client_aliases.py lives at repo root; this file runs as `python
# drafter/validate.py`, whose sys.path[0] is drafter/, not the root -- add it
# explicitly rather than assuming cwd. Still "no network": config.json is a
# committed repo file, same as generate.py/build_timeline.js reading it
# directly, and client_aliases.py itself has zero dependencies (no requests,
# no dotenv) so this stays safe to import from a module that's otherwise pure.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from client_aliases import resolve_client as _resolve_client  # noqa: E402

with open(os.path.join(_REPO_ROOT, "config.json")) as _f:
    _CLIENTS_CONFIG = json.load(_f).get("clients", {})


def canonical_client_name(name: str | None) -> str | None:
    """§19b's group-match axis needs this: Monday's own group titles for one
    client aren't even consistent with each other across boards (CRM/Web+SEO
    show "Quality HVAC by FIbid", Ads/Video show "Quality HVAC" for the same
    client) -- comparing raw `group` strings misses that they're the same
    client. Resolves through the same config.json alias table generate.py
    already uses. Falls back to the original string when nothing resolves
    (a genuinely new/unmapped name is a real value, not an error)."""
    if not name:
        return name
    resolved = _resolve_client(name, _CLIENTS_CONFIG)
    return resolved if resolved != "Unmapped" else name


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

# Cards still eligible to be matched against by the §19b pending-queue audit.
# Excludes sent/done (already real, or already decided) and ignored (already
# consumed separately as negative signal via ignoreReason -- see §29 and A5's
# ignored-card check; double-counting it here would be re-litigating a
# decision Naz already made).
NON_TERMINAL_STATUSES = ("ready", "confirm", "blocked", "exists")


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

    # Quality HVAC alias fix (2026-09): a board's own group title isn't always
    # the canonical roster name (CRM/Web+SEO show "Quality HVAC by FIbid",
    # Ads/Video show "Quality HVAC" for the SAME client) -- writing the raw
    # title verbatim split one client into two Daily Ops buckets (8 cards vs
    # 3). Resolve through config.json here, at write time, so a fresh card is
    # correct immediately instead of needing a read-time patch.
    if group is not None:
        group = canonical_client_name(group)

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
# pending-queue audit  (drafting-rules.md §19b)
# ---------------------------------------------------------------------------
#
# A third port of the same text-similarity mechanism generate.py's
# _text_similarity and netlify/functions/lib/textSimilarity.js already carry
# (see the header comment in textSimilarity.js). Three copies is already the
# accepted shape for this specific piece of logic -- py-side generator,
# js-side fire-time re-audit, and now this py-side draft-time audit each run
# in a different process with no shared runtime, so a real import isn't an
# option. Keep the threshold and containment rule identical across all three
# if either ever changes.

SIMILARITY_DUP_THRESHOLD = 0.6


def _norm_similarity_text(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def _text_similarity(a: str, b: str) -> float:
    """0.0-1.0. Full containment (either direction) of a non-trivial-length
    string (8+ chars) counts as a perfect match; otherwise plain
    difflib.SequenceMatcher ratio(). See generate.py's _text_similarity for
    the full rationale -- this must stay behaviorally identical to it."""
    na, nb = _norm_similarity_text(a), _norm_similarity_text(b)
    if not na or not nb:
        return 0.0
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(shorter) >= 8 and shorter in longer:
        return 1.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def find_pending_queue_match(
    *,
    existing_item_id: str | None,
    parent_item_name: str | None,
    subject_text: str,
    group: str | None,
    compare_text: str,
    queue_items: list[dict],
) -> dict | None:
    """The §19b matcher. Checks a not-yet-drafted candidate against every
    NON_TERMINAL_STATUSES card already in the queue, strongest axis first.
    Returns {"card": <matching card>, "axis": 1|2|3, "score": float} for the
    single best match, or None.

    subject_text/compare_text are whatever text best represents the new
    candidate before a payload exists -- e.g. a short summary of what the
    transcript said, and the same text (or a draft title), respectively.
    axis 2 compares subject_text against each candidate's payload.updateBody
    (falling back to its title); axis 3 compares compare_text against title
    and updateBody.
    """
    candidates = [c for c in queue_items if c.get("status") in NON_TERMINAL_STATUSES]

    if existing_item_id:
        for card in candidates:
            if (card.get("payload") or {}).get("existingItemId") == existing_item_id:
                return {"card": card, "axis": 1, "score": 1.0}

    best: dict | None = None

    if parent_item_name:
        for card in candidates:
            payload = card.get("payload") or {}
            if payload.get("parentItemName") != parent_item_name:
                continue
            target = payload.get("updateBody") or card.get("title") or ""
            score = _text_similarity(subject_text, target)
            if score >= SIMILARITY_DUP_THRESHOLD and (not best or score > best["score"]):
                best = {"card": card, "axis": 2, "score": score}

    if best:
        return best

    if group:
        canon_group = canonical_client_name(group)
        for card in candidates:
            if canonical_client_name(card.get("group")) != canon_group:
                continue
            payload = card.get("payload") or {}
            for target in (card.get("title") or "", payload.get("updateBody") or ""):
                score = _text_similarity(compare_text, target)
                if score >= SIMILARITY_DUP_THRESHOLD and (not best or score > best["score"]):
                    best = {"card": card, "axis": 3, "score": score}

    return best


def merge_source_labels(existing_label: str, new_label: str) -> str:
    """Append, never replace -- the whole point of §19b's age badge fix is
    that the merged card's history stays visible, not overwritten."""
    existing_label = existing_label or ""
    if not new_label or new_label in existing_label:
        return existing_label
    if not existing_label:
        return new_label
    return f"{existing_label} + {new_label}"


def build_merged_card(
    *,
    existing: dict,
    note: str,
    status: str,
    new_source_label: str,
    payload: Any = None,
    null_reason: str | None = None,
    priority: int | None = None,
) -> dict:
    """§19b's merge action. Folds new material into `existing` instead of
    creating a second card: keeps `id` (so merge_queue's own createdAt-once
    rule keeps counting the age badge from the FIRST call, not this one),
    board/group/potentialClient, and appends onto sourceLabel rather than
    replacing it. `updatedAt` is stamped to now since this card is genuinely
    being touched again -- unlike build_card's fresh cards, which don't carry
    one yet.

    Runs the same validate_payload()/parse-error path as build_card -- a bad
    merged payload still fails loud instead of shipping.
    """
    merged_label = merge_source_labels(existing.get("sourceLabel", ""), new_source_label)
    card = build_card(
        card_id=existing["id"],
        title=existing.get("title", ""),
        note=note,
        status=status,
        board=existing.get("board"),
        group=existing.get("group"),
        source=existing.get("source", "fireflies"),
        source_label=merged_label,
        priority=priority if priority is not None else existing.get("priority", 3),
        payload=payload,
        null_reason=null_reason,
        potential_client=existing.get("potentialClient"),
    )
    card["updatedAt"] = datetime.now(timezone.utc).isoformat()
    return card


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

    # §19b -- the medstation-reactivation live example: two cards, same
    # existingItemId, drafted eight days apart.
    queue = [
        {
            "id": "medstation-reactivation-whatsapp-gate",
            "status": "ready",
            "title": "Reactivation gate",
            "group": "MedStation",
            "sourceLabel": "Meeting: GHL Go Live Checkin, 8/24",
            "createdAt": "2026-08-24T12:00:00Z",
            "payload": {
                "mode": "update_only",
                "existingItemId": "12484780177",
                "itemName": "Reactivation gate",
                "updateBody": "<p>Salam,</p><ul><li>WhatsApp gate for reactivation.</li></ul>",
            },
        }
    ]
    match = find_pending_queue_match(
        existing_item_id="12484780177",
        parent_item_name=None,
        subject_text="reactivation cohort window",
        group="MedStation",
        compare_text="Reactivation cohort window",
        queue_items=queue,
    )
    assert match and match["axis"] == 1, "axis-1 existingItemId match not found"

    merged = build_merged_card(
        existing=match["card"],
        note="merged per §19b",
        status="ready",
        new_source_label="Meeting: Flow ops review, 8/26",
        payload={
            "mode": "update_only",
            "existingItemId": "12484780177",
            "itemName": "Reactivation gate",
            "updateBody": "<p>Salam,</p><ul><li>Combined WhatsApp gate and cohort window.</li></ul>",
        },
    )
    assert merged["id"] == "medstation-reactivation-whatsapp-gate", "merge must keep the original id"
    assert merged["sourceLabel"] == (
        "Meeting: GHL Go Live Checkin, 8/24 + Meeting: Flow ops review, 8/26"
    ), "sourceLabel must append, not replace"
    assert merged.get("updatedAt"), "merged card must carry a fresh updatedAt"
    print("ok    build_merged_card keeps id, appends sourceLabel, stamps updatedAt")

    conflict = build_merged_card(
        existing=match["card"],
        note="8/25: trigger is last-visit >45 days. 8/26: cohort described as "
             "3+ months inactive. These select different patient populations "
             "-- needs a decision on which trigger to use.",
        status="confirm",
        new_source_label="Meeting: Flow ops review, 8/26",
        payload=None,
        null_reason="content-conflict",
    )
    assert conflict["status"] == "confirm" and conflict["nullReason"] == "content-conflict"
    assert conflict["payload"] is None
    print("ok    build_merged_card supports the content-conflict case")

    assert merge_source_labels("Meeting A, 8/24", "Meeting A, 8/24") == "Meeting A, 8/24"
    print("ok    merge_source_labels is idempotent on a repeated label")

    # Quality HVAC alias fix -- the live split was CRM/Web+SEO's raw group
    # title ("Quality HVAC by FIbid") vs Ads/Video's ("Quality HVAC").
    assert canonical_client_name("Quality HVAC by FIbid") == "Quality HVAC"
    assert canonical_client_name("Quality HVAC") == "Quality HVAC"
    hvac_card = build_card(
        card_id="qualityhvac-something",
        title="X", note="...", status="ready", board="CRM",
        group="Quality HVAC by FIbid", source="fireflies",
        source_label="Meeting, 9/1", priority=3,
        null_reason="multi-item",
    )
    assert hvac_card["group"] == "Quality HVAC", "build_card must write the canonical name, not the raw title"
    print("ok    build_card + canonical_client_name resolve Quality HVAC by FIbid -> Quality HVAC")

    hvac_queue = [{
        "id": "qualityhvac-ads-card", "status": "ready", "title": "Meta tuneup campaign",
        "group": "Quality HVAC",
        "payload": {"mode": "create_item", "boardId": "1", "groupId": "g", "itemName": "Meta tuneup campaign",
                    "updateBody": "<p>Salam,</p><ul><li>Tune-up membership trigger campaign in Meta.</li></ul>"},
    }]
    hvac_match = find_pending_queue_match(
        existing_item_id=None, parent_item_name=None,
        subject_text="Tune-up membership trigger campaign", group="Quality HVAC by FIbid",
        compare_text="Meta tuneup campaign", queue_items=hvac_queue,
    )
    assert hvac_match and hvac_match["axis"] == 3, "axis-3 must match across the FIbid/non-FIbid spelling split"
    print("ok    find_pending_queue_match axis 3 matches across the Quality HVAC / FIbid spelling split")
