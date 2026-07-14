"""
generate.py — Main orchestrator for the weekly standup.

Architecture (v2): instead of one giant Claude call that produces the whole
standup (which reliably truncated at max_tokens), this makes ONE SMALL CALL
PER CLIENT plus one small wrap-up call, then assembles the final standup in
Python. Mirrors the proven flow-analyst per-client pattern.

Run: python generate.py
"""

import hashlib
import io
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

from fetch_monday import fetch_all_boards, resolve_client
from fetch_fireflies import fetch_transcripts
from fetch_whatsapp import fetch_whatsapp
from send_email import send_standup_email, markdown_to_simple_html

MODEL = "claude-sonnet-4-5"


# ── config / playbooks ────────────────────────────────────────────────────────

def load_config() -> dict:
    with open("config.json") as f:
        return json.load(f)


def _match_playbook_to_client(stem: str, clients_config: dict) -> str:
    result = resolve_client(stem, clients_config, fuzzy=True)
    return result if result != "Unmapped" else stem


def load_playbooks(clients_config: dict) -> dict[str, str]:
    """Load local playbooks/*.md files. Returns {canonical_client_or_stem: content}."""
    playbooks_dir = Path("playbooks")
    result: dict[str, str] = {}
    if not playbooks_dir.exists():
        return result
    for filepath in sorted(playbooks_dir.glob("*.md")):
        content = filepath.read_text(encoding="utf-8").strip()
        if content:
            client = _match_playbook_to_client(filepath.stem, clients_config)
            result[client] = content
    return result


def load_playbooks_drive(config: dict, clients_config: dict) -> dict[str, str]:
    """Load playbooks from the configured Google Drive folder. {} on any failure."""
    folder_id = config.get("playbooks_drive_folder_id", "")
    sa_json_str = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not folder_id or not sa_json_str:
        return {}

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload

        sa_info = json.loads(sa_json_str)
        creds = service_account.Credentials.from_service_account_info(
            sa_info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
        )
        service = build("drive", "v3", credentials=creds, cache_discovery=False)

        query = (
            f"'{folder_id}' in parents and trashed = false and ("
            f"mimeType = 'text/markdown' or "
            f"mimeType = 'text/plain' or "
            f"mimeType = 'application/vnd.google-apps.document')"
        )
        resp = service.files().list(
            q=query,
            fields="files(id, name, mimeType)",
            pageSize=50,
        ).execute()

        result: dict[str, str] = {}
        for file in resp.get("files", []):
            file_id = file["id"]
            name = file["name"]
            mime = file["mimeType"]
            stem = name
            for ext in (".md", ".txt"):
                if name.lower().endswith(ext):
                    stem = name[: -len(ext)]
                    break

            try:
                if mime == "application/vnd.google-apps.document":
                    raw = service.files().export(
                        fileId=file_id, mimeType="text/plain"
                    ).execute()
                    content = raw.decode("utf-8", errors="replace").strip()
                else:
                    buf = io.BytesIO()
                    downloader = MediaIoBaseDownload(
                        buf, service.files().get_media(fileId=file_id)
                    )
                    done = False
                    while not done:
                        _, done = downloader.next_chunk()
                    content = buf.getvalue().decode("utf-8", errors="replace").strip()

                if content:
                    client = _match_playbook_to_client(stem, clients_config)
                    result[client] = content
                    print(f"    ✓ '{name}' → {client}")
            except Exception as exc:
                print(f"    ⚠️  Drive: could not read '{name}': {exc}")

        return result
    except Exception as exc:
        print(f"  ⚠️  Drive playbooks unavailable: {exc}")
        return {}


# ── pulse window (live items only) ────────────────────────────────────────────

def filter_live_items(monday_data: list, config: dict) -> tuple[list, int]:
    """Keep only items created or updated within the pulse window.
    Dormant/archived items never reach the AI. Returns (filtered, pruned_count)."""
    from datetime import timedelta
    pulse_days = int(config.get("pulse_window_days", 45))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=pulse_days)).date().isoformat()

    pruned = 0
    filtered = []
    for board in monday_data:
        if "error" in board:
            filtered.append(board)
            continue
        live = []
        for item in board.get("items", []):
            last = item.get("last_updated") or ""
            created = item.get("created_at") or ""
            if (last and last >= cutoff) or (created and created >= cutoff):
                live.append(item)
            else:
                pruned += 1
        filtered.append({**board, "items": live})
    return filtered, pruned


