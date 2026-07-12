"""
generate.py — Main orchestrator for the weekly standup.
Fetches data from all sources, groups by client, calls Claude, writes report, sends email.
Run: python generate.py
"""

import json
import os
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


def load_playbooks() -> str:
    playbooks_dir = Path("playbooks")
    if not playbooks_dir.exists():
        return ""
    sections = []
    for filepath in sorted(playbooks_dir.glob("*.md")):
        content = filepath.read_text(encoding="utf-8").strip()
        if content:
            sections.append(f"### {filepath.stem}\n\n{content}")
    return "\n\n".join(sections)


# ── client grouping ───────────────────────────────────────────────────────────

def group_items_by_client(
    monday_data: list, clients_config: dict
) -> tuple[dict, dict]:
    """
    Restructures flat board results into {client: {department: [items]}}.

    Returns:
      grouped    — dict ordered: config clients first, then Unmapped last
      board_errors — {department: error_message} for boards that failed to fetch
    """
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

    # Maintain config order; Unmapped always last
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
    """Fuzzy-match a meeting title or chat filename to a canonical client.
    Returns 'General comms' instead of 'Unmapped' for non-Monday sources."""
    result = resolve_client(text, clients_config, fuzzy=True)
    return result if result != "Unmapped" else "General comms"


# ── prompt builder ────────────────────────────────────────────────────────────

def _fmt_item(item: dict, days_back: int) -> list[str]:
    """Render one Monday item as a list of indented strings."""
    lines = []
    line = f"  - **{item['name']}**"
    if item.get("group"):
        line += f"  [group: {item['group']}]"
    lines.append(line)

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
    playbooks_text: str,
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
        "CRITICAL INSTRUCTIONS:\n"
        "1. The report is organised CLIENT-FIRST. Each client has work spread across up to 4 "
        "departments (CRM, Ads, Video, Web + SEO).\n"
        "2. Status change suggestions are SUGGESTIONS ONLY — label them as such, never as decisions.\n"
        "3. If information is missing or unclear, say so explicitly. Do NOT invent or guess facts.\n"
        "4. Frame every observation as 'last 7 days'.\n"
        "5. Items in the 'Unmapped' group had no matching client alias — include them faithfully in "
        "by_client with client='Unmapped', at the bottom. Never drop them.\n"
        "6. Be concise and actionable. The reader is a non-technical founder.\n"
    )

    # ── Monday.com (client-first) ─────────────────────────────────────────────
    parts.append("\n---\n## MONDAY.COM DATA (grouped by client)\n")

    grouped, board_errors = group_items_by_client(monday_data, clients_config)

    if board_errors:
        parts.append("**Board fetch errors (these departments are missing from the report):**")
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

    # ── Fireflies (grouped by client) ────────────────────────────────────────
    parts.append("\n---\n## MEETING TRANSCRIPTS (Fireflies.ai — grouped by client)\n")

    if isinstance(fireflies_data, dict) and "error" in fireflies_data:
        parts.append(f"⚠️  Fetch error: {fireflies_data['error']}\n")
    elif isinstance(fireflies_data, list) and fireflies_data:
        meetings_by_client: dict[str, list] = {}
        for mt in fireflies_data:
            client = _match_comms_to_client(mt.get("title", ""), clients_config)
            meetings_by_client.setdefault(client, []).append(mt)

        # Config order first, General comms last
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

    # ── WhatsApp (grouped by client) ──────────────────────────────────────────
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
    if playbooks_text:
        parts.append("\n---\n## PROJECT PLAYBOOKS (Context)\n")
        parts.append(playbooks_text)

    return "\n".join(parts)


# ── Claude tool schema ────────────────────────────────────────────────────────

