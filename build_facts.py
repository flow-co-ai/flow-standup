"""
build_facts.py — Extract durable, superseded, per-client facts from full WhatsApp history.

Writes facts/[slug].json. Run before generate.py in the Daily Standup workflow.
First run backfills all history; subsequent runs are incremental (only messages
newer than last_processed_at are sent to the model).
"""

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

from fetch_whatsapp import fetch_whatsapp_history
from client_aliases import resolve_client

MODEL = "claude-sonnet-4-5"
FACTS_DIR = Path("facts")
CHUNK_SIZE = 75

# Subjects where the latest fact supersedes all prior facts on the same subject.
SUPERSEDING_SUBJECTS = frozenset({
    "intake_owner", "primary_contact", "contract_start", "contract_end",
    "scope", "kpi", "crm_system", "booking_system",
})
# Subjects that always append — never supersede.
APPENDING_SUBJECTS = frozenset({"decision", "commitment", "blocker"})
ALL_SUBJECTS = SUPERSEDING_SUBJECTS | APPENDING_SUBJECTS

# Canonical order for the tool schema enum (matches spec order).
_SUBJECT_ENUM = [
    "intake_owner", "primary_contact", "contract_start", "contract_end",
    "scope", "kpi", "crm_system", "booking_system",
    "decision", "commitment", "blocker",
]


# ── redaction ─────────────────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
_PHONE_RE = re.compile(r"\b\d{10,}\b|\+\d[\d\s\-(). ]{7,}\d")
_LONG_DIGIT_RE = re.compile(r"\d{10,}")
_CRED_RE  = re.compile(
    r"(password|passwd|senha|api[\s_-]*key|token)\s*[=:\-]\s*\S+",
    re.IGNORECASE,
)
# WhatsApp tags contacts as @<phone-digits> or @<username>
_MENTION_RE = re.compile(r"@\d{6,}|@\S+")


def _redact(text: str) -> str:
    text = _EMAIL_RE.sub("[email]", text)
    text = _PHONE_RE.sub("[phone]", text)
    text = _CRED_RE.sub(lambda m: m.group(1) + ": [credential]", text)
    text = _MENTION_RE.sub("[mention]", text)
    return text


def _redact_message(msg: dict) -> dict:
    return {**msg, "text": _redact(msg.get("text") or "")}


# ── slug ──────────────────────────────────────────────────────────────────────

def _slug(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


# ── model ─────────────────────────────────────────────────────────────────────

def _anthropic_client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


def _call_tool(client: anthropic.Anthropic, prompt: str, tool: dict, label: str,
               max_tokens: int = 8000) -> dict:
    response = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": prompt}],
        extra_body={"temperature": 0},
    )
    print(
        f"  [{label}] stop={response.stop_reason} "
        f"tokens={response.usage.input_tokens}in/{response.usage.output_tokens}out"
    )
    if response.stop_reason == "max_tokens":
        print(f"  ⚠️  [{label}] truncated at max_tokens — attempting partial extraction")
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool["name"]:
            return block.input
    raise ValueError(f"{label}: model did not call {tool['name']}")


# ── tool schema ───────────────────────────────────────────────────────────────

EMIT_FACTS_TOOL = {
    "name": "emit_facts",
    "description": "Emit durable facts about a client engagement extracted from WhatsApp messages.",
    "input_schema": {
        "type": "object",
        "required": ["facts"],
        "properties": {
            "facts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": [
                        "subject", "value", "stated_by", "stated_at",
                        "chat", "excerpt", "confidence",
                    ],
                    "properties": {
                        "subject": {
                            "type": "string",
                            "enum": _SUBJECT_ENUM,
                        },
                        "value": {
                            "type": "string",
                            "description": "Short string stating the fact.",
                        },
                        "stated_by": {
                            "type": "string",
                            "description": "Sender name from the source message.",
                        },
                        "stated_at": {
                            "type": "string",
                            "description": "ISO datetime of the source message, copied verbatim from the [timestamp].",
                        },
                        "chat": {
                            "type": "string",
                            "description": "Chat name from the header.",
                        },
                        "excerpt": {
                            "type": "string",
                            "description": "At most 20 words copied verbatim from the source message (already redacted).",
                        },
                        "confidence": {
                            "type": "string",
                            "enum": ["stated", "implied"],
                            "description": "'stated' if the message says it directly; 'implied' if inferred.",
                        },
                    },
                },
            },
        },
    },
}