# ── client grouping ───────────────────────────────────────────────────────────

def group_items_by_client(
    monday_data: list, clients_config: dict
) -> tuple[dict, dict]:
    raw: dict[str, dict[str, list]] = {}
    board_errors: dict[str, str] = {}

    for board in monday_data:
        dept = board["board_name"]
        if "error" in board:
            board_errors[dept] = board["error"]
            continue
        for item in board["items"]:
            client = item.get("client", "Unmapped")
            raw.setdefault(client, {}).setdefault(dept, []).append(item)

    ordered: dict[str, dict] = {}
    for canonical in clients_config:
        if canonical in raw:
            ordered[canonical] = raw[canonical]
    for client in raw:
        if client not in ordered and client != "Unmapped":
            ordered[client] = raw[client]
    if "Unmapped" in raw:
        ordered["Unmapped"] = raw["Unmapped"]

    return ordered, board_errors


def _match_comms_to_client(text: str, clients_config: dict) -> str:
    result = resolve_client(text, clients_config, fuzzy=True)
    return result if result != "Unmapped" else "General comms"


def match_meeting_clients(mt: dict, clients_config: dict) -> list[str]:
    """Match a meeting to one or more clients.
    1) Title match (strongest signal) — single client.
    2) Else scan the summary CONTENT for client aliases — a meeting that
       discusses several clients attaches to each of them (max 4).
    3) Else General comms."""
    title_match = resolve_client(mt.get("title", ""), clients_config, fuzzy=True)
    if title_match != "Unmapped":
        return [title_match]

    summary = mt.get("summary") or {}
    haystack = " ".join([
        str(summary.get("overview") or ""),
        str(summary.get("action_items") or ""),
        " ".join(summary.get("keywords") or []) if isinstance(summary.get("keywords"), list) else "",
    ]).lower()
    if mt.get("sentences"):
        haystack += " " + " ".join(s.get("text", "") for s in mt["sentences"][:60]).lower()

    matches = []
    for canonical, aliases in clients_config.items():
        for alias in aliases:
            if alias.lower().strip() in haystack:
                matches.append(canonical)
                break
    return matches[:4] if matches else ["General comms"]


# ── URL lookup (Python owns URLs — the model never writes them) ──────────────

def build_url_lookup(monday_data: list) -> dict[str, str]:
    """item_id -> monday_url, from fetched data only. Guarantees no invented URLs."""
    lookup: dict[str, str] = {}
    for board in monday_data:
        for item in board.get("items", []):
            iid = item.get("item_id")
            url = item.get("monday_url")
            if iid and url:
                lookup[str(iid)] = url
    return lookup


# ── per-client prompt ─────────────────────────────────────────────────────────

def _board_line(item: dict, today: str) -> str:
    """One compact line per board item — a snapshot, not an audit."""
    bits = [f"[id: {item.get('item_id', '?')}] {item['name']}"]
    cols = item.get("columns") or {}
    status = next((v for k, v in cols.items() if "status" in k.lower()), None)
    if status:
        bits.append(f"status: {status}")
    if item.get("last_updated"):
        bits.append(f"last activity: {item['last_updated']}")
    elif item.get("created_at"):
        bits.append(f"created: {item['created_at']}")
    n_subs = len(item.get("subitems") or [])
    if n_subs:
        bits.append(f"{n_subs} subitems")
    return "  - " + "  |  ".join(bits)


def _collect_monday_messages(departments: dict[str, list]) -> list[str]:
    """Pull update threads out of items into a first-class comms feed."""
    msgs = []
    for dept, items in departments.items():
        for item in items:
            for upd in (item.get("recent_updates") or [])[:4]:
                ts = (upd.get("created_at") or "")[:10]
                who = upd.get("creator", "?")
                body = (upd.get("body") or "").strip()[:300]
                if body:
                    msgs.append(f"  [{ts} — {who}] on \"{item['name']}\" ({dept}): {body}")
    return sorted(msgs, reverse=True)


