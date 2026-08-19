"""
sync_playbooks.py — Syncs playbook documents from Google Drive into playbooks/[slug].md.

Auth mirrors fetch_whatsapp.py: service account from GOOGLE_SERVICE_ACCOUNT_JSON.
Drive list/get calls use supportsAllDrives=True and includeItemsFromAllDrives=True.

Idempotency: modifiedTime is stored in an HTML comment on line 1 of each file.
Subsequent runs skip the export when modifiedTime is unchanged.

Unmatched docs are saved to playbooks/_unmatched/[sanitized-name].md.
"""

import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PLAYBOOKS_DIR = Path("playbooks")
UNMATCHED_DIR = PLAYBOOKS_DIR / "_unmatched"

# Steel sub-slugs all map to the single canonical timeline slug.
STEEL_CANONICAL = "steel-round-bars"
STEEL_SLUGS = {"steel-forte", "steel-advance", "steel-ohare", "steel-round-bars"}

# Checked before fuzzy clients.json matching.
# Value is the canonical slug to write, or None to skip silently.
ALIASES: dict[str, str | None] = {
    "jcl": "jcl",
    "steel-group": "steel-round-bars",
}


def _normalize_stem(stem: str) -> str:
    s = stem.lower().strip()
    s = re.sub(r"\s*[-–]?\s*(?:department\s*)?playbooks?\s*$", "", s, flags=re.IGNORECASE)
    return s.strip()


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _canonical_to_slug(canonical: str, clients: list) -> str:
    """Map a config.json canonical client name to a clients.json slug, falling
    back to a slugified version of the canonical name for clients (e.g.
    MedStation) that don't have a clients.json entry yet."""
    n_canon = _norm(canonical)
    for c in clients:
        if n_canon == _norm(c["slug"]) or n_canon == _norm(c["name"]):
            return c["slug"]
    for c in clients:
        n_name = _norm(c["name"])
        if n_name and (n_name in n_canon or n_canon in n_name):
            return c["slug"]
    return _sanitize_filename(canonical)


def _build_alias_candidates(config: dict, clients: list) -> list:
    """(alias, slug) pairs from config.json's per-client alias arrays,
    longest-alias-first so e.g. 'Steel Round Bars' is tried before 'Steel'."""
    pairs = []
    for canonical, aliases in config.get("clients", {}).items():
        slug = _canonical_to_slug(canonical, clients)
        for alias in aliases:
            pairs.append((alias, slug))
    pairs.sort(key=lambda p: len(p[0]), reverse=True)
    return pairs


def _alias_matches(alias: str, text: str) -> bool:
    """Word-boundary-aware match: 'Steel' must match as a whole word, not as
    a substring of an unrelated longer word."""
    text = re.sub(r"\s+", " ", text.lower()).strip()
    variants = {alias.lower().strip()}
    variants.add(re.sub(r"\s+", "", alias.lower().strip()))
    for v in variants:
        if v and re.search(rf"(?<!\w){re.escape(v)}(?!\w)", text):
            return True
    return False


def _stem_to_slug(stem: str, clients: list, alias_candidates: list = ()) -> str | None:
    n_stem = _norm(stem)
    for c in clients:
        if n_stem == _norm(c["slug"]):
            return c["slug"]
    for c in clients:
        if n_stem == _norm(c["name"]):
            return c["slug"]
    for c in clients:
        n_name = _norm(c["name"])
        if n_name and (n_name in n_stem or n_stem in n_name):
            return c["slug"]
    for alias, slug in alias_candidates:
        if _alias_matches(alias, stem):
            return slug
    return None


def _apply_alias(slug: str) -> str:
    return STEEL_CANONICAL if slug in STEEL_SLUGS else slug


