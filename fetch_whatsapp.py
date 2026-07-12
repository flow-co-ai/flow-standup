"""
fetch_whatsapp.py — Parses WhatsApp chat export .txt files from inbox/whatsapp/.
Handles both iOS and Android timestamp formats.
Run standalone to test: python fetch_whatsapp.py
"""

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

WHATSAPP_INBOX = Path("inbox/whatsapp")

# iOS format:   [MM/DD/YYYY, HH:MM:SS AM/PM] Sender: text
# Android fmt:  MM/DD/YYYY, HH:MM - Sender: text
# Some locales swap day/month — we try both.
_IOS = re.compile(
    r"^\[(\d{1,2}/\d{1,2}/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]\s+([^:]+):\s+(.*)"
)
_ANDROID = re.compile(
    r"^(\d{1,2}/\d{1,2}/\d{2,4}),\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s+-\s+([^:]+):\s+(.*)"
)

_DATE_FMTS = [
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
    "%m/%d/%y %I:%M:%S %p",
    "%m/%d/%y %I:%M %p",
    "%m/%d/%y %H:%M",
    "%d/%m/%Y %I:%M:%S %p",
    "%d/%m/%Y %I:%M %p",
    "%d/%m/%Y %H:%M",
    "%d/%m/%y %I:%M %p",
    "%d/%m/%y %H:%M",
]


def _parse_dt(date_str: str, time_str: str) -> datetime | None:
    combined = f"{date_str} {time_str}".strip()
    for fmt in _DATE_FMTS:
        try:
            dt = datetime.strptime(combined, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_chat_file(filepath: Path, days_back: int = 7) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    messages = []
    current: dict | None = None

    with open(filepath, encoding="utf-8", errors="replace") as fh:
        for raw_line in fh:
            line = raw_line.rstrip("\n")

            # Try iOS pattern
            m = _IOS.match(line) or _ANDROID.match(line)
            if m:
                date_str, time_str, sender, text = m.groups()
                dt = _parse_dt(date_str, time_str)
                if dt and dt >= cutoff:
                    current = {
                        "datetime": dt.isoformat(),
                        "sender": sender.strip(),
                        "text": text.strip(),
                    }
                    messages.append(current)
                else:
                    current = None
                continue

            # Continuation line (multi-line message)
            if current and line.strip():
                current["text"] += " " + line.strip()

    return messages


def fetch_whatsapp(days_back: int = 7) -> dict:
    """
    Returns a dict keyed by chat filename (stem), value is a list of messages.
    Returns {} if the inbox folder is empty or missing.
    """
    if not WHATSAPP_INBOX.exists():
        return {}

    txt_files = sorted(WHATSAPP_INBOX.glob("*.txt"))
    if not txt_files:
        return {}

    chats = {}
    for filepath in txt_files:
        chat_name = filepath.stem
        try:
            msgs = parse_chat_file(filepath, days_back)
            if msgs:
                chats[chat_name] = msgs
        except Exception as exc:
            chats[chat_name] = {"error": str(exc)}

    return chats


# ── standalone test ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    with open("config.json") as f:
        cfg = json.load(f)

    days_back = cfg.get("days_back", 7)
    print(f"Reading WhatsApp exports from {WHATSAPP_INBOX}  (last {days_back} days)...\n")

    txt_files = list(WHATSAPP_INBOX.glob("*.txt")) if WHATSAPP_INBOX.exists() else []
    if not txt_files:
        print("  No .txt files found — drop an export into inbox/whatsapp/ to test.")
    else:
        chats = fetch_whatsapp(days_back)
        print("── Summary ──────────────────────────")
        if not chats:
            print("  No messages found in the last 7 days.")
        else:
            for name, msgs in chats.items():
                if isinstance(msgs, dict) and "error" in msgs:
                    print(f"  ✗ {name}: {msgs['error']}")
                else:
                    print(f"  ✓ {name}: {len(msgs)} messages")