def build_client_prompt(
    client: str,
    departments: dict[str, list],
    meetings: list,
    chats: list[tuple],
    playbook: str | None,
    today: str,
    days_back: int,
) -> str:
    parts: list[str] = []
    parts.append(
        f"# Weekly pulse — {client} — week ending {today}\n\n"
        "You are writing a CALM WEEKLY PULSE for one client of Flow Co., a marketing agency. "
        "The reader wants a clear picture of where this project stands — not an audit, not a "
        "task list, not a call to action.\n\n"
        "SOURCE PRIORITY — this ordering is the whole point:\n"
        "1. MEETINGS and MONDAY MESSAGES are the primary truth: what was said, agreed, "
        "delivered, or raised this week IS the pulse.\n"
        "2. WHATSAPP messages are secondary color.\n"
        "3. The BOARD SNAPSHOT is background corroboration only. Do NOT narrate board items "
        "or statuses that nobody talked about, unless one is strikingly stalled or brand new.\n\n"
        "OUTPUT RULES:\n"
        "- headline: one plain sentence a tired founder absorbs in two seconds. State, not urgency.\n"
        "- health: on_track / needs_attention / at_risk, judged comms-first (silence + stalls "
        "can mean needs_attention; an unhappy message outweighs a green board).\n"
        "- highlights: MAX 3, what actually happened this week, drawn from comms first.\n"
        "- stalled_items: MAX 2, only things genuinely stuck that matter. Skip minor ones.\n"
        "- status_change_suggestions: usually EMPTY. Only when comms directly contradict the "
        "board (e.g. delivered in a meeting but board says Working).\n"
        "- risks: MAX 1, only if real. Otherwise empty.\n"
        "- Every row cites monday_item_id verbatim from [id: N] when it concerns a board item; "
        "null for meeting/whatsapp rows. NEVER invent ids.\n"
        f"- Today is {today}. Newest signal wins. If sources are quiet, say the week was quiet — "
        "that is a valid pulse. Never pad.\n"
    )

    if playbook:
        parts.append("\n## CLIENT PLAYBOOK (context for what good looks like)\n" + playbook[:3000])

    parts.append("\n## 1. MEETINGS THIS WEEK (primary)\n")
    if meetings:
        for mt in meetings:
            parts.append(f"**{mt.get('title', 'Untitled')}** — {mt.get('date', 'no date')}")
            summary = mt.get("summary") or {}
            if summary.get("overview"):
                parts.append(f"  Overview: {str(summary['overview'])[:700]}")
            if summary.get("action_items"):
                parts.append(f"  Action items: {str(summary['action_items'])[:500]}")
            if mt.get("sentences"):
                parts.append("  [No summary — excerpt:]")
                for s in mt["sentences"][:10]:
                    parts.append(f"    {s.get('speaker_name', '?')}: {s.get('text', '')}")
            parts.append("")
    else:
        parts.append("None.\n")

    monday_msgs = _collect_monday_messages(departments)
    parts.append("\n## 2. MONDAY MESSAGES THIS WEEK (primary)\n")
    if monday_msgs:
        parts.extend(monday_msgs[:25])
    else:
        parts.append("None.")

    parts.append("\n\n## 3. WHATSAPP (secondary)\n")
    if chats:
        for chat_name, msgs in chats:
            parts.append(f"**Chat: {chat_name}**")
            if isinstance(msgs, list):
                for msg in msgs[:30]:
                    ts = (msg.get("datetime") or "")[:16]
                    parts.append(f"  [{ts}] {msg.get('sender', '?')}: {(msg.get('text') or '')[:220]}")
            parts.append("")
    else:
        parts.append("None.\n")

    parts.append("\n## 4. BOARD SNAPSHOT (background only)\n")
    if departments:
        for dept in sorted(departments):
            parts.append(f"### {dept}")
            for item in departments[dept]:
                parts.append(_board_line(item, today))
            parts.append("")
    else:
        parts.append("No live board items in the pulse window.\n")

    return "\n".join(parts)


# ── tool schemas ──────────────────────────────────────────────────────────────

_CLIENT_ROW = {
    "type": "object",
    "required": ["text", "department", "source"],
    "properties": {
        "text": {"type": "string", "description": "One short sentence."},
        "department": {"type": "string", "description": "CRM, Ads, Video, or Web + SEO. Empty string if not board work."},
        "source": {"type": "string", "enum": ["monday", "meeting", "whatsapp"]},
        "item_name": {"type": ["string", "null"], "description": "Monday item name if source=monday."},
        "monday_item_id": {"type": ["string", "null"], "description": "Verbatim [id: N] value from the data. Null otherwise. NEVER invent."},
        "days_stalled": {"type": ["integer", "null"]},
    },
}

