"""
fetch_fireflies.py — Pulls meeting transcripts from Fireflies.ai.
Run standalone to test: python fetch_fireflies.py
"""

import os
import json
import requests
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv

load_dotenv()

FIREFLIES_API_URL = "https://api.fireflies.ai/graphql"


def _key():
    k = os.environ.get("FIREFLIES_API_KEY", "")
    if not k:
        raise ValueError("FIREFLIES_API_KEY is not set")
    return k


def _headers():
    return {
        "Authorization": f"Bearer {_key()}",
        "Content-Type": "application/json",
    }


def _post(query: str, variables: dict) -> dict:
    resp = requests.post(
        FIREFLIES_API_URL,
        headers=_headers(),
        json={"query": query, "variables": variables},
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    if "errors" in payload:
        raise ValueError(f"Fireflies API errors: {payload['errors']}")
    return payload


def _fetch_sentences(transcript_id: str) -> list:
    query = """
    query GetSentences($id: String!) {
      transcript(id: $id) {
        sentences {
          speaker_name
          text
          start_time
        }
      }
    }
    """
    payload = _post(query, {"id": transcript_id})
    return (
        (payload.get("data") or {})
        .get("transcript", {})
        .get("sentences", [])
    )


def fetch_transcripts(days_back: int = 7) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    # Fireflies accepts fromDate as "YYYY-MM-DD"
    from_date = cutoff.strftime("%Y-%m-%d")

    query = """
    query GetTranscripts($fromDate: String) {
      transcripts(fromDate: $fromDate) {
        id
        title
        date
        participants
        summary {
          overview
          action_items
          keywords
        }
      }
    }
    """

    payload = _post(query, {"fromDate": from_date})
    raw = (payload.get("data") or {}).get("transcripts", []) or []

    results = []
    for t in raw:
        summary = t.get("summary") or {}
        has_summary = bool(
            summary.get("overview")
            or summary.get("action_items")
            or summary.get("keywords")
        )

        entry = {
            "id": t.get("id"),
            "title": t.get("title") or "Untitled",
            "date": t.get("date") or "",
            "participants": t.get("participants") or [],
            "summary": summary,
        }

        # Only fetch full sentences when summary is completely missing
        if not has_summary and entry["id"]:
            try:
                sentences = _fetch_sentences(entry["id"])
                # Cap at 60 sentences to keep the prompt manageable
                entry["sentences"] = sentences[:60]
            except Exception as exc:
                entry["sentences_error"] = str(exc)

        results.append(entry)

    return results


# ── standalone test ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    with open("config.json") as f:
        cfg = json.load(f)

    days_back = cfg.get("days_back", 7)
    print(f"Fetching Fireflies transcripts from the last {days_back} days...\n")

    try:
        transcripts = fetch_transcripts(days_back)
        print(f"── Summary ──────────────────────────")
        print(f"  Meetings found: {len(transcripts)}")
        for t in transcripts:
            summary = t.get("summary") or {}
            has_s = bool(summary.get("overview") or summary.get("action_items"))
            fallback = " [sentences fallback]" if "sentences" in t else ""
            print(f"  - {t['title']}  ({t.get('date', 'no date')})  summary={'yes' if has_s else 'no'}{fallback}")
    except Exception as exc:
        print(f"Error: {exc}")
