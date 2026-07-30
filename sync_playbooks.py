"""
sync_playbooks.py — Syncs playbook documents from Google Drive into playbooks/[slug].md.

Mirrors fetch_whatsapp.py's Drive pattern exactly:
  - service_account from GOOGLE_SERVICE_ACCOUNT_JSON env var
  - drive v3, supportsAllDrives=True, includeItemsFromAllDrives=True (Shared Drive)

File handling:
  - Google Docs  → export as text/plain
  - .md / .txt   → download directly
  - .pdf         → skip with a warning

Matching: file stem → client slug via fuzzy name matching against clients.json.

ALIAS MAP: the three steel sub-slugs (and the legacy "Steel Round Bars" name)
all write to playbooks/steel-round-bars.md — one canonical playbook for the
engagement timeline regardless of the three-pulse split.

Writes playbooks/[slug].md only when the content hash has changed.
"""

import hashlib
import io
import json
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PLAYBOOKS_DIR = Path("playbooks")

# Steel sub-slugs and the legacy combined slug all resolve to this one file.
STEEL_CANONICAL = "steel-round-bars"
STEEL_SLUGS = {"steel-forte", "steel-advance", "steel-ohare", "steel-round-bars"}


# ── slug matching ─────────────────────────────────────────────────────────────

# Checked before fuzzy clients.json matching.
# Value is the canonical slug to write, or None to skip silently.
ALIASES: dict[str, str | None] = {
    "jcl":          "jcl",
    "steel-group":  "steel-round-bars",
    "medstation":   None,   # pending client — skip silently
}


def _normalize_stem(stem: str) -> str:
    """Lowercase and strip the '-department-playbooks' boilerplate suffix."""
    s = stem.lower().strip()
    s = re.sub(r"\s*[-–]\s*department\s*playbooks?\s*$", "", s, flags=re.IGNORECASE)
    return s.strip()


def _norm(s: str) -> str:
    """Lowercase, strip non-alphanumeric — used for fuzzy comparison."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _stem_to_slug(stem: str, clients: list) -> str | None:
    """
    Map a Drive file stem to a pulse slug.

    Matching priority:
      1. Exact slug match (case-insensitive, non-alphanumeric stripped)
      2. Exact client name match (same normalisation)
      3. Normalised stem contains normalised name (or vice-versa)

    Returns the slug string, or None if nothing matches.
    """
    n_stem = _norm(stem)

    # Exact slug match first.
    for c in clients:
        if n_stem == _norm(c["slug"]):
            return c["slug"]

    # Exact name match.
    for c in clients:
        if n_stem == _norm(c["name"]):
            return c["slug"]

    # Substring fuzzy match (name contained in stem or stem contained in name).
    for c in clients:
        n_name = _norm(c["name"])
        if n_name and (n_name in n_stem or n_stem in n_name):
            return c["slug"]

    return None


def _apply_alias(slug: str) -> str:
    """Collapse all steel sub-slugs into the single canonical timeline slug."""
    return STEEL_CANONICAL if slug in STEEL_SLUGS else slug


# ── hash helper ───────────────────────────────────────────────────────────────

def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_existing(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


# ── main sync ─────────────────────────────────────────────────────────────────

def sync_playbooks() -> None:
    print("=== Sync playbooks from Drive ===")

    # Load config and clients.
    with open("config.json") as f:
        config = json.load(f)

    with open("clients.json") as f:
        clients = json.load(f)

    folder_id = config.get("playbooks_drive_folder_id", "")
    sa_json_str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")

    if not folder_id:
        print("  playbooks_drive_folder_id not set in config.json — skipping")
        return
    if not sa_json_str:
        print("  GOOGLE_SERVICE_ACCOUNT_JSON not set — skipping")
        return

    PLAYBOOKS_DIR.mkdir(exist_ok=True)

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload

        creds = service_account.Credentials.from_service_account_info(
            json.loads(sa_json_str),
            scopes=["https://www.googleapis.com/auth/drive.readonly"],
        )
        service = build("drive", "v3", credentials=creds, cache_discovery=False)

        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="files(id, name, mimeType)",
            pageSize=100,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()

    except Exception as exc:
        print(f"  Drive unavailable: {exc}")
        return

    written = skipped = unchanged = warned = 0

    for file in resp.get("files", []):
        file_id = file["id"]
        name    = file["name"]
        mime    = file["mimeType"]

        is_gdoc = mime == "application/vnd.google-apps.document"
        is_text = name.lower().endswith((".md", ".txt", ".markdown"))
        is_pdf  = name.lower().endswith(".pdf") or mime == "application/pdf"

        if is_pdf:
            print(f"  ⚠️  '{name}': PDF skipped (convert to Google Doc or .md)")
            warned += 1
            continue

        if not (is_gdoc or is_text):
            continue

        # Strip extension then normalise stem.
        stem = name
        for ext in (".md", ".txt", ".markdown"):
            if name.lower().endswith(ext):
                stem = name[: -len(ext)]
                break
        norm_stem = _normalize_stem(stem)

        # ALIASES checked first (exact normalised key match).
        if norm_stem in ALIASES:
            alias_val = ALIASES[norm_stem]
            if alias_val is None:
                skipped += 1   # silent — pending client
                continue
            slug = alias_val
        else:
            slug = _stem_to_slug(norm_stem, clients) or _stem_to_slug(stem, clients)
            if slug is None:
                print(f"  ⚠️  '{name}': no client match — skipped")
                warned += 1
                continue
            slug = _apply_alias(slug)
        out_path = PLAYBOOKS_DIR / f"{slug}.md"

        # Fetch content.
        try:
            if is_gdoc:
                raw = service.files().export(
                    fileId=file_id, mimeType="text/plain"
                ).execute()
                content = raw.decode("utf-8", errors="replace").strip()
            else:
                buf = io.BytesIO()
                downloader = MediaIoBaseDownload(
                    buf,
                    service.files().get_media(fileId=file_id, supportsAllDrives=True),
                )
                done = False
                while not done:
                    _, done = downloader.next_chunk()
                content = buf.getvalue().decode("utf-8", errors="replace").strip()
        except Exception as exc:
            print(f"  ⚠️  '{name}': download failed — {exc}")
            warned += 1
            continue

        if not content:
            print(f"  ⚠️  '{name}': empty after fetch — skipped")
            warned += 1
            continue

        # Write only if hash changed.
        existing = _read_existing(out_path)
        if existing is not None and _sha256(existing) == _sha256(content):
            print(f"  = '{name}' → {slug}.md (unchanged)")
            unchanged += 1
        else:
            out_path.write_text(content, encoding="utf-8")
            action = "updated" if existing is not None else "new"
            print(f"  ✓ '{name}' → {slug}.md ({action})")
            written += 1

    print(
        f"\nDone: {written} written, {unchanged} unchanged, "
        f"{warned} warned, {skipped} skipped."
    )


if __name__ == "__main__":
    sync_playbooks()