def _sanitize_filename(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def _read_modified_time(path: Path) -> str | None:
    try:
        first_line = path.read_text(encoding="utf-8").split("\n", 1)[0]
        m = re.match(r"<!-- modifiedTime: (.+?) -->", first_line)
        return m.group(1) if m else None
    except FileNotFoundError:
        return None


def sync_playbooks() -> None:
    print("=== Sync playbooks from Drive ===")

    sa_json_str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not sa_json_str:
        print("  GOOGLE_SERVICE_ACCOUNT_JSON not set — skipping")
        return

    with open("config.json") as f:
        config = json.load(f)

    with open("clients.json") as f:
        clients = json.load(f)

    alias_candidates = _build_alias_candidates(config, clients)

    folder_id = config.get("playbooks_drive_folder_id", "")
    if not folder_id:
        print("  playbooks_drive_folder_id not set in config.json — skipping")
        return

    PLAYBOOKS_DIR.mkdir(exist_ok=True)
    UNMATCHED_DIR.mkdir(exist_ok=True)

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
            fields="files(id, name, mimeType, modifiedTime)",
            pageSize=100,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()

    except Exception as exc:
        print(f"  Drive unavailable: {exc}")
        return

    synced = skipped = unmatched_count = 0
    unmatched_names: list[str] = []

    for file in resp.get("files", []):
        file_id       = file["id"]
        name          = file["name"]
        mime          = file["mimeType"]
        modified_time = file.get("modifiedTime", "")

        is_gdoc = mime == "application/vnd.google-apps.document"
        is_md   = mime == "text/markdown" or name.lower().endswith((".md", ".markdown"))
        is_pdf  = mime == "application/pdf" or name.lower().endswith(".pdf")

        if is_pdf:
            print(f"  ⚠️  '{name}': PDF — skipped")
            continue
        if not (is_gdoc or is_md):
            print(f"  note: '{name}' ({mime}) — skipped")
            continue

        # Strip any extension, then normalise stem.
        stem = name
        for ext in (".md", ".txt", ".markdown"):
            if name.lower().endswith(ext):
                stem = name[: -len(ext)]
                break
        norm_stem = _normalize_stem(stem)

        # Determine output path.
        if norm_stem in ALIASES:
            alias_val = ALIASES[norm_stem]
            if alias_val is None:
                continue  # pending client — silent skip
            out_path = PLAYBOOKS_DIR / f"{alias_val}.md"
            is_unmatched = False
        else:
            slug = (
                _stem_to_slug(norm_stem, clients, alias_candidates)
                or _stem_to_slug(stem, clients, alias_candidates)
            )
            if slug is None:
                safe = _sanitize_filename(stem)
                out_path = UNMATCHED_DIR / f"{safe}.md"
                is_unmatched = True
                unmatched_count += 1
                unmatched_names.append(name)
            else:
                slug = _apply_alias(slug)
                out_path = PLAYBOOKS_DIR / f"{slug}.md"
                is_unmatched = False

        # Idempotency: skip if modifiedTime unchanged.
        existing_mt = _read_modified_time(out_path)
        if existing_mt == modified_time and modified_time:
            rel = out_path.relative_to(PLAYBOOKS_DIR.parent)
            print(f"  = '{name}' → {rel} (unchanged)")
            skipped += 1
            continue

        # Fetch content: export Google Docs as markdown, download uploaded files directly.
        try:
            if is_gdoc:
                raw = service.files().export(
                    fileId=file_id, mimeType="text/markdown"
                ).execute()
                content = raw.decode("utf-8", errors="replace").strip()
            else:
                import io
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
            print(f"  ⚠️  '{name}': fetch failed — {exc}")
            continue

        if not content:
            print(f"  ⚠️  '{name}': empty after export — skipped")
            continue

        final = f"<!-- modifiedTime: {modified_time} -->\n{content}"
        out_path.write_text(final, encoding="utf-8")
        action = "updated" if existing_mt is not None else "new"
        rel = out_path.relative_to(PLAYBOOKS_DIR.parent)
        print(f"  ✓ '{name}' → {rel} ({action})")
        synced += 1

    if unmatched_names:
        print(f"\n  ⚠️  Unmatched docs saved to playbooks/_unmatched/:")
        for n in unmatched_names:
            print(f"       {n}")

    print(f"\nDone: {synced} synced, {skipped} skipped (unchanged), {unmatched_count} unmatched.")


if __name__ == "__main__":
    sync_playbooks()