# ── extraction ────────────────────────────────────────────────────────────────

def _fact_id(subject: str, stated_at: str, chat: str) -> str:
    return hashlib.sha1(f"{subject}|{stated_at}|{chat}".encode()).hexdigest()[:12]


def _build_extraction_prompt(client_name: str, chat_name: str, messages: list[dict]) -> str:
    lines = [
        f"[{(m.get('datetime') or '')[:16]}] {m.get('sender', '?')}: {m.get('text', '')}"
        for m in messages
    ]
    return (
        f"# Fact extraction — {client_name} — chat: {chat_name}\n\n"
        "Extract durable facts about this marketing agency engagement from the WhatsApp messages below.\n\n"
        "OUTPUT LIMITS: Emit at most 12 facts. Skip greetings, scheduling chatter, acknowledgements, "
        "and anything that is not a durable statement about the engagement.\n\n"
        "RECORD ONLY facts about:\n"
        "  • The engagement: who owns intake, who is the primary client contact, contract start/end dates,\n"
        "    what services are in scope, what KPIs were agreed upon\n"
        "  • The client's own systems: their CRM, their booking or scheduling software\n"
        "  • Specific decisions, commitments made by either party, and blockers blocking progress\n\n"
        "NEVER RECORD:\n"
        "  • Anything about a patient, lead, or end-customer of the client\n"
        "  • Personal information about third parties unrelated to the engagement\n"
        "  • Internal agency discussion not about this specific client engagement\n\n"
        "QUALITY RULES:\n"
        "  • Only record a fact when the text directly states or strongly implies it\n"
        "  • Fewer facts with 'stated' confidence beat many facts with 'implied'\n"
        "  • Never guess a value not present in the text\n"
        "  • excerpt: copy at most 20 words verbatim from the relevant message\n"
        "  • stated_at: copy the ISO datetime exactly as it appears in [brackets]\n\n"
        "SUBJECT DEFINITIONS:\n"
        "  intake_owner    — person who manages client onboarding/intake for this engagement\n"
        "  primary_contact — main client-side point of contact\n"
        "  contract_start  — when the engagement started or is set to start\n"
        "  contract_end    — when the engagement ends or is set to end\n"
        "  scope           — services included in this engagement\n"
        "  kpi             — success metrics agreed upon for this engagement\n"
        "  crm_system      — CRM the client uses (e.g. HubSpot, Salesforce, GoHighLevel)\n"
        "  booking_system  — scheduling/booking tool the client uses (e.g. Calendly, Jane)\n"
        "  decision        — a specific decision made during this engagement (always appends)\n"
        "  commitment      — a specific commitment made by the agency or the client (always appends)\n"
        "  blocker         — something currently blocking progress on this engagement (always appends)\n\n"
        f"Messages from {chat_name}:\n"
        + "\n".join(lines)
    )


def _extract_chunk(
    ai: anthropic.Anthropic,
    client_name: str,
    chat_name: str,
    messages: list[dict],
    chunk_idx: int,
) -> list[dict]:
    prompt = _build_extraction_prompt(client_name, chat_name, messages)
    label = f"{client_name[:18]}/c{chunk_idx}"
    try:
        result = _call_tool(ai, prompt, EMIT_FACTS_TOOL, label=label)
    except Exception as exc:
        print(f"  ⚠️  {label}: extraction failed — {exc}")
        return []

    seen_ids: set[str] = set()
    facts: list[dict] = []
    for raw in result.get("facts") or []:
        subject = raw.get("subject", "")
        if subject not in ALL_SUBJECTS:
            continue
        stated_at = raw.get("stated_at") or ""
        fid = _fact_id(subject, stated_at, chat_name)
        if fid in seen_ids:
            continue
        seen_ids.add(fid)
        facts.append({
            "id": fid,
            "subject": subject,
            "value": raw.get("value", ""),
            "stated_by": raw.get("stated_by", ""),
            "stated_at": stated_at,
            "chat": chat_name,
            "excerpt": (raw.get("excerpt") or "")[:200],
            "confidence": raw.get("confidence", "implied"),
            "superseded_by": None,
        })
    return facts