EMIT_STANDUP_TOOL = {
    "name": "emit_standup",
    "description": (
        "Emit the structured weekly standup report for Flow Co. "
        "Report is organised client-first. Include an 'Unmapped' client entry at the bottom "
        "if any Monday items had no matching alias."
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
                "description": "The Monday date this standup covers, e.g. 2024-07-14",
            },
            "executive_summary": {
                "type": "string",
                "description": "3–5 sentences covering the most important things across all clients last week.",
            },
            "departments_overview": {
                "type": "array",
                "description": "One entry per department. One sentence each: overall load and anything stuck.",
                "items": {
                    "type": "object",
                    "required": ["department", "summary"],
                    "properties": {
                        "department": {"type": "string"},
                        "summary": {
                            "type": "string",
                            "description": "One sentence covering load and blockers for this department.",
                        },
                    },
                },
            },
            "by_client": {
                "type": "array",
                "description": (
                    "One entry per client. Order matches config. 'Unmapped' goes last. "
                    "Only include clients that have actual data."
                ),
                "items": {
                    "type": "object",
                    "required": ["client", "work_by_department", "status_change_suggestions", "risks"],
                    "properties": {
                        "client": {"type": "string"},
                        "work_by_department": {
                            "type": "array",
                            "description": "One entry per department that has items for this client.",
                            "items": {
                                "type": "object",
                                "required": ["department", "highlights", "stalled_items"],
                                "properties": {
                                    "department": {"type": "string"},
                                    "highlights": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "description": "Key wins or progress this week in this department.",
                                    },
                                    "stalled_items": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "description": "Items with no movement or that are overdue.",
                                    },
                                },
                            },
                        },
                        "status_change_suggestions": {
                            "type": "array",
                            "description": "Suggested status changes across all departments for this client. SUGGESTIONS ONLY.",
                            "items": {
                                "type": "object",
                                "required": [
                                    "item_name",
                                    "department",
                                    "current_status",
                                    "suggested_status",
                                    "reason",
                                ],
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
                            "description": "Risks or concerns for this client based on last week's data.",
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
                        "client": {
                            "type": "string",
                            "description": "Matched client name, or 'General comms' if unmatched.",
                        },
                        "key_points": {"type": "array", "items": {"type": "string"}},
                        "action_items": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
            "comms_flags": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "WhatsApp messages or Monday updates needing the founder's attention. "
                    "Prefix each with the client name where applicable, e.g. '[Billy Doe Meats] …'"
                ),
            },
            "blockers": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Clear blockers preventing progress. Prefix with client name.",
            },
            "this_week_priorities": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Recommended top priorities for the coming week. Prefix with client name.",
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
        max_tokens=4096,
        tools=[EMIT_STANDUP_TOOL],
        tool_choice={"type": "tool", "name": "emit_standup"},
        messages=[{"role": "user", "content": prompt}],
    )

    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "emit_standup":
            return block.input

    raise ValueError("Claude did not call emit_standup — check the API response")


# ── markdown renderer ─────────────────────────────────────────────────────────