EMIT_CLIENT_TOOL = {
    "name": "emit_client",
    "description": "Emit the weekly review for ONE client.",
    "input_schema": {
        "type": "object",
        "required": ["headline", "health", "highlights", "stalled_items",
                     "status_change_suggestions", "risks"],
        "properties": {
            "headline": {"type": "string", "description": "One specific, concrete sentence — the most important thing for this client this week."},
            "health": {"type": "string", "enum": ["on_track", "needs_attention", "at_risk"]},
            "highlights": {"type": "array", "maxItems": 3, "items": _CLIENT_ROW},
            "stalled_items": {"type": "array", "maxItems": 2, "items": _CLIENT_ROW},
            "status_change_suggestions": {
                "type": "array",
                "maxItems": 3,
                "description": "SUGGESTIONS ONLY, never decisions.",
                "items": {
                    "type": "object",
                    "required": ["item_name", "department", "current_status", "suggested_status", "reason"],
                    "properties": {
                        "item_name": {"type": "string"},
                        "department": {"type": "string"},
                        "current_status": {"type": "string"},
                        "suggested_status": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                },
            },
            "risks": {"type": "array", "maxItems": 1, "items": {"type": "string"}},
        },
    },
}

EMIT_WRAPUP_TOOL = {
    "name": "emit_wrapup",
    "description": "Emit the cross-client wrap-up for the weekly standup.",
    "input_schema": {
        "type": "object",
        "required": ["executive_summary", "departments_overview", "comms_flags",
                     "blockers", "this_week_priorities"],
        "properties": {
            "executive_summary": {
                "type": "string",
                "description": "3–5 sentences. The most important things across all clients.",
            },
            "departments_overview": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["department", "summary"],
                    "properties": {
                        "department": {"type": "string"},
                        "summary": {"type": "string", "description": "One sentence on load + anything stuck."},
                    },
                },
            },
            "comms_flags": {
                "type": "array", "maxItems": 6, "items": {"type": "string"},
                "description": "Items needing the founder's attention. Prefix with client name.",
            },
            "blockers": {
                "type": "array", "maxItems": 6, "items": {"type": "string"},
                "description": "Clear blockers. Prefix with client name.",
            },
            "this_week_priorities": {
                "type": "array",
                "maxItems": 7,
                "items": {
                    "type": "object",
                    "required": ["text"],
                    "properties": {
                        "text": {"type": "string", "description": "Prefixed with client name, e.g. 'Billy Doe Meats: Draft holiday page'."},
                        "client": {"type": "string"},
                        "action": {
                            "type": ["object", "null"],
                            "description": "Optional draft for founder review only, never sent automatically.",
                            "required": ["type", "body"],
                            "properties": {
                                "type": {"type": "string", "enum": ["email", "copy"]},
                                "to": {"type": ["string", "null"]},
                                "subject": {"type": ["string", "null"]},
                                "body": {"type": "string"},
                            },
                        },
                    },
                },
            },
        },
    },
}


# ── Claude calls ──────────────────────────────────────────────────────────────

def _anthropic_client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


def _call_tool(client: anthropic.Anthropic, prompt: str, tool: dict, label: str,
               max_tokens: int = 3000) -> dict:
    response = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        temperature=0,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": prompt}],
    )
    print(
        f"  [{label}] stop={response.stop_reason} "
        f"tokens={response.usage.input_tokens}in/{response.usage.output_tokens}out"
    )
    if response.stop_reason == "max_tokens":
        raise ValueError(f"{label}: output truncated at max_tokens")
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool["name"]:
            return block.input
    raise ValueError(f"{label}: model did not call {tool['name']}")


# ── assembly ──────────────────────────────────────────────────────────────────

def _attach_urls(rows: list, url_lookup: dict[str, str]) -> list:
    """Stamp real monday_urls onto rows via monday_item_id. Never invents."""
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        iid = row.get("monday_item_id")
        row["monday_url"] = url_lookup.get(str(iid)) if iid else None
        out.append(row)
    return out


