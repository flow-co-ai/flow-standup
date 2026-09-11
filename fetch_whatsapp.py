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


def _parse_lines(lines) -> list:
    messages = []
    current: dict | None = None
    for raw_line in lines:
        line = raw_line.rstrip("\n")
        m = _IOS.match(line) or _ANDROID.match(line)
        if m:
            date_str, time_str, sender, text = m.groups()
            dt = _parse_dt(date_str, time_str)
            if dt:
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


def parse_chat_file(filepath: Path) -> list:
    with open(filepath, encoding="utf-8", errors="replace") as fh:
        return _parse_lines(fh)


def _canonical_name(stem: str) -> str:
    """Strip trailing date suffix like ' 2026-08-19' so dated snapshots merge with the base file."""
    return re.sub(r"\s+\d{4}-\d{2}-\d{2}$", "", stem)


def _dedup_sort(msgs: list) -> list:
    seen: set = set()
    out = []
    for m in msgs:
        key = (m["datetime"], m["sender"], m["text"])
        if key not in seen:
            seen.add(key)
            out.append(m)
    out.sort(key=lambda m: m["datetime"])
    return out


class WhatsAppConfigError(RuntimeError):
    """The config/credential path failed -- fatal, never swallowed into {}.

    A missing secret or a broken folder id means the WHOLE mechanism is
    broken, not that there's nothing new to report -- and a silent {} reads
    as exactly the same thing as a genuinely quiet week. That's what let the
    2026-08-18 port's WhatsApp gap run 34 days unnoticed: draft-queue.yml
    never had GOOGLE_SERVICE_ACCOUNT_JSON set, this function returned {}
    either way, and nothing downstream could tell the difference. Per-file
    problems (a corrupt zip, undecodable text) are NOT this -- those stay
    warn-and-skip inside the loop below, same as always.
    """


def _collect_drive_raw(config: dict) -> dict:
    """
    Auth against Drive, list both live and processed folders, parse all txt/zip files.
    Returns {canonical_chat_name: [all_parsed_msgs]} (undeduped, unsorted).
    Raises WhatsAppConfigError on auth/config failure.
    Per-file failures are warned and skipped.
    """
    folder_id = config.get("whatsapp_drive_folder_id", "")
    processed_folder_id = config.get("whatsapp_processed_folder_id", "")
    sa_json_str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not folder_id:
        raise WhatsAppConfigError("whatsapp_drive_folder_id is not set in config.json")
    if not sa_json_str:
        raise WhatsAppConfigError("GOOGLE_SERVICE_ACCOUNT_JSON is not set in the environment")

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload

        creds = service_account.Credentials.from_service_account_info(
            json.loads(sa_json_str),
            scopes=["https://www.googleapis.com/auth/drive.readonly"],
        )
        service = build("drive", "v3", credentials=creds, cache_discovery=False)

        def _list(fid: str) -> list:
            return service.files().list(
                q=f"'{fid}' in parents and trashed = false",
                fields="files(id, name, mimeType)",
                pageSize=100,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            ).execute().get("files", [])

        files = _list(folder_id)
        if processed_folder_id:
            files += _list(processed_folder_id)
    except WhatsAppConfigError:
        raise
    except Exception as exc:
        raise WhatsAppConfigError(f"Drive auth/listing failed: {exc}") from exc

    raw: dict[str, list] = {}
    for file in files:
        name = file["name"]
        lower = name.lower()
        if not (lower.endswith(".txt") or lower.endswith(".zip")):
            continue
        canonical = _canonical_name(Path(name).stem)
        try:
            buf = io.BytesIO()
            downloader = MediaIoBaseDownload(
                buf, service.files().get_media(fileId=file["id"], supportsAllDrives=True)
            )
            done = False
            while not done:
                _, done = downloader.next_chunk()
            raw_bytes = buf.getvalue()

            texts = []
            if lower.endswith(".zip"):
                with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
                    for zname in zf.namelist():
                        if zname.lower().endswith(".txt"):
                            texts.append(zf.read(zname).decode("utf-8", errors="replace"))
                if not texts:
                    print(f"    ⚠️  '{name}': zip contains no .txt")
                    continue
            else:
                texts.append(raw_bytes.decode("utf-8", errors="replace"))

            for content in texts:
                raw.setdefault(canonical, []).extend(
                    _parse_lines(content.splitlines(keepends=True))
                )
        except Exception as exc:
            print(f"    ⚠️  '{name}': {exc}")

    return raw


def fetch_whatsapp_drive(config: dict, days_back: int = 7) -> dict:
    """
    Download and parse WhatsApp .txt exports from the Drive folders
    specified by whatsapp_drive_folder_id and whatsapp_processed_folder_id in config.

    Raises WhatsAppConfigError if the live folder id or service-account secret is
    missing, or if auth/listing against Drive fails outright. Callers (the
    drafter via SKILL.md A4, generate.py) are expected to let this propagate
    as a hard failure, not catch-and-degrade -- see the class docstring for
    why a quiet {} here is never safe.
    """
    raw = _collect_drive_raw(config)
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()

    chats = {}
    for chat in sorted(raw):
        msgs = _dedup_sort(raw[chat])
        within = [m for m in msgs if m["datetime"] >= cutoff_iso]
        first = msgs[0]["datetime"][:10] if msgs else "-"
        last = msgs[-1]["datetime"][:10] if msgs else "-"
        print(
            f"    '{chat}': {len(msgs)} unique messages, "
            f"{first} to {last}, {len(within)} in last {days_back}d"
        )
        if within:
            chats[chat] = within
    return chats


def fetch_whatsapp_history(config: dict) -> dict:
    """
    Returns full deduped, sorted WhatsApp history from both Drive folders with no date window.
    """
    raw = _collect_drive_raw(config)
    return {chat: _dedup_sort(msgs) for chat, msgs in raw.items()}


def fetch_whatsapp(days_back: int = 7, config: dict | None = None) -> dict:
    """
    Returns a dict keyed by chat name, value is a list of messages.
    Reads local inbox/whatsapp/ first, then merges Drive results (Drive wins on conflict).
    """
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()

    local_chats: dict = {}
    if WHATSAPP_INBOX.exists():
        for filepath in sorted(WHATSAPP_INBOX.glob("*.txt")):
            chat_name = filepath.stem
            try:
                msgs = [m for m in parse_chat_file(filepath) if m["datetime"] >= cutoff_iso]
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
