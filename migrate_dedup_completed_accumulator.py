"""
migrate_dedup_completed_accumulator.py — one-time migration.

_is_duplicate_completion used to skip its text-similarity check whenever
either side of a pair had a Monday item id, so two differently-worded
completions of the same real work both got stored (e.g. a client's
"Reports — SEO Update May 2026" Monday item and a separately summarized
"Completed SEO Update for May 2026" line). That's fixed in generate.py now,
but the fix only prevents new duplicates — it doesn't retroactively clean
whatever already got stored in standups/completed-accumulator.json before
the fix landed.

This replays the fixed dedup rules -- including the corroborated-match rule
(same client/source/sourceDate/who lets a lower similarity floor catch
heavily-reworded mentions of the same event, e.g. "First 3 video cuts" vs
"Delivered first three video cuts for review") -- over every already-stored
week (the current week's items, plus every week already in `history`) and
drops whatever should have been caught the first time, keeping the
earliest-seen entry of each duplicate pair. Safe to re-run: each pass only
ever catches pairs the current rules recognize, so re-running after a rule
change picks up just the newly-recognized pairs.

Safety carve-out: the production fast path matches purely on
monday_item_id, without checking client — that's fine in the live pipeline
because a real Monday item only ever resolves to one client. If stored data
has the SAME monday_item_id under two DIFFERENT clients, that's a sign of a
client-attribution bug elsewhere, not something this dedup fix is about.
Rather than silently deleting one client's row on that basis, this script
leaves cross-client id collisions untouched and prints them for manual
review instead.

Delete this file after running it once — it's not part of the regular
pipeline.

Run: python migrate_dedup_completed_accumulator.py
"""

import json

from generate import (
    ACCUMULATOR_PATH,
    COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD,
    SIMILARITY_DUP_THRESHOLD,
    _text_similarity,
)


def _dedup(items: list[dict], label: str) -> list[dict]:
    kept: list[dict] = []
    for candidate in items:
        mid = candidate.get("monday_item_id")
        client = candidate.get("client")
        text = candidate.get("text", "")
        source = candidate.get("source")
        source_date = candidate.get("sourceDate")
        who = candidate.get("who")
        dropped = False
        for it in kept:
            same_mid = bool(mid and it.get("monday_item_id") and str(it["monday_item_id"]) == str(mid))
            if same_mid and it.get("client") != client:
                print(
                    f"  !! FLAGGED, NOT REMOVED — cross-client monday_item_id collision in {label}:\n"
                    f"     [{client}] {text!r} (id={candidate.get('id')})\n"
                    f"     shares monday_item_id {mid} with [{it.get('client')}] {it.get('text')!r} "
                    f"(id={it.get('id')}) — needs manual review, not an automatic dedup."
                )
                continue
            if same_mid:
                print(
                    f"  removing duplicate in {label} (same monday_item_id {mid}): "
                    f"[{client}] {text!r} (id={candidate.get('id')}) — "
                    f"kept [{it.get('client')}] {it.get('text')!r} (id={it.get('id')})"
                )
                dropped = True
                break
            if client and it.get("client") == client:
                score = _text_similarity(text, it.get("text", ""))
                if score >= SIMILARITY_DUP_THRESHOLD:
                    print(
                        f"  removing duplicate in {label} (similar text, same client {client}): "
                        f"{text!r} (id={candidate.get('id')}) — kept {it.get('text')!r} (id={it.get('id')})"
                    )
                    dropped = True
                    break
                corroborated = (
                    source and it.get("source") == source
                    and source_date and it.get("sourceDate") == source_date
                    and who == it.get("who")
                )
                if corroborated and score >= COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD:
                    print(
                        f"  removing duplicate in {label} (corroborated: same source/date/who, "
                        f"score {score:.3f}, same client {client}): "
                        f"{text!r} (id={candidate.get('id')}) — kept {it.get('text')!r} (id={it.get('id')})"
                    )
                    dropped = True
                    break
        if not dropped:
            kept.append(candidate)
    return kept


def main():
    acc = json.loads(ACCUMULATOR_PATH.read_text(encoding="utf-8"))

    before = len(acc.get("items", []))
    acc["items"] = _dedup(acc.get("items", []), acc.get("isoWeek") or "current week")
    print(f"{acc.get('isoWeek')}: {before} -> {len(acc['items'])} items")

    for wk in acc.get("history", []):
        wk_before = len(wk.get("items", []))
        wk["items"] = _dedup(wk.get("items", []), wk.get("isoWeek") or "history week")
        if wk_before != len(wk["items"]):
            print(f"history {wk.get('isoWeek')}: {wk_before} -> {len(wk['items'])} items")

    ACCUMULATOR_PATH.write_text(json.dumps(acc, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {ACCUMULATOR_PATH}")


if __name__ == "__main__":
    main()