def assemble_client_entry(client: str, result: dict, url_lookup: dict[str, str]) -> dict:
    """Convert the flat per-client model output into the nested shape the
    renderer and webpage already consume (work_by_department)."""
    highlights = _attach_urls(result.get("highlights"), url_lookup)
    stalled = _attach_urls(result.get("stalled_items"), url_lookup)

    dept_map: dict[str, dict] = {}
    for row in highlights:
        dept = row.get("department") or "General"
        dept_map.setdefault(dept, {"department": dept, "highlights": [], "stalled_items": []})
        dept_map[dept]["highlights"].append(row)
    for row in stalled:
        dept = row.get("department") or "General"
        dept_map.setdefault(dept, {"department": dept, "highlights": [], "stalled_items": []})
        dept_map[dept]["stalled_items"].append(row)

    return {
        "client": client,
        "headline": result.get("headline", ""),
        "health": result.get("health", "needs_attention"),
        "work_by_department": list(dept_map.values()),
        "status_change_suggestions": result.get("status_change_suggestions", []) or [],
        "risks": result.get("risks", []) or [],
    }


def build_meetings_digest(fireflies_data, clients_config: dict) -> list:
    """Deterministic — built in Python from Fireflies data. No model call."""
    if not isinstance(fireflies_data, list):
        return []

    def _lines(text, cap: int) -> list[str]:
        if not text:
            return []
        if isinstance(text, list):
            items = [str(x).strip() for x in text]
        else:
            items = [
                ln.strip().lstrip("-*• ").strip()
                for ln in str(text).replace("\r", "").split("\n")
            ]
        items = [i.replace("**", "").strip() for i in items]
        items = [i for i in items if i and not i.endswith(":")][:cap]
        return items

    digest = []
    seen_titles = set()
    for mt in fireflies_data:
        title = mt.get("title") or "Untitled"
        date = mt.get("date") or ""
        key = (title, date)
        if key in seen_titles:
            continue  # Fireflies often records duplicates of the same call
        seen_titles.add(key)
        summary = mt.get("summary") or {}
        matched = match_meeting_clients(mt, clients_config)
        digest.append({
            "title": title,
            "date": date,
            "client": ", ".join(m for m in matched if m != "General comms") or "General comms",
            "key_points": _lines(summary.get("overview"), 5),
            "action_items": _lines(summary.get("action_items"), 6),
        })
    return digest


def build_wrapup_prompt(client_entries: list, board_errors: dict,
                        general_meetings: list, today: str) -> str:
    parts = [
        f"# Cross-client wrap-up — week ending {today}\n\n"
        "You are writing the wrap-up sections of Flow Co.'s Monday standup. Below are the "
        "already-written per-client reviews. Synthesize across them.\n\n"
        "INSTRUCTIONS:\n"
        "1. executive_summary: 2–3 sentences max, plain and calm. A read, not a siren.\n"
        "2. departments_overview: one entry each for CRM, Ads, Video, Web + SEO — one sentence "
        "on load and anything stuck, drawn from the client reviews below.\n"
        "3. comms_flags / blockers: only real, grounded items from the reviews. Prefix with "
        "client name. Empty arrays are fine.\n"
        "4. this_week_priorities: max 4, short plain lines prefixed with client name. "
        "Set action to null — no drafts, this is a pulse, not a task machine.\n"
        "5. Never invent facts not present below.\n"
    ]
    if board_errors:
        parts.append("\n## BOARD FETCH ERRORS (mention in blockers)\n")
        for dept, err in board_errors.items():
            parts.append(f"- {dept}: {err[:200]}")

    parts.append("\n## PER-CLIENT REVIEWS\n")
    for e in client_entries:
        parts.append(f"### {e['client']} — {e['health']}")
        parts.append(f"Headline: {e['headline']}")
        for dept in e.get("work_by_department", []):
            for row in dept.get("highlights", []):
                parts.append(f"  + [{dept['department']}] {row.get('text', '')}")
            for row in dept.get("stalled_items", []):
                d = row.get("days_stalled")
                parts.append(f"  ! [{dept['department']}] {row.get('text', '')}"
                             + (f" ({d}d stalled)" if d else ""))
        for r in e.get("risks", []):
            parts.append(f"  RISK: {r}")
        parts.append("")

    if general_meetings:
        parts.append("\n## GENERAL COMMS (meetings not matched to a client)\n")
        for mt in general_meetings:
            parts.append(f"- {mt.get('title', '')} ({mt.get('date', '')}): "
                         + "; ".join(mt.get("key_points", [])[:3]))

    return "\n".join(parts)


# ── row-id injection ──────────────────────────────────────────────────────────

