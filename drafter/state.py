"""
state.py -- GitHub Contents API access for the draft queue and drafter state.

Replaces two laptop-bound paths:
  ~/Claude/memory/projects/fireflies-monday-state.json  ->  checks/drafter-state.json
  ~/Claude/flow-ops-addon/.env (GH_TOKEN/GH_REPO/GH_BRANCH)  ->  Actions secrets

Both files live on the `state` branch, the same place draft-queue.json already
lives and the same credential generate.py already uses for
standups/completed-accumulator.json. No new secret is needed.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.github.com"

REPO = os.environ.get("GH_REPO", "flow-co-ai/flow-standup")
BRANCH = os.environ.get("GH_BRANCH", "state")
TOKEN = os.environ.get("GH_STATE_TOKEN") or os.environ.get("GH_TOKEN", "")

QUEUE_PATH = "checks/draft-queue.json"
STATE_PATH = "checks/drafter-state.json"


class PushFailed(RuntimeError):
    """A read or write against the state branch failed. Callers must stop."""


def _request(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    url = f"{API}/repos/{REPO}/contents/{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "flow-standup-drafter")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def read_json(path: str, default: dict | list) -> tuple[dict | list, str | None]:
    """Return (content, sha). A 404 yields (default, None)."""
    status, body = _request("GET", f"{path}?ref={BRANCH}")
    if status == 404:
        return default, None
    if status != 200:
        raise PushFailed(f"GET {path} returned {status}: {body.get('message')}")
    raw = base64.b64decode(body["content"]).decode()
    return json.loads(raw), body["sha"]


def write_json(path: str, content: dict | list, sha: str | None, message: str) -> str:
    """PUT and confirm the commit actually landed. Returns the new sha."""
    payload = {
        "message": message,
        "content": base64.b64encode(
            json.dumps(content, indent=2).encode()
        ).decode(),
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha
    status, body = _request("PUT", path, payload)
    if status not in (200, 201) or not body.get("commit", {}).get("sha"):
        raise PushFailed(f"PUT {path} returned {status}: {body.get('message')}")
    return body["content"]["sha"]


def preflight() -> None:
    """A0b -- prove we can read AND write before doing any drafting work.

    Added 2026-08-13 after GH_TOKEN silently 401'd for five days and two full
    runs of drafting work were lost. A run that cannot push must leave state
    exactly as it found it so the next run re-processes the same window cleanly.
    """
    if not TOKEN:
        raise PushFailed("no GH_STATE_TOKEN/GH_TOKEN in environment")
    queue, sha = read_json(QUEUE_PATH, {"updatedAt": None, "items": []})
    write_json(QUEUE_PATH, queue, sha, "drafter: write-path preflight (no-op)")


def load_state() -> dict:
    state, _ = read_json(STATE_PATH, {})
    if not state:
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        state = {
            "lastCheckedISO": yesterday.isoformat(),
            "processedIds": [],
            "lastArchivedWeek": None,
            "whatsappHighWaterMark": {},
        }
    return state


def save_state(state: dict) -> None:
    """A5 -- only ever called after the queue push is confirmed."""
    _, sha = read_json(STATE_PATH, {})
    write_json(STATE_PATH, state, sha, "drafter: commit run state")
