"""
generate.py — Main orchestrator for the weekly standup.
Fetches data from all sources, calls Claude, writes the report, sends email.
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

from fetch_monday import fetch_all_boards
from fetch_fireflies import fetch_transcripts
from fetch_whatsapp import fetch_whatsapp
from send_email import send_standup_email, markdown_to_simple_html


# ── helpers ───────────────────────────────────────────────────────────────────

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


# ── prompt builder ────────────────────────────────────────────────────────────

def build_prompt(monday_data, fireflies_data, whatsapp_data, playbooks_text, days_back=7) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    parts = []

    parts.append(
        f"# Weekly Standup Input Data — Week ending {today}\n\n"
        "You are a business analyst preparing a Monday morning standup report for the founder of "
        "Flow Co., a B2B healthcare marketing agency. All data below covers the last 7 days.\n\n"
        "CRITICAL INSTRUCTIONS:\n"
        "1. Status change suggestions are SUGGESTIONS ONLY — label them clearly as such, "
        "never as decisions already made.\n"
        "2. If any information is missing, unclear, or unavailable, say so explicitly. "
        "Do NOT invent, guess, or extrapolate facts.\n"
        "3. Frame every observation in terms of 'last 7 days'.\n"
        "4. Be concise and actionable. The reader is a non-technical founder.\n"
    )

    # ── Monday.com ────────────────────────────────────────────────────────────
    parts.append("\n---\n## MONDAY.COM BOARDS\n")
    if monday_data:
        for board in monday_data:
            parts.append(f"### {board['board_name']}  (ID: {board['board_id']})\n")
            if "error" in board:
                parts.append(f"⚠️  Fetch error: {board['error']}\n")
                continue
            if not board["items"]:
                parts.append("No items returned.\n")
                continue
            for item in board["items"]:
                line = f"**{item['name']}**"
                if item.get("group"):
                    line += f"  | Group: {item['group']}"
                parts.append(line)
                if item.get("columns"):
                    parts.append("  Columns: " + ", ".join(f"{k}: {v}" for k, v in item["columns"].items()))
                if item.get("subitems"):
                    parts.append(f"  Subitems ({len(item['subitems'])}):")
                    for sub in item["subitems"]:
                        sub_line = f"    - {sub['name']}"
                        if sub.get("columns"):
                            sub_line += "  | " + ", ".join(f"{k}: {v}" for k, v in sub["columns"].items())
                        parts.append(sub_line)
                if item.get("recent_updates"):
                    parts.append(f"  Updates (last {days_back} days):")
                    for upd in item["recent_updates"]:
                        ts = upd.get("created_at", "")[:10]
                        who = upd.get("creator", "?")
                        body = (upd.get("body") or "")[:300]
                        parts.append(f"    [{ts} — {who}]: {body}")
                parts.append("")
    else:
        parts.append("No Monday.com data available.\n")

    # ── Fireflies ─────────────────────────────────────────────────────────────
    parts.append("\n---\n## MEETING TRANSCRIPTS (Fireflies.ai)\n")
    if isinstance(fireflies_data, dict) and "error" in fireflies_data:
        parts.append(f"⚠️  Fetch error: {fireflies_data['error']}\n")
    elif isinstance(fireflies_data, list) and fireflies_data:
        for mt in fireflies_data:
            parts.append(f"**{mt.get('title', 'Untitled')}**  — {mt.get('date', 'no date')}")
            participants = mt.get("participants") or []
            if participants:
                parts.append(f"  Participants: {', '.join(participants)}")
            summary = mt.get("summary") or {}
            if summary.get("overview"):
                parts.append(f"  Overview: {summary['overview']}")
            if summary.get("action_items"):
                parts.append(f"  Action Items: {summary['action_items']}")
            if summary.get("keywords"):
                kw = summary["keywords"]
                parts.append(f"  Keywords: {', '.join(kw) if isinstance(kw, list) else kw}")
            if mt.get("sentences"):
                parts.append("  [No summary — transcript excerpt below:]")
                for s in mt["sentences"][:12]:
                    parts.append(f"    {s.get('speaker_name', '?')}: {s.get('text', '')}")
            parts.append("")
    else:
        parts.append("No meetings recorded in the last 7 days.\n")

    # ── WhatsApp ──────────────────────────────────────────────────────────────
    parts.append("\n---\n## WHATSAPP MESSAGES\n")
    if whatsapp_data:
        for chat_name, msgs in whatsapp_data.items():
            parts.append(f"**Chat: {chat_name}**")
            if isinstance(msgs, dict) and "error" in msgs:
                parts.append(f"  ⚠️  Read error: {msgs['error']}")
            elif isinstance(msgs, list):
                for msg in msgs:
                    ts = (msg.get("datetime") or "")[:16]
                    parts.append(f"  [{ts}] {msg.get('sender', '?')}: {(msg.get('text') or '')[:250]}")
            parts.append("")
    else:
        parts.append("No WhatsApp messages found in the last 7 days.\n")

    # ── Playbooks ─────────────────────────────────────────────────────────────
    if playbooks_text:
        parts.append("\n---\n## PROJECT PLAYBOOKS (Context)\n")
        parts.append(playbooks_text)

    return "\n".join(parts)


# ── Claude call ───────────────────────────────────────────────────────────────

EMIT_STANDUP_TOOL = {
    "name": "emit_standup",
    "description": "Emit the structured weekly standup report for Flow Co.",
    "input_schema": {
        "type": "object",
        "required": [
            "week_of",
            "executive_summary",
            "by_board",
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
                "description": "3–5 sentences summarising the most important things from the last 7 days.",
            },
            "by_board": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["board", "highlights", "stalled_items", "status_change_suggestions"],
                    "properties": {
                        "board": {"type": "string"},
                        "highlights": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Key wins or progress items from this board this week.",
                        },
                        "stalled_items": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Items with no visible movement or overdue.",
                        },
                        "status_change_suggestions": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "required": ["item_name", "current_status", "suggested_status", "reason"],
                                "properties": {
                                    "item_name": {"type": "string"},
                                    "current_status": {"type": "string"},
                                    "suggested_status": {"type": "string"},
                                    "reason": {"type": "string"},
                                },
                            },
                            "description": "Suggested status changes — SUGGESTIONS ONLY, never decisions.",
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
                        "key_points": {"type": "array", "items": {"type": "string"}},
                        "action_items": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
            "comms_flags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Anything from WhatsApp messages or Monday updates that needs the founder's attention.",
            },
            "blockers": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Clear blockers preventing progress on any item.",
            },
            "this_week_priorities": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Recommended top priorities for the coming week, based on the data.",
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
    lines = []

    lines += [f"# Flow Standup — Week of {week_of}", ""]

    lines += ["## Executive Summary", "", standup.get("executive_summary", ""), ""]

    lines += ["## By Board", ""]
    for bs in standup.get("by_board", []):
        lines.append(f"### {bs['board']}")
        lines.append("")
        if bs.get("highlights"):
            lines.append("**Highlights:**")
            lines += [f"- {h}" for h in bs["highlights"]]
            lines.append("")
        if bs.get("stalled_items"):
            lines.append("**Stalled Items:**")
            lines += [f"- {s}" for s in bs["stalled_items"]]
            lines.append("")
        if bs.get("status_change_suggestions"):
            lines.append("**Status Change Suggestions** *(suggestions only — not decisions)*:")
            for sug in bs["status_change_suggestions"]:
                lines.append(
                    f"- **{sug['item_name']}**: {sug['current_status']} → {sug['suggested_status']}  "
                    f"*(reason: {sug['reason']})*"
                )
            lines.append("")

    lines += ["## Meetings Digest", ""]
    meetings = standup.get("meetings_digest", [])
    if meetings:
        for mt in meetings:
            lines.append(f"### {mt['title']} — {mt['date']}")
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

    lines += ["## Communications Flags", ""]
    comms = standup.get("comms_flags", [])
    lines += ([f"- {c}" for c in comms] if comms else ["Nothing flagged."]) + [""]

    lines += ["## Blockers", ""]
    blockers = standup.get("blockers", [])
    lines += ([f"- {b}" for b in blockers] if blockers else ["No blockers identified."]) + [""]

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
    whatsapp_data = {}
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
    prompt = build_prompt(monday_data, fireflies_data, whatsapp_data, playbooks_text, days_back)

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
            send_standup_email(subject, md_content, markdown_to_simple_html(md_content), to_address)
    except Exception as exc:
        print(f"  ⚠️  Email failed: {exc}")

    print("\n✓ Done.")


if __name__ == "__main__":
    main()
