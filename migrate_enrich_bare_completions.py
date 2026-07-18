"""
migrate_enrich_bare_completions.py — one-time migration.

summarize_monday_done used to accept whatever the model returned even when
it was just the raw Monday item title restated (e.g. "LSA") -- exactly the
"site just listing Monday titles verbatim" outcome its own prompt asks it
to avoid. That's fixed in generate.py now (_looks_like_bare_title +
_fallback_completion_text), but the fix only changes what NEW completions
look like -- items already in standups/completed-accumulator.json keep
their bare text forever, since their monday_item_id is already in
monday_ids_seen and will never be re-summarized.

This applies the same fallback rule retroactively to the small, explicitly
reviewed set of already-stored MON completions identified as bare titles
(compared against the item name recorded alongside each -- there's no
general "is this bare" heuristic here, this is a fixed, reviewed list, not
a blind rescan). For each: real recent-update text from
archive/monday_updates/*.jsonl if there's a substantive one that doesn't
read like a task request/question, else a clearly-flagged (generated=true)
placeholder -- never leaving a bare, unflagged title in place.

Delete this file after running it once — it's not part of the regular
pipeline.

Run: python migrate_enrich_bare_completions.py
"""

import json
from pathlib import Path

from generate import (
    ACCUMULATOR_PATH,
    _fallback_completion_text,
)

ARCHIVE_DIR = Path("archive") / "monday_updates"

# Reviewed by hand against the current accumulator (see the commit message
# for how each was identified) -- keyed by monday_item_id, since that's the
# stable identifier; `text` is the exact bare string to replace, as a
# safety check against updating the wrong record if the file has drifted.
BARE_ITEMS = {
    "11929347398": {"client": "Full Smile", "item_name": "LSA", "text": "LSA"},
    "12442817624": {"client": "Flow Company", "item_name": "Meta Ads", "text": "Meta Ads"},
    "12322759942": {"client": "Liferun", "item_name": "Checkout Page Update", "text": "Checkout Page Update"},
    "12161338081": {"client": "Justice Consumer Law", "item_name": "Reports — SEO Update May 2026", "text": "Reports — SEO Update May 2026"},
    "12161295508": {"client": "Full Smile", "item_name": "Reports — SEO Update May 2026", "text": "Reports — SEO Update May 2026"},
    "12161320381": {"client": "Liferun", "item_name": "Reports — SEO Update May 2026", "text": "Reports — SEO Update May 2026"},
    "12167444682": {"client": "Quality HVAC", "item_name": "Reports — SEO Update May 2026", "text": "Reports — SEO Update May 2026"},
    "12482218579": {"client": "Maadi Law", "item_name": "Website — First Draft", "text": "Website — First Draft"},
}


def _load_recent_updates(item_id: str) -> list[dict]:
    updates = []
    if not ARCHIVE_DIR.exists():
        return updates
    for path in sorted(ARCHIVE_DIR.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            if rec.get("item_id") == item_id:
                updates.append({"body": rec.get("body", ""), "created_at": rec.get("created_at", "")})
    return updates


def main():
    acc = json.loads(ACCUMULATOR_PATH.read_text(encoding="utf-8"))

    weeks = [acc] + list(acc.get("history", []))
    changed = 0
    for week in weeks:
        for it in week.get("items", []):
            mid = str(it.get("monday_item_id") or "")
            spec = BARE_ITEMS.get(mid)
            if not spec or it.get("client") != spec["client"] or it.get("text") != spec["text"]:
                continue
            recent_updates = _load_recent_updates(mid)
            new_text, generated = _fallback_completion_text(spec["item_name"], [], recent_updates)
            print(f"[{it['client']}] {it['text']!r} -> {new_text!r} (generated={generated})")
            it["text"] = new_text
            it["generated"] = generated
            it["id"] = it["id"]  # id is a hash of (client, OLD text) -- left as-is, it's just a bookkeeping key
            changed += 1

    if changed:
        ACCUMULATOR_PATH.write_text(json.dumps(acc, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote {ACCUMULATOR_PATH} ({changed} item(s) enriched)")
    else:
        print("Nothing matched -- accumulator may already be migrated, or has drifted since this script was written.")


if __name__ == "__main__":
    main()