def render_markdown(standup: dict) -> str:
    week_of = standup.get("week_of", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = []

    lines += [f"# Flow Standup — Week of {week_of}", ""]

    # Executive summary
    lines += ["## Executive Summary", "", standup.get("executive_summary", ""), ""]

    # Departments overview
    dept_overview = standup.get("departments_overview", [])
    if dept_overview:
        lines += ["## Departments Overview", ""]
        for d in dept_overview:
            lines.append(f"- **{d['department']}**: {d['summary']}")
        lines.append("")

    # By client
    lines += ["## By Client", ""]
    clients = standup.get("by_client", [])
    for entry in clients:
        client = entry["client"]
        is_unmapped = client == "Unmapped"

        if is_unmapped:
            lines.append(f"### Unmapped Groups")
            lines.append(
                "*These Monday groups had no matching client alias. "
                "Add aliases to config.json to assign them.*"
            )
        else:
            lines.append(f"### {client}")
        lines.append("")

        for dept_entry in entry.get("work_by_department", []):
            dept = dept_entry["department"]
            lines.append(f"#### {dept}")
            lines.append("")

            if dept_entry.get("highlights"):
                lines.append("**Highlights:**")
                lines += [f"- {h}" for h in dept_entry["highlights"]]
                lines.append("")

            if dept_entry.get("stalled_items"):
                lines.append("**Stalled:**")
                lines += [f"- {s}" for s in dept_entry["stalled_items"]]
                lines.append("")

        if entry.get("status_change_suggestions"):
            lines.append("**Status Change Suggestions** *(suggestions only — not decisions)*:")
            for sug in entry["status_change_suggestions"]:
                dept_tag = f" [{sug.get('department', '')}]" if sug.get("department") else ""
                lines.append(
                    f"- **{sug['item_name']}**{dept_tag}: "
                    f"{sug['current_status']} → {sug['suggested_status']}  "
                    f"*(reason: {sug['reason']})*"
                )
            lines.append("")

        if entry.get("risks"):
            lines.append("**Risks:**")
            lines += [f"- {r}" for r in entry["risks"]]
            lines.append("")

    # Meetings digest
    lines += ["## Meetings Digest", ""]
    meetings = standup.get("meetings_digest", [])
    if meetings:
        for mt in meetings:
            client_tag = f" — *{mt['client']}*" if mt.get("client") else ""
            lines.append(f"### {mt['title']} — {mt['date']}{client_tag}")
            lines.append("")
            if mt.get("key_points"):
                lines.append("**Key Points:**")
                lines += [f"- {kp}" for kp in mt["key_points"]]
                lines.append("")
            if mt.get("action_items"):
                lines.append("**Action Items:**")
                lines += [f"- {ai}" for ai in mt["action_items"]]
                lines.append("")
    else:
        lines += ["No meetings this week.", ""]

    # Comms flags
    lines += ["## Communications Flags", ""]
    comms = standup.get("comms_flags", [])
    lines += ([f"- {c}" for c in comms] if comms else ["Nothing flagged."]) + [""]

    # Blockers
    lines += ["## Blockers", ""]
    blockers = standup.get("blockers", [])
    lines += ([f"- {b}" for b in blockers] if blockers else ["No blockers identified."]) + [""]

    # Priorities
    lines += ["## This Week's Priorities", ""]
    lines += [f"- {p}" for p in standup.get("this_week_priorities", [])]
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

    # 1. Monday.com
    print(f"\n[1/4] Fetching Monday.com boards...")
    monday_data = []
    try:
        monday_data, _ = fetch_all_boards(config)
    except Exception as exc:
        print(f"  ⚠️  Monday.com fetch failed: {exc}")
        monday_data = [{"board_name": "ALL BOARDS", "error": str(exc), "items": []}]

    # 2. Fireflies
    print(f"\n[2/4] Fetching Fireflies transcripts...")
    fireflies_data: list | dict = []
    try:
        fireflies_data = fetch_transcripts(days_back)
        print(f"  ✓ {len(fireflies_data)} meetings")
    except Exception as exc:
        print(f"  ⚠️  Fireflies fetch failed: {exc}")
        fireflies_data = {"error": str(exc)}

    # 3. WhatsApp
    print(f"\n[3/4] Reading WhatsApp exports...")
    whatsapp_data: dict = {}
    try:
        whatsapp_data = fetch_whatsapp(days_back)
        if whatsapp_data:
            total_msgs = sum(len(v) for v in whatsapp_data.values() if isinstance(v, list))
            print(f"  ✓ {len(whatsapp_data)} chats, {total_msgs} messages")
        else:
            print("  — No exports found, skipping")
    except Exception as exc:
        print(f"  ⚠️  WhatsApp read failed: {exc}")

    # 4. Playbooks
    print(f"\n[4/4] Loading playbooks...")
    playbooks_text = load_playbooks()
    if playbooks_text:
        print(f"  ✓ {len(playbooks_text):,} characters")
    else:
        print("  — No playbooks found")

    # Build prompt and call Claude
    print("\nBuilding prompt and calling Claude (claude-sonnet-4-5)...")
    prompt = build_prompt(monday_data, fireflies_data, whatsapp_data, playbooks_text, config)

    try:
        standup = call_claude(prompt)
        print("  ✓ Standup data received")
    except Exception as exc:
        print(f"  ✗ Claude API call failed: {exc}")
        sys.exit(1)

    # Write outputs
    standups_dir = Path("standups")
    standups_dir.mkdir(exist_ok=True)

    json_path = standups_dir / "latest.json"
    json_path.write_text(json.dumps(standup, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n  Wrote {json_path}")

    md_content = render_markdown(standup)
    md_path = standups_dir / f"{today}.md"
    md_path.write_text(md_content, encoding="utf-8")
    print(f"  Wrote {md_path}")

    # Send email
    print("\nSending email...")
    try:
        to_address = config.get("email", "")
        if not to_address or to_address == "EMAIL_HERE":
            print("  ⚠️  No valid email in config.json — skipping (update the 'email' field)")
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