def _row_id(client: str, text: str) -> str:
    return hashlib.sha1(f"{client}:{text}".encode()).hexdigest()[:8]


def inject_ids(standup: dict) -> dict:
    """Inject stable id fields into every row object."""
    for entry in standup.get("by_client", []):
        client = entry.get("client", "")
        for dept in entry.get("work_by_department", []):
            for item in dept.get("highlights", []):
                if isinstance(item, dict):
                    item["id"] = _row_id(client, item.get("text", ""))
            for item in dept.get("stalled_items", []):
                if isinstance(item, dict):
                    item["id"] = _row_id(client, item.get("text", ""))
    for item in standup.get("this_week_priorities", []):
        if isinstance(item, dict):
            item["id"] = _row_id(item.get("client", "priority"), item.get("text", ""))
    return standup


# ── site copy ────────────────────────────────────────────────────────────────

def copy_to_site(src: Path) -> None:
    dst = Path("site") / "latest.json"
    dst.parent.mkdir(exist_ok=True)
    shutil.copy2(src, dst)
    print(f"  Copied → {dst}")


# ── markdown renderer (unchanged output shape) ────────────────────────────────

def _md_row(item) -> str:
    if isinstance(item, str):
        return f"- {item}"
    text = item.get("text", "")
    url = item.get("monday_url")
    days = item.get("days_stalled")
    suffix = f" *({days}d stalled)*" if days else ""
    return f"- [{text}]({url}){suffix}" if url else f"- {text}{suffix}"


def _md_priority(p) -> str:
    if isinstance(p, str):
        return f"- {p}"
    text = p.get("text", "")
    action = p.get("action") or {}
    if action.get("type") == "email":
        return f"- {text}  *(email draft: {action.get('subject', '')})*"
    if action.get("type") == "copy":
        return f"- {text}  *(copy draft)*"
    return f"- {text}"


