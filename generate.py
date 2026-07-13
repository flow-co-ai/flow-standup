"""
generate.py — Main orchestrator for the weekly standup.
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
    """
    Load .md and Google Doc playbooks from Drive using GOOGLE_SERVICE_ACCOUNT_JSON.
    Returns {} gracefully on any auth or fetch failure.
    """
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
            # Strip extension to get the stem used for client matching
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


# ── prompt builder ────────────────────────────────────────────────────────────

def _fmt_item(item: dict, days_back: int) -> list[str]:
    lines = []
    line = f"  - **{item['name']}**"
    if item.get("group"):
        line += f"  [group: {item['group']}]"
    lines.append(line)

    if item.get("monday_url"):
        lines.append(f"    [monday_url: {item['monday_url']}]")
    if item.get("last_updated"):
        lines.append(f"    [last_updated: {item['last_updated']}]")
    if item.get("columns"):
        lines.append("    Columns: " + ", ".join(f"{k}: {v}" for k, v in item["columns"].items()))
    if item.get("subitems"):
        lines.append(f"    Subitems ({len(item['subitems'])}):")
        for sub in item["subitems"]:
            sub_line = f"      • {sub['name']}"
            if sub.get("columns"):
                sub_line += "  | " + ", ".join(f"{k}: {v}" for k, v in sub["columns"].items())
            lines.append(sub_line)
    if item.get("recent_updates"):
        lines.append(f"    Updates (last {days_back}d):")
        for upd in item["recent_updates"]:
            ts = upd.get("created_at", "")[:10]
            who = upd.get("creator", "?")
            body = (upd.get("body") or "")[:300]
            lines.append(f"      [{ts} — {who}]: {body}")
    return lines


def build_prompt(
    monday_data: list,
    fireflies_data,
    whatsapp_data: dict,
    playbooks_by_client: dict[str, str],
    config: dict,
) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    days_back = config.get("days_back", 7)
    clients_config = config.get("clients", {})
    parts: list[str] = []

    parts.append(
        f"# Weekly Standup Input Data — Week ending {today}\n\n"
        "You are a business analyst preparing a Monday morning standup report for the founder of "
        "Flow Co., a B2B healthcare marketing agency. All data below covers the last 7 days.\n\n"
        "CRITICAL INSTRUCTIONS:\n\n"
        "1. CLIENT-FIRST: The report is organised CLIENT-FIRST. Each client has work across up to 4 "
        "departments (CRM, Ads, Video, Web + SEO). Items in the 'Unmapped' group had no matching "
        "client alias — include them faithfully in by_client with client='Unmapped', at the bottom. "
        "Never drop them.\n\n"
        "2. CROSS-SOURCE CORRELATION is the main job. Actively hunt for mismatches across Monday, "
        "Fireflies, and WhatsApp: action items agreed in a meeting with no matching Monday task; "
        "client frustration or urgency in comms not reflected in board status; items marked Done or "
        "In Progress that comms suggest are actually stuck; things discussed in comms that appear "
        "nowhere on the boards. Surface these as the highest-value lines. A good standup connects "
        "dots across sources; a weak one just lists what each source said.\n\n"
        "3. HEALTH CALLS must be grounded. Weigh comms signals (an unhappy client message, an "
        "unanswered call, a missed commitment) as heavily as board status. A client can be "
        "all-tasks-in-progress on Monday and still be at_risk because of what was said. Explain "
        "the health call in the headline.\n\n"
        "4. USE THE PLAYBOOKS as the definition of what good looks like per client. If a client's "
        "playbook is present in the PROJECT PLAYBOOKS section below, judge their health and "
        "priorities against the workstreams and deliverables it describes — not a generic standard.\n\n"
        "5. ANTI-HALLUCINATION: every stalled item, correlation, and status suggestion must trace "
        "to something actually present in the provided data. If inferring, say so ('looks like…', "
        "'no Monday task found for…'). Never state a connection as fact if the data only implies it. "
        "For monday_url: ONLY use a URL that appears verbatim in [monday_url: ...] tags below. "
        "NEVER invent, modify, or guess URLs. If no URL tag is present for an item, set monday_url "
        "to null.\n\n"
        "6. HEADLINES must be specific and concrete. 'Case study video stalled 3 weeks and the "
        "retainer call went unanswered' is good. 'Some progress this week' is useless.\n\n"
        "7. STATUS SUGGESTIONS are SUGGESTIONS ONLY — label them as such, never as decisions.\n\n"
        f"8. DAYS_STALLED: if [last_updated: YYYY-MM-DD] is shown, compute days_stalled as today "
        f"({today}) minus that date. If unavailable, set to null.\n\n"
        "9. Be concise and actionable. The reader is a non-technical founder.\n"
    )

    # ── Monday.com (client-first) ─────────────────────────────────────────────
    parts.append("\n---\n## MONDAY.COM DATA (grouped by client)\n")

    grouped, board_errors = group_items_by_client(monday_data, clients_config)

    if board_errors:
        parts.append("**Board fetch errors:**")
        for dept, err in board_errors.items():
            parts.append(f"  ⚠️  {dept}: {err}")
        parts.append("")

    if not grouped:
        parts.append("No Monday.com data available.\n")
    else:
        for client, departments in grouped.items():
            marker = " *(no matching alias — add to config.json)*" if client == "Unmapped" else ""
            parts.append(f"### {client}{marker}\n")
            for dept in sorted(departments):
                parts.append(f"#### {dept}")
                for item in departments[dept]:
                    parts.extend(_fmt_item(item, days_back))
            parts.append("")

    # ── Fireflies ─────────────────────────────────────────────────────────────
    parts.append("\n---\n## MEETING TRANSCRIPTS (Fireflies.ai — grouped by client)\n")

    if isinstance(fireflies_data, dict) and "error" in fireflies_data:
        parts.append(f"⚠️  Fetch error: {fireflies_data['error']}\n")
    elif isinstance(fireflies_data, list) and fireflies_data:
        meetings_by_client: dict[str, list] = {}
        for mt in fireflies_data:
            client = _match_comms_to_client(mt.get("title", ""), clients_config)
            meetings_by_client.setdefault(client, []).append(mt)

        ordered_clients = [c for c in clients_config if c in meetings_by_client]
        if "General comms" in meetings_by_client:
            ordered_clients.append("General comms")

        for client in ordered_clients:
            parts.append(f"### {client}")
            for mt in meetings_by_client[client]:
                parts.append(f"  **{mt.get('title', 'Untitled')}** — {mt.get('date', 'no date')}")
                participants = mt.get("participants") or []
                if participants:
                    parts.append(f"    Participants: {', '.join(participants)}")
                summary = mt.get("summary") or {}
                if summary.get("overview"):
                    parts.append(f"    Overview: {summary['overview']}")
                if summary.get("action_items"):
                    parts.append(f"    Action Items: {summary['action_items']}")
                if summary.get("keywords"):
                    kw = summary["keywords"]
                    parts.append(f"    Keywords: {', '.join(kw) if isinstance(kw, list) else kw}")
                if mt.get("sentences"):
                    parts.append("    [No summary — transcript excerpt:]")
                    for s in mt["sentences"][:12]:
                        parts.append(f"      {s.get('speaker_name', '?')}: {s.get('text', '')}")
            parts.append("")
    else:
        parts.append("No meetings recorded in the last 7 days.\n")

    # ── WhatsApp ──────────────────────────────────────────────────────────────
    parts.append("\n---\n## WHATSAPP MESSAGES (grouped by client)\n")

    if whatsapp_data:
        chats_by_client: dict[str, list[tuple]] = {}
        for chat_name, msgs in whatsapp_data.items():
            client = _match_comms_to_client(chat_name, clients_config)
            chats_by_client.setdefault(client, []).append((chat_name, msgs))

        ordered_clients = [c for c in clients_config if c in chats_by_client]
        if "General comms" in chats_by_client:
            ordered_clients.append("General comms")

        for client in ordered_clients:
            parts.append(f"### {client}")
            for chat_name, msgs in chats_by_client[client]:
                parts.append(f"  **Chat: {chat_name}**")
                if isinstance(msgs, dict) and "error" in msgs:
                    parts.append(f"    ⚠️  Read error: {msgs['error']}")
                elif isinstance(msgs, list):
                    for msg in msgs:
                        ts = (msg.get("datetime") or "")[:16]
                        parts.append(
                            f"    [{ts}] {msg.get('sender', '?')}: "
                            f"{(msg.get('text') or '')[:250]}"
                        )
            parts.append("")
    else:
        parts.append("No WhatsApp messages found in the last 7 days.\n")

    # ── Playbooks ─────────────────────────────────────────────────────────────
    if playbooks_by_client:
        parts.append(
            "\n---\n## PROJECT PLAYBOOKS (what good looks like per client)\n\n"
            "Each playbook describes the agreed workstreams and deliverables for that client. "
            "Use these as your benchmark when assessing health and priorities.\n"
        )
        for client_key, content in playbooks_by_client.items():
            parts.append(f"### {client_key}\n\n{content}\n")

    return "\n".join(parts)


# ── row-id injection ──────────────────────────────────────────────────────────

def _row_id(client: str, text: str) -> str:
    return hashlib.sha1(f"{client}:{text}".encode()).hexdigest()[:8]


def inject_ids(standup: dict) -> dict:
    """Inject stable id fields into every row object after the model responds."""
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


# ── Claude tool schema ────────────────────────────────────────────────────────

_ROW_ITEM = {
    "type": "object",
    "required": ["text", "source"],
    "properties": {
        "text": {"type": "string"},
        "source": {"type": "string", "enum": ["monday", "meeting", "whatsapp"]},
        "monday_url": {
            "type": ["string", "null"],
            "description": "Verbatim from [monday_url: ...] in the input. Null if absent. NEVER invent.",
        },
        "item_name": {"type": ["string", "null"], "description": "Monday item name if source=monday."},
    },
}

_STALLED_ITEM = {
    **_ROW_ITEM,
    "properties": {
        **_ROW_ITEM["properties"],
        "days_stalled": {
            "type": ["integer", "null"],
            "description": "Days since last_updated tag. Null if unavailable.",
        },
    },
}

EMIT_STANDUP_TOOL = {
    "name": "emit_standup",
    "description": (
        "Emit the structured weekly standup report for Flow Co. "
        "Client-first. 'Unmapped' client entry at bottom if any unresolved Monday groups exist."
    ),
    "input_schema": {
        "type": "object",
        "required": [
            "week_of",
            "executive_summary",
            "departments_overview",
            "by_client",
            "meetings_digest",
            "comms_flags",
            "blockers",
            "this_week_priorities",
        ],
        "properties": {
            "week_of": {
                "type": "string",
                "description": "Monday date this standup covers, e.g. 2024-07-14",
            },
            "executive_summary": {
                "type": "string",
                "description": "3–5 sentences covering the most important things across all clients.",
            },
            "departments_overview": {
                "type": "array",
                "description": "One entry per department. One sentence each on load + anything stuck.",
                "items": {
                    "type": "object",
                    "required": ["department", "summary"],
                    "properties": {
                        "department": {"type": "string"},
                        "summary": {"type": "string"},
                    },
                },
            },
            "by_client": {
                "type": "array",
                "description": "One entry per client with data. Config order. Unmapped last.",
                "items": {
                    "type": "object",
                    "required": [
                        "client", "headline", "health",
                        "work_by_department", "status_change_suggestions", "risks",
                    ],
                    "properties": {
                        "client": {"type": "string"},
                        "headline": {
                            "type": "string",
                            "description": "One sentence: the single most important thing for this client this week.",
                        },
                        "health": {
                            "type": "string",
                            "enum": ["on_track", "needs_attention", "at_risk"],
                            "description": "on_track=good momentum, needs_attention=some friction, at_risk=critical issue or stall.",
                        },
                        "work_by_department": {
                            "type": "array",
                            "description": "One entry per department that has items for this client.",
                            "items": {
                                "type": "object",
                                "required": ["department", "highlights", "stalled_items"],
                                "properties": {
                                    "department": {"type": "string"},
                                    "highlights": {"type": "array", "items": _ROW_ITEM},
                                    "stalled_items": {"type": "array", "items": _STALLED_ITEM},
                                },
                            },
                        },
                        "status_change_suggestions": {
                            "type": "array",
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
                        "risks": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
            },
            "meetings_digest": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["title", "date", "key_points", "action_items"],
                    "properties": {
                        "title": {"type": "string"},
                        "date": {"type": "string"},
                        "client": {"type": "string", "description": "Matched client or 'General comms'."},
                        "key_points": {"type": "array", "items": {"type": "string"}},
                        "action_items": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
            "comms_flags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Items needing the founder's attention. Prefix with client name where applicable.",
            },
            "blockers": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Clear blockers. Prefix with client name.",
            },
            "this_week_priorities": {
                "type": "array",
                "description": "Top priorities for the coming week.",
                "items": {
                    "type": "object",
                    "required": ["text"],
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "Priority text, prefixed with client name e.g. 'Billy Doe Meats: Draft holiday page'.",
                        },
                        "client": {
                            "type": "string",
                            "description": "The canonical client this priority belongs to, or 'General' if cross-client.",
                        },
                        "action": {
                            "type": ["object", "null"],
                            "description": (
                                "Optional draft action. Drafts are suggestions for founder review only, "
                                "never sent automatically."
                            ),
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


def call_claude(prompt: str) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is not set")

    client = anthropic.Anthropic(api_key=api_key)

    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=8192,
        tools=[EMIT_STANDUP_TOOL],
        tool_choice={"type": "tool", "name": "emit_standup"},
        messages=[{"role": "user", "content": prompt}],
    )

    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "emit_standup":
            return block.input

    raise ValueError("Claude did not call emit_standup — check the API response")


# ── markdown renderer ─────────────────────────────────────────────────────────

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
            lines.append(f"- **{d['department']}**: {d['summary']}")
        lines.append("")

    lines += ["## By Client", ""]
    for entry in (standup.get("by_client") or []):
        client = entry.get("client", "Unknown")
        health = entry.get("health", "on_track")
        health_label = {"on_track": "On Track", "needs_attention": "Needs Attention", "at_risk": "At Risk"}.get(health, health)

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

        for sug in (entry.get("status_change_suggestions") or []):
            if lines[-1] != "**Status Change Suggestions** *(suggestions only)*:":
                lines.append("**Status Change Suggestions** *(suggestions only)*:")
            dept_tag = f" [{sug.get('department', '')}]" if sug.get("department") else ""
            lines.append(
                f"- **{sug.get('item_name', '')}**{dept_tag}: "
                f"{sug.get('current_status', '')} → {sug.get('suggested_status', '')}  "
                f"*(reason: {sug.get('reason', '')})*"
            )
        if entry.get("status_change_suggestions"):
            lines.append("")

        for r in (entry.get("risks") or []):
            if lines[-1] != "**Risks:**":
                lines.append("**Risks:**")
            lines.append(f"- {r}")
        if entry.get("risks"):
            lines.append("")

    lines += ["## Meetings Digest", ""]
    for mt in (standup.get("meetings_digest") or []):
        client_tag = f" — *{mt.get('client')}*" if mt.get("client") else ""
        lines.append(f"### {mt.get('title', 'Untitled')} — {mt.get('date', '')}{client_tag}")
        lines.append("")
        for kp in (mt.get("key_points") or []):
            if lines[-1] != "**Key Points:**":
                lines.append("**Key Points:**")
            lines.append(f"- {kp}")
        if mt.get("key_points"):
            lines.append("")
        for ai in (mt.get("action_items") or []):
            if lines[-1] != "**Action Items:**":
                lines.append("**Action Items:**")
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

    print("=" * 60)
    print(f"Flow Standup Generator — {today}")
    print("=" * 60)

    print(f"\n[1/4] Fetching Monday.com boards...")
    monday_data = []
    try:
        monday_data, _ = fetch_all_boards(config)
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
    clients_config = config.get("clients", {})
    print("  Checking Google Drive...")
    drive_playbooks = load_playbooks_drive(config, clients_config)
    local_playbooks = load_playbooks(clients_config)
    # Drive takes precedence; local files fill in any gaps
    playbooks_by_client = {**local_playbooks, **drive_playbooks}
    if playbooks_by_client:
        print(f"  ✓ {len(playbooks_by_client)} playbook(s): {', '.join(playbooks_by_client.keys())}")
    else:
        print("  — No playbooks found (Drive empty or unavailable, no local files)")

    print("\nBuilding prompt and calling Claude (claude-sonnet-4-5)...")
    prompt = build_prompt(monday_data, fireflies_data, whatsapp_data, playbooks_by_client, config)

    try:
        standup = call_claude(prompt)
        print("RAW EMIT OUTPUT:", json.dumps(standup, indent=2))
        print(f"  keys returned: { {k: (len(v) if isinstance(v, list) else type(v).__name__) for k, v in standup.items()} }")
        inject_ids(standup)
        print("  ✓ Standup data received")
    except Exception as exc:
        print(f"  ✗ Claude API call failed: {exc}")
        sys.exit(1)

    standups_dir = Path("standups")
    standups_dir.mkdir(exist_ok=True)

    json_path = standups_dir / "latest.json"
    json_path.write_text(json.dumps(standup, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n  Wrote {json_path}")

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
            week_of = standup.get("week_of", today)
            subject = f"Flow Standup - Week of {week_of}"
            send_standup_email(
                subject, md_content, markdown_to_simple_html(md_content), to_address
            )
    except Exception as exc:
        print(f"  ⚠️  Email failed: {exc}")

    print("\n✓ Done.")


if __name__ == "__main__":
    main()