# ── supersede logic (deterministic, no model) ─────────────────────────────────

def _apply_supersede(facts: list[dict]) -> list[dict]:
    """Sort by stated_at. For SUPERSEDING_SUBJECTS, each newer fact on the same
    subject sets superseded_by on the previous one. APPENDING_SUBJECTS never
    supersede. Nothing is deleted."""
    sorted_facts = sorted(facts, key=lambda f: f.get("stated_at") or "")
    for f in sorted_facts:
        f["superseded_by"] = None
    latest: dict[str, dict] = {}
    for fact in sorted_facts:
        subject = fact["subject"]
        if subject in SUPERSEDING_SUBJECTS:
            prev = latest.get(subject)
            if prev is not None:
                prev["superseded_by"] = fact["id"]
            latest[subject] = fact
    return sorted_facts


def _build_current_map(facts: list[dict]) -> dict[str, str | None]:
    """For each fixed subject, the id of the newest unsuperseded fact, or null."""
    current: dict[str, str | None] = {s: None for s in sorted(SUPERSEDING_SUBJECTS)}
    for fact in facts:
        if fact["subject"] in SUPERSEDING_SUBJECTS and fact["superseded_by"] is None:
            current[fact["subject"]] = fact["id"]
    return current


# ── persistence ───────────────────────────────────────────────────────────────

def _load(slug: str) -> dict:
    path = FACTS_DIR / f"{slug}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "slug": slug,
        "generated_at": None,
        "last_processed_at": None,
        "facts": [],
        "current": {},
    }


def _sanitize_fact(fact: dict) -> dict:
    return {
        **fact,
        "value": _LONG_DIGIT_RE.sub("[number]", fact.get("value") or ""),
        "excerpt": _LONG_DIGIT_RE.sub("[number]", fact.get("excerpt") or ""),
    }


def _save(slug: str, data: dict) -> None:
    FACTS_DIR.mkdir(exist_ok=True)
    facts = [_sanitize_fact(f) for f in data.get("facts", [])]
    data = {**data, "facts": facts}
    _assert_no_pii(slug, facts)
    serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    path = FACTS_DIR / f"{slug}.json"
    path.write_text(serialized, encoding="utf-8")


def _assert_no_pii(slug: str, facts: list[dict]) -> None:
    for fact in facts:
        subject = fact.get("subject", "?")
        chat = fact.get("chat", "?")
        for field in ("value", "stated_by", "excerpt"):
            val = fact.get(field) or ""
            if "@" in val:
                raise AssertionError(
                    f"facts/{slug}.json [{subject}/{chat}]: {field}={val[:80]!r} — possible email/mention"
                )
            m = _LONG_DIGIT_RE.search(val)
            if m:
                raise AssertionError(
                    f"facts/{slug}.json [{subject}/{chat}]: {field} contains {m.group()!r} — long digit run not sanitized"
                )


# ── main ──────────────────────────────────────────────────────────────────────

