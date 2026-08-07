"""
remove_test_completions.py — strips test/junk entries out of
standups/completed-accumulator.json by monday_item_id, so webhook tests
never show up on the live standup page.

Edit IDS_TO_REMOVE below, then run:
    python remove_test_completions.py
Needs env var: GH_STATE_TOKEN
"""

import base64
import json
import os
import time

import requests
from dotenv import load_dotenv

load_dotenv()

GITHUB_REPO = "flow-co-ai/flow-standup"
ACCUMULATOR_PATH = "standups/completed-accumulator.json"

# <-- EDIT THIS: add every test item's monday_item_id here
IDS_TO_REMOVE = ["12741783775", "12741900125"]


def _gh_headers():
    return {
        "Authorization": f"Bearer {os.environ['GH_STATE_TOKEN']}",
        "Accept": "application/vnd.github+json",
    }


def get_accumulator():
    resp = requests.get(
        f"https://api.github.com/repos/{GITHUB_REPO}/contents/{ACCUMULATOR_PATH}?ref=main",
        headers=_gh_headers(),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    content = json.loads(base64.b64decode(data["content"]).decode("utf-8"))
    return content, data["sha"]


def put_accumulator(content, sha, message):
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


def strip(acc, ids):
    # monday_ids_seen is deliberately left untouched (Naz, 2026-08-06): these
    # are near-certainly test fixtures that will sit marked "Done" on Monday
    # forever (nobody bothers reverting a throwaway test item's status).
    # Stripping their ids from monday_ids_seen would make generate.py's own
    # collect_monday_done_candidates() treat them as never-seen on the very
    # next run and re-add the exact entry being removed here. Removing only
    # the display entries (items/history) while keeping the id marked
    # "already handled" is what actually makes this stick.
    removed = []
    acc["items"] = [
        it for it in acc.get("items", [])
        if not (it.get("monday_item_id") in ids and (removed.append(it) or True))
    ]
    for wk in acc.get("history", []):
        wk["items"] = [
            it for it in wk.get("items", [])
            if not (it.get("monday_item_id") in ids and (removed.append(it) or True))
        ]
    return removed


def main():
    for attempt in range(1, 6):
        acc, sha = get_accumulator()
        removed = strip(acc, set(IDS_TO_REMOVE))
        if not removed:
            print("Nothing matching those ids found. Nothing to do.")
            return
        for r in removed:
            print(f"  - removing: {r.get('client')} / {r.get('text')} ({r.get('monday_item_id')})")

        resp = put_accumulator(acc, sha, f"cleanup: remove {len(removed)} test completion(s)")
        if resp.status_code in (200, 201):
            print(f"\nRemoved {len(removed)} test entr{'y' if len(removed)==1 else 'ies'}.")
            return
        if resp.status_code == 409:
            print(f"Conflict (attempt {attempt}/5), retrying...")
            time.sleep(1.5 * attempt)
            continue
        resp.raise_for_status()

    raise RuntimeError("Gave up after 5 conflicting writes")


if __name__ == "__main__":
    main()
