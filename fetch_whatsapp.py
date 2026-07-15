"""
fetch_whatsapp.py — Parses WhatsApp chat export .txt files from inbox/whatsapp/
and optionally from a Google Drive folder (whatsapp_drive_folder_id in config.json).
Handles both iOS and Android timestamp formats.
Run standalone to test: python fetch_whatsapp.py
"""

import io
import json
import os
import re
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

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


def _parse_lines(lines, days_back: int = 7) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    messages = []
    current: dict | None = None
    for raw_line in lines:
        line = raw_line.rstrip("\n")
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
        if current and line.strip():
            current["text"] += " " + line.strip()
    return messages


def parse_chat_file(filepath: Path, days_back: int = 7) -> list:
    with open(filepath, encoding="utf-8", errors="replace") as fh:
        return _parse_lines(fh, days_back)


def fetch_whatsapp_drive(config: dict, days_back: int = 7) -> dict:
    """
    Download and parse WhatsApp .txt exports from the Drive folder
    specified by whatsapp_drive_folder_id in config. Returns {} on any failure.
    """
    folder_id = config.get("whatsapp_drive_folder_id", "")
    sa_json_str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not folder_id or not sa_json_str:
        return {}

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload

        creds = service_account.Credentials.from_service_account_info(
            json.loads(sa_json_str),
            scopes=["https://www.googleapis.com/auth/drive.readonly"],
        )
        service = build("drive", "v3", credentials=creds, cache_discovery=False)

        # No mimetype filter — WhatsApp exports arrive as .txt OR .zip
        # (iOS "Export Chat" often produces a zip), and Drive mimetypes vary.
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="files(id, name, mimeType)",
            pageSize=100,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()

        chats = {}
        for file in resp.get("files", []):
            name = file["name"]
            lower = name.lower()
            if not (lower.endswith(".txt") or lower.endswith(".zip")):
                continue
            chat_name = Path(name).stem
            try:
                buf = io.BytesIO()
                downloader = MediaIoBaseDownload(
                    buf, service.files().get_media(fileId=file["id"], supportsAllDrives=True)
                )
                done = False
                while not done:
                    _, done = downloader.next_chunk()
                raw = buf.getvalue()

                texts = []  # (chat_name, content)
                if lower.endswith(".zip"):
                    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                        for zname in zf.namelist():
                            if zname.lower().endswith(".txt"):
                                inner = zf.read(zname).decode("utf-8", errors="replace")
                                texts.append((chat_name, inner))
                    if not texts:
                        print(f"    ⚠️  '{name}': zip contains no .txt")
                        continue
                else:
                    texts.append((chat_name, raw.decode("utf-8", errors="replace")))

                for cname, content in texts:
                    lines = content.splitlines(keepends=True)
                    msgs = _parse_lines(lines, days_back)
                    total_lines = sum(
                        1 for ln in lines
                        if _IOS.match(ln.rstrip("\n")) or _ANDROID.match(ln.rstrip("\n"))
                    )
                    print(f"    '{cname}': {total_lines} messages in file, "
                          f"{len(msgs)} within last {days_back}d"
                          + ("" if total_lines else "  ⚠️ format not recognised"))
                    if msgs:
                        chats[cname] = msgs
            except Exception as exc:
                print(f"    ⚠️  '{name}': {exc}")
                chats[chat_name] = {"error": str(exc)}

        return chats
    except Exception as exc:
        print(f"  ⚠️  Drive WhatsApp unavailable: {exc}")
        return {}


def fetch_whatsapp(days_back: int = 7, config: dict | None = None) -> dict:
    """
    Returns a dict keyed by chat name, value is a list of messages.
    Reads local inbox/whatsapp/ first, then merges Drive results (Drive wins on conflict).
    """
    local_chats: dict = {}
    if WHATSAPP_INBOX.exists():
        for filepath in sorted(WHATSAPP_INBOX.glob("*.txt")):
            chat_name = filepath.stem
            try:
                msgs = parse_chat_file(filepath, days_back)
                if msgs:
                    local_chats[chat_name] = msgs
            except Exception as exc:
                local_chats[chat_name] = {"error": str(exc)}

    drive_chats: dict = {}
    if config:
        drive_chats = fetch_whatsapp_drive(config, days_back)

    return {**local_chats, **drive_chats}


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