def render_markdown(standup: dict) -> str:
    week_of = standup.get("week_of", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = []

    lines += [f"# Flow Standup — Week of {week_of}", ""]
    lines += ["## Executive Summary", "", standup.get("executive_summary", ""), ""]

    dept_overview = standup.get("departments_overview", [])
    if dept_overview:
        lines += ["## Departments Overview", ""]
        for d in dept_overview:
            lines.append(f"- **{d.get('department', '')}**: {d.get('summary', '')}")
        lines.append("")

    lines += ["## By Client", ""]
    for entry in (standup.get("by_client") or []):
        client = entry.get("client", "Unknown")
        health = entry.get("health", "on_track")
        health_label = {
            "on_track": "On Track",
            "needs_attention": "Needs Attention",
            "at_risk": "At Risk",
        }.get(health, health)

        if client == "Unmapped":
            lines.append("### Unmapped Groups")
            lines.append("*Groups with no matching client alias — add aliases to config.json.*")
        else:
            lines.append(f"### {client}  `{health_label}`")
        lines.append("")

        if entry.get("headline"):
            lines.append(f"*{entry['headline']}*")
            lines.append("")

        for dept_entry in (entry.get("work_by_department") or []):
            lines.append(f"#### {dept_entry.get('department', '')}")
            lines.append("")
            highlights = dept_entry.get("highlights") or []
            if highlights:
                lines.append("**Highlights:**")
                lines += [_md_row(h) for h in highlights]
                lines.append("")
            stalled = dept_entry.get("stalled_items") or []
            if stalled:
                lines.append("**Stalled:**")
                lines += [_md_row(s) for s in stalled]
                lines.append("")

        if entry.get("status_change_suggestions"):
            lines.append("**Status Change Suggestions** *(suggestions only)*:")
        for sug in (entry.get("status_change_suggestions") or []):
            dept_tag = f" [{sug.get('department', '')}]" if sug.get("department") else ""
            lines.append(
                f"- **{sug.get('item_name', '')}**{dept_tag}: "
                f"{sug.get('current_status', '')} → {sug.get('suggested_status', '')}  "
                f"*(reason: {sug.get('reason', '')})*"
            )
        if entry.get("status_change_suggestions"):
            lines.append("")

        if entry.get("risks"):
            lines.append("**Risks:**")
        for r in (entry.get("risks") or []):
            lines.append(f"- {r}")
        if entry.get("risks"):
            lines.append("")

    lines += ["## Meetings Digest", ""]
    for mt in (standup.get("meetings_digest") or []):
        client_tag = f" — *{mt.get('client')}*" if mt.get("client") else ""
        lines.append(f"### {mt.get('title', 'Untitled')} — {mt.get('date', '')}{client_tag}")
        lines.append("")
        if mt.get("key_points"):
            lines.append("**Key Points:**")
        for kp in (mt.get("key_points") or []):
            lines.append(f"- {kp}")
        if mt.get("key_points"):
            lines.append("")
        if mt.get("action_items"):
            lines.append("**Action Items:**")
        for ai in (mt.get("action_items") or []):
            lines.append(f"- {ai}")
        if mt.get("action_items"):
            lines.append("")
    if not (standup.get("meetings_digest") or []):
        lines += ["No meetings this week.", ""]

    lines += ["## Communications Flags", ""]
    comms = standup.get("comms_flags") or []
    lines += ([f"- {c}" for c in comms] if comms else ["Nothing flagged."]) + [""]

    lines += ["## Blockers", ""]
    blockers = standup.get("blockers") or []
    lines += ([f"- {b}" for b in blockers] if blockers else ["No blockers identified."]) + [""]

    lines += ["## This Week's Priorities", ""]
    lines += [_md_priority(p) for p in (standup.get("this_week_priorities") or [])]
    lines.append("")

    lines += ["---", f"*Generated by flow-standup on {generated_at}*"]
    return "\n".join(lines)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    config = load_config()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    days_back = config.get("days_back", 7)
    clients_config = config.get("clients", {})

    print("=" * 60)
    print(f"Flow Standup Generator — {today}")
    print("=" * 60)

    print(f"\n[1/4] Fetching Monday.com boards...")
    monday_data = []
    try:
        monday_data, _ = fetch_all_boards(config)
        monday_data, pruned = filter_live_items(monday_data, config)
        if pruned:
            print(f"  Pulse window: pruned {pruned} dormant item(s) "
                  f"older than {config.get('pulse_window_days', 45)}d")
    except Exception as exc:
        print(f"  ⚠️  Monday.com fetch failed: {exc}")
        monday_data = [{"board_name": "ALL BOARDS", "error": str(exc), "items": []}]

    print(f"\n[2/4] Fetching Fireflies transcripts...")
    fireflies_data: list | dict = []
    try:
        fireflies_data = fetch_transcripts(days_back)
        print(f"  ✓ {len(fireflies_data)} meetings")
    except Exception as exc:
        print(f"  ⚠️  Fireflies fetch failed: {exc}")
        fireflies_data = {"error": str(exc)}

    print(f"\n[3/4] Reading WhatsApp exports...")
    whatsapp_data: dict = {}
    try:
        whatsapp_data = fetch_whatsapp(days_back, config=config)
        if whatsapp_data:
            total_msgs = sum(len(v) for v in whatsapp_data.values() if isinstance(v, list))
            print(f"  ✓ {len(whatsapp_data)} chats, {total_msgs} messages")
        else:
            print("  — No exports found, skipping")
    except Exception as exc:
        print(f"  ⚠️  WhatsApp read failed: {exc}")

    print(f"\n[4/4] Loading playbooks...")
    print("  Checking Google Drive...")
    drive_playbooks = load_playbooks_drive(config, clients_config)
    local_playbooks = load_playbooks(clients_config)
    playbooks_by_client = {**local_playbooks, **drive_playbooks}
    if playbooks_by_client:
        print(f"  ✓ {len(playbooks_by_client)} playbook(s): {', '.join(playbooks_by_client.keys())}")
    else:
        print("  — No playbooks found (Drive empty or unavailable, no local files)")

    # ── organise inputs per client ────────────────────────────────────────────
    grouped, board_errors = group_items_by_client(monday_data, clients_config)
    url_lookup = build_url_lookup(monday_data)

    meetings_by_client: dict[str, list] = {}
    if isinstance(fireflies_data, list):
        for mt in fireflies_data:
            matched = match_meeting_clients(mt, clients_config)
            for c in matched:
                meetings_by_client.setdefault(c, []).append(mt)
            print(f"  meeting '{(mt.get('title') or 'Untitled')[:45]}' → {', '.join(matched)}")

    chats_by_client: dict[str, list[tuple]] = {}
    for chat_name, msgs in (whatsapp_data or {}).items():
        c = _match_comms_to_client(chat_name, clients_config)
        n = len(msgs) if isinstance(msgs, list) else 0
        print(f"  chat '{chat_name}' ({n} msgs) → {c}")
        chats_by_client.setdefault(c, []).append((chat_name, msgs))

    # Clients with any signal this week (Monday items OR meetings OR chats),
    # in config order; Unmapped last.
    active: list[str] = []
    for c in clients_config:
        if c in grouped or c in meetings_by_client or c in chats_by_client:
            active.append(c)
    for c in grouped:
        if c not in active and c != "Unmapped":
            active.append(c)
    if "Unmapped" in grouped:
        active.append("Unmapped")

    # ── per-client Claude calls ───────────────────────────────────────────────
    print(f"\nGenerating per-client reviews ({len(active)} clients, model {MODEL})...")
    ai = _anthropic_client()
    client_entries: list[dict] = []

    for c in active:
        prompt = build_client_prompt(
            client=c,
            departments=grouped.get(c, {}),
            meetings=meetings_by_client.get(c, []),
            chats=chats_by_client.get(c, []),
            playbook=playbooks_by_client.get(c),
            today=today,
            days_back=days_back,
        )
        try:
            result = _call_tool(ai, prompt, EMIT_CLIENT_TOOL, label=c)
            client_entries.append(assemble_client_entry(c, result, url_lookup))
        except Exception as exc:
            print(f"  ✗ {c}: {exc}")
            client_entries.append({
                "client": c,
                "headline": "Generation failed for this client — see workflow log.",
                "health": "needs_attention",
                "work_by_department": [],
                "status_change_suggestions": [],
                "risks": [],
            })

    # ── meetings digest (deterministic) ───────────────────────────────────────
    meetings_digest = build_meetings_digest(fireflies_data, clients_config)
    general_meetings = [m for m in meetings_digest if m.get("client") == "General comms"]

    # ── wrap-up call ──────────────────────────────────────────────────────────
    print("\nGenerating wrap-up...")
    if isinstance(fireflies_data, dict) and "error" in fireflies_data:
        board_errors = dict(board_errors)
        board_errors["Fireflies"] = fireflies_data["error"]

    try:
        wrapup = _call_tool(
            ai,
            build_wrapup_prompt(client_entries, board_errors, general_meetings, today),
            EMIT_WRAPUP_TOOL,
            label="wrap-up",
            max_tokens=4000,
        )
    except Exception as exc:
        print(f"  ✗ wrap-up failed ({exc}) — using fallback")
        headlines = [
            f"{e['client']}: {e['headline']}" for e in client_entries if e.get("headline")
        ]
        wrapup = {
            "executive_summary": " ".join(headlines[:5]) or "No summary available this week.",
            "departments_overview": [],
            "comms_flags": [],
            "blockers": [f"{d}: {err}" for d, err in board_errors.items()],
            "this_week_priorities": [],
        }

    # ── assemble + write ──────────────────────────────────────────────────────
    standup = {
        "week_of": today,
        "executive_summary": wrapup.get("executive_summary", ""),
        "departments_overview": wrapup.get("departments_overview", []),
        "by_client": client_entries,
        "meetings_digest": meetings_digest,
        "comms_flags": wrapup.get("comms_flags", []),
        "blockers": wrapup.get("blockers", []),
        "this_week_priorities": wrapup.get("this_week_priorities", []),
    }
    inject_ids(standup)
    print(f"\n  ✓ Standup assembled: {len(client_entries)} clients, "
          f"{len(meetings_digest)} meetings")

    standups_dir = Path("standups")
    standups_dir.mkdir(exist_ok=True)

    json_path = standups_dir / "latest.json"
    json_path.write_text(json.dumps(standup, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Wrote {json_path}")

    copy_to_site(json_path)

    md_content = render_markdown(standup)
    md_path = standups_dir / f"{today}.md"
    md_path.write_text(md_content, encoding="utf-8")
    print(f"  Wrote {md_path}")

    print("\nSending email...")
    try:
        to_address = config.get("email", "")
        if not to_address or to_address == "EMAIL_HERE":
            print("  ⚠️  No valid email in config.json — skipping")
        else:
            subject = f"Flow Standup - Week of {today}"
            send_standup_email(
                subject, md_content, markdown_to_simple_html(md_content), to_address
            )
    except Exception as exc:
        print(f"  ⚠️  Email failed: {exc}")

    print("\n✓ Done.")


if __name__ == "__main__":
    main()