def _process_client(
    ai: anthropic.Anthropic,
    slug: str,
    client_name: str,
    chat_list: list[tuple[str, list[dict]]],
    now_iso: str,
) -> None:
    stored = _load(slug)
    last_processed_at: str | None = stored.get("last_processed_at")
    existing_facts: list[dict] = stored.get("facts", [])

    new_facts: list[dict] = []
    latest_dt: str | None = last_processed_at

    for chat_name, msgs in chat_list:
        if last_processed_at:
            msgs = [m for m in msgs if (m.get("datetime") or "") > last_processed_at]
        if not msgs:
            print(f"  {chat_name}: no new messages")
            continue

        for msg in msgs:
            dt = msg.get("datetime") or ""
            if dt and (latest_dt is None or dt > latest_dt):
                latest_dt = dt

        redacted = [_redact_message(m) for m in msgs]

        for i in range(0, len(redacted), CHUNK_SIZE):
            chunk = redacted[i : i + CHUNK_SIZE]
            chunk_facts = _extract_chunk(ai, client_name, chat_name, chunk, i // CHUNK_SIZE)
            new_facts.extend(chunk_facts)

    if not new_facts and not existing_facts:
        print("  no facts found")
        return

    all_facts = existing_facts + new_facts
    seen_ids: set[str] = set()
    deduped: list[dict] = []
    for f in all_facts:
        if f["id"] not in seen_ids:
            seen_ids.add(f["id"])
            deduped.append(f)

    deduped = _apply_supersede(deduped)
    current = _build_current_map(deduped)

    output = {
        "slug": slug,
        "generated_at": now_iso,
        "last_processed_at": latest_dt,
        "current": current,
        "facts": deduped,
    }
    _save(slug, output)
    print(f"  wrote facts/{slug}.json ({len(deduped)} total facts, {len(new_facts)} new)")


def _load_clients_slug_map() -> dict[str, str]:
    """Return {name.lower(): slug} from clients.json."""
    try:
        entries = json.loads(Path("clients.json").read_text(encoding="utf-8"))
        return {e["name"].lower(): e["slug"] for e in entries if "name" in e and "slug" in e}
    except Exception as exc:
        print(f"  ⚠️  could not load clients.json: {exc}")
        return {}


def _resolve_slug(client_name: str, slug_map: dict[str, str]) -> str | None:
    """Match client_name against slug_map using containment in either direction.
    When multiple entries match, prefer the one with the longest common prefix."""
    key = client_name.lower()
    matches = {k: v for k, v in slug_map.items() if key in k or k in key}
    if not matches:
        return None
    if len(matches) == 1:
        return next(iter(matches.values()))

    def _lcp(k: str) -> int:
        n = min(len(k), len(key))
        for i in range(n):
            if k[i] != key[i]:
                return i
        return n

    best_key = max(matches, key=_lcp)
    print(
        f"  ⚠️  '{client_name}': multiple slug matches {sorted(matches)} → chose '{best_key}' ({matches[best_key]})"
    )
    return matches[best_key]


def build_facts(config: dict) -> None:
    clients_config = config.get("clients", {})
    slug_map = _load_clients_slug_map()

    print("build_facts: fetching full WhatsApp history...")
    history = fetch_whatsapp_history(config)
    print(f"  {len(history)} chats loaded")

    ai = _anthropic_client()
    now_iso = datetime.now(timezone.utc).isoformat()

    # Group chats by resolved canonical client name.
    by_client: dict[str, list[tuple[str, list[dict]]]] = {}
    for chat_name, msgs in history.items():
        canonical = resolve_client(chat_name, clients_config, fuzzy=True)
        if canonical == "Unmapped":
            print(f"  skip (unmapped): {chat_name}")
            continue
        by_client.setdefault(canonical, []).append((chat_name, msgs))

    for client_name, chat_list in sorted(by_client.items()):
        slug = _resolve_slug(client_name, slug_map)
        if slug is None:
            print(f"  ⚠️  skip (no clients.json match): {client_name!r}")
            continue

        print(f"\n── {client_name} ({slug}) ──")
        try:
            _process_client(ai, slug, client_name, chat_list, now_iso)
        except Exception as exc:
            print(f"  ✗ {client_name}: failed — {exc}")


if __name__ == "__main__":
    with open("config.json") as f:
        cfg = json.load(f)
    build_facts(cfg)
