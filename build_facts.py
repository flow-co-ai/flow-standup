"""
build_facts.py — Extract durable, superseded, per-client facts from WhatsApp history
and Fireflies meeting transcripts.

Writes facts/[slug].json. Run before generate.py in the Daily Standup workflow.
First run backfills all history; subsequent runs are incremental (only messages/meetings
newer than last_processed_at[source] are sent to the model).

Manual overrides: if facts/[slug].manual.json exists, its facts are loaded with
source='human' and treated as newest in the supersede chain for their subject.
"""

import hashlib
import json
import os
import re
import traceback
from datetime import datetime, timezone
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

from fetch_whatsapp import fetch_whatsapp_history
from fetch_fireflies import fetch_transcripts
from client_aliases import resolve_client, all_alias_matches

MODEL = "claude-sonnet-4-5"
FACTS_DIR = Path("facts")
CHUNK_SIZE = 75
_FF_DAYS_BACK = 1095  # ~3 years; used when no prior Fireflies checkpoint exists

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
# Placeholder values the model must never emit.
_UNKNOWN_VALUES_RE = re.compile(
    r"^\s*(unknown|tbd|n/?a|not specified|not available|none|unspecified|unclear|to be determined)\s*$",
    re.IGNORECASE,
)


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
    "description": "Emit durable facts about a client engagement extracted from messages or meeting transcripts.",
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
                            "description": "Short string stating the fact. Never use 'Unknown', 'TBD', 'N/A', or similar placeholders.",
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


def _build_extraction_prompt(
    client_name: str, chat_name: str, messages: list[dict], source: str = "whatsapp"
) -> str:
    lines = [
        f"[{(m.get('datetime') or '')[:16]}] {m.get('sender', '?')}: {m.get('text', '')}"
        for m in messages
    ]
    source_desc = "Fireflies meeting transcripts" if source == "fireflies" else "WhatsApp messages"
    return (
        f"# Fact extraction — {client_name} — chat: {chat_name}\n\n"
        f"Extract durable facts about this marketing agency engagement from the {source_desc} below.\n\n"
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
        "ACTION ITEM RULE:\n"
        "  If a meeting summary or action item assigns a named person to manage intake, lead follow-up,\n"
        "  or callbacks, emit an intake_owner fact for that person with confidence 'stated'.\n\n"
        "DEPARTURE RULE:\n"
        "  If a message states that a named person has left, is no longer with the client, or that a\n"
        "  role is now vacant, emit a decision fact describing the departure.\n\n"
        "EMPTY VALUE RULE:\n"
        "  Never emit a value of 'Unknown', 'TBD', 'N/A', 'Not specified', or any similar placeholder.\n"
        "  If the value is not clearly present in the text, omit the fact entirely.\n\n"
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
    source: str = "whatsapp",
) -> list[dict]:
    prompt = _build_extraction_prompt(client_name, chat_name, messages, source)
    label = f"{client_name[:18]}/c{chunk_idx}"
    try:
        result = _call_tool(ai, prompt, EMIT_FACTS_TOOL, label=label)
    except Exception as exc:
        print(f"  ⚠️  {label}: extraction failed — {exc}")
        return []

    seen_ids: set[str] = set()
    facts: list[dict] = []
    raw_facts = result.get("facts") or []
    if isinstance(raw_facts, str):
        try:
            raw_facts = json.loads(raw_facts)
        except Exception as exc:
            print(f"  ⚠️  {label}: facts field is a string, JSON parse failed — {exc}; skipping chunk")
            return []
    for raw in raw_facts:
        if not isinstance(raw, dict):
            print(f"  ⚠️  {label}: non-dict fact item ({type(raw).__name__}): {repr(raw)[:80]}")
            continue
        subject = raw.get("subject", "")
        if subject not in ALL_SUBJECTS:
            continue
        value = raw.get("value", "")
        if _UNKNOWN_VALUES_RE.match(value):
            continue
        stated_at = raw.get("stated_at") or ""
        fid = _fact_id(subject, stated_at, chat_name)
        if fid in seen_ids:
            continue
        seen_ids.add(fid)
        facts.append({
            "id": fid,
            "subject": subject,
            "value": value,
            "stated_by": raw.get("stated_by", ""),
            "stated_at": stated_at,
            "chat": chat_name,
            "excerpt": (raw.get("excerpt") or "")[:200],
            "confidence": raw.get("confidence", "implied"),
            "source": source,
            "superseded_by": None,
        })
    return facts


# ── supersede logic (deterministic, no model) ─────────────────────────────────

def _apply_supersede(facts: list[dict]) -> list[dict]:
    """Sort by stated_at. For SUPERSEDING_SUBJECTS, each newer fact on the same
    subject sets superseded_by on the previous one. APPENDING_SUBJECTS never
    supersede. Human-source facts always sort last (= newest). Nothing is deleted."""
    def _sort_key(f: dict) -> tuple:
        return (f.get("stated_at") or "", 1 if f.get("source") == "human" else 0)

    sorted_facts = sorted(facts, key=_sort_key)
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
        "last_processed_at": {"whatsapp": None, "fireflies": None},
        "facts": [],
        "current": {},
    }


def _lpa_dict(lpa) -> dict:
    """Normalize last_processed_at to {whatsapp, fireflies}; migrates old string format."""
    if isinstance(lpa, str):
        return {"whatsapp": lpa, "fireflies": None}
    if isinstance(lpa, dict):
        return {"whatsapp": lpa.get("whatsapp"), "fireflies": lpa.get("fireflies")}
    return {"whatsapp": None, "fireflies": None}


def _load_manual(slug: str) -> list[dict]:
    """Load facts/[slug].manual.json if it exists; tag each fact source='human'."""
    path = FACTS_DIR / f"{slug}.manual.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        raw_facts = data.get("facts") or []
        result = []
        for raw in raw_facts:
            subject = raw.get("subject", "")
            if subject not in ALL_SUBJECTS:
                continue
            stated_at = raw.get("stated_at") or ""
            chat = raw.get("chat") or slug
            fid = _fact_id(subject, stated_at, chat)
            result.append({
                "id": fid,
                "subject": subject,
                "value": raw.get("value", ""),
                "stated_by": raw.get("stated_by", "Manual override"),
                "stated_at": stated_at,
                "chat": chat,
                "excerpt": (raw.get("excerpt") or "")[:200],
                "confidence": raw.get("confidence", "stated"),
                "source": "human",
                "superseded_by": None,
            })
        if result:
            print(f"  loaded {len(result)} manual fact(s) from {path.name}")
        return result
    except Exception as exc:
        print(f"  ⚠️  could not load manual facts for {slug}: {exc}")
        return []


def _sanitize_fact(fact: dict) -> dict:
    def _clean(text: str) -> str:
        text = _redact(text)
        text = _LONG_DIGIT_RE.sub("[number]", text)
        return text

    return {
        **fact,
        "value": _clean(fact.get("value") or ""),
        "excerpt": _clean(fact.get("excerpt") or ""),
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


# ── Fireflies client resolution ───────────────────────────────────────────────

# Agency-name tokens to remove from meeting titles before client resolution so
# internal Flow/Flowco mentions don't misdirect the match to flow-company.
_AGENCY_STRIP_RE = re.compile(
    r"\b(?:flow\s+company|flow\s+co|flowco|flow)\b",
    re.IGNORECASE,
)


def _strip_agency_tokens(title: str) -> str:
    s = _AGENCY_STRIP_RE.sub("", title)
    s = re.sub(r"^\s*(?:and|or|with|[-&,])\s*", "", s, flags=re.IGNORECASE)
    return s.strip(" ,&-")


def _inactive_slugs() -> set[str]:
    """Slugs where active is explicitly False in clients.json."""
    try:
        entries = json.loads(Path("clients.json").read_text(encoding="utf-8"))
        return {e["slug"] for e in entries if e.get("active") is False and "slug" in e}
    except Exception as exc:
        print(f"  ⚠️  could not load clients.json for inactive check: {exc}")
        return set()


def _load_meeting_map() -> dict[str, str]:
    """Load facts/meeting_map.json: {transcript_id: slug}."""
    path = FACTS_DIR / "meeting_map.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}
    except Exception as exc:
        print(f"  ⚠️  could not load meeting_map.json: {exc}")
        return {}


def _canonical_for_slug(slug: str, slug_map: dict[str, str], clients_config: dict) -> str | None:
    """Return the config.json canonical name that resolves to the given slug."""
    for canonical in clients_config:
        if _resolve_slug(canonical, slug_map) == slug:
            return canonical
    return None


def _resolve_active_ff(
    text: str,
    clients_config: dict,
    slug_map: dict[str, str],
    inactive: set[str],
) -> str:
    """Resolve text to a canonical, skipping any client whose slug is inactive."""
    for canonical in all_alias_matches(text, clients_config):
        slug = _resolve_slug(canonical, slug_map)
        if slug not in inactive:
            return canonical
    return "Unmapped"


def _resolve_by_participants(
    meeting: dict,
    client_domains: dict,
    clients_config: dict,
    slug_map: dict[str, str],
    inactive: set[str],
) -> str:
    """Match participant email domains against client_domains config entries."""
    for p in (meeting.get("participants") or []):
        domain = (p.get("email") or "").lower().split("@", 1)[-1]
        if not domain or "." not in domain:
            continue
        for canonical, domains in client_domains.items():
            if domain in [d.lower() for d in domains]:
                slug = _resolve_slug(canonical, slug_map)
                if slug not in inactive:
                    return canonical
    return "Unmapped"


def _dedupe_meetings(meetings: list[dict], meeting_map: dict[str, str] | None = None) -> list[dict]:
    """Dedupe on (meeting_link, date); where link is null, dedupe on (title, date)
    within a 2-hour window. Keep the entry with the most summary content.
    Any meeting whose id appears in meeting_map always survives over a richer duplicate."""
    if meeting_map is None:
        meeting_map = {}

    def _content_len(m: dict) -> int:
        s = m.get("summary") or {}
        if not isinstance(s, dict):
            s = {}
        return sum(len(str(v or "")) for v in s.values()) + len(m.get("sentences") or []) * 10

    def _bucket(m: dict) -> tuple:
        link = (m.get("meeting_link") or "").strip()
        date = m.get("date") or ""
        if link:
            return ("link", link, date)
        title = (m.get("title") or "").lower().strip()
        epoch = m.get("date_epoch")
        if epoch:
            try:
                hour_slot = datetime.fromtimestamp(epoch / 1000, tz=timezone.utc).hour // 2
                return ("title", title, date, hour_slot)
            except Exception:
                pass
        return ("title", title, date)

    groups: dict = {}
    for m in meetings:
        groups.setdefault(_bucket(m), []).append(m)

    result = []
    for mlist in groups.values():
        if len(mlist) == 1:
            result.append(mlist[0])
        else:
            mapped = [m for m in mlist if m.get("id") and m["id"] in meeting_map]
            best = mapped[0] if mapped else max(mlist, key=_content_len)
            print(
                f"  dedup FF: '{best.get('title')}' ({best.get('date')}) "
                f"— kept 1 of {len(mlist)} recordings"
            )
            result.append(best)
    return result


# ── Fireflies helpers ─────────────────────────────────────────────────────────

def _fireflies_pseudo_message(meeting: dict) -> dict:
    """Convert a Fireflies meeting dict to a pseudo message for fact extraction."""
    raw_summary = meeting.get("summary") or {}
    summary = raw_summary if isinstance(raw_summary, dict) else {}
    parts: list[str] = []
    if summary.get("overview"):
        parts.append(summary["overview"])
    if summary.get("action_items"):
        parts.append("Action items: " + summary["action_items"])
    if summary.get("keywords"):
        kw = summary["keywords"]
        if isinstance(kw, list):
            kw = ", ".join(str(k) for k in kw)
        if kw:
            parts.append("Keywords: " + kw)
    if not parts:
        for s in (meeting.get("sentences") or []):
            speaker = s.get("speaker_name", "?")
            text = s.get("text", "")
            if text:
                parts.append(f"{speaker}: {text}")

    date = meeting.get("date") or ""
    title = meeting.get("title") or "Untitled"
    return {
        "datetime": f"{date}T00:00:00+00:00" if date else "",
        "sender": f"Fireflies meeting: {title}",
        "text": "\n\n".join(parts),
    }


def _compute_ff_days_back(slug_map: dict[str, str]) -> int:
    """Return the minimum days_back that covers all clients' Fireflies checkpoints."""
    now_utc = datetime.now(timezone.utc)
    max_days = 7
    for slug_val in slug_map.values():
        stored = _load(slug_val)
        lpa = _lpa_dict(stored.get("last_processed_at"))
        ff = lpa.get("fireflies")
        if ff is None:
            return _FF_DAYS_BACK  # at least one client has never been processed
        try:
            delta = (now_utc - datetime.fromisoformat(ff)).days + 2
            max_days = max(max_days, delta)
        except Exception:
            return _FF_DAYS_BACK
    return max_days


# ── main ──────────────────────────────────────────────────────────────────────

def _process_client(
    ai: anthropic.Anthropic,
    slug: str,
    client_name: str,
    chat_list: list[tuple[str, list[dict]]],
    meetings: list[dict],
    now_iso: str,
) -> None:
    stored = _load(slug)
    lpa = _lpa_dict(stored.get("last_processed_at"))
    last_wa: str | None = lpa["whatsapp"]
    last_ff: str | None = lpa["fireflies"]

    existing_facts: list[dict] = [
        {**f, "source": f.get("source") or "whatsapp"}
        for f in stored.get("facts", [])
    ]

    new_facts: list[dict] = []
    latest_wa: str | None = last_wa
    latest_ff: str | None = last_ff

    # --- WhatsApp ---
    for chat_name, msgs in chat_list:
        if last_wa:
            msgs = [m for m in msgs if (m.get("datetime") or "") > last_wa]
        if not msgs:
            print(f"  {chat_name}: no new messages")
            continue

        for msg in msgs:
            dt = msg.get("datetime") or ""
            if dt and (latest_wa is None or dt > latest_wa):
                latest_wa = dt

        redacted = [_redact_message(m) for m in msgs]
        for i in range(0, len(redacted), CHUNK_SIZE):
            chunk = redacted[i : i + CHUNK_SIZE]
            chunk_facts = _extract_chunk(
                ai, client_name, chat_name, chunk, i // CHUNK_SIZE, source="whatsapp"
            )
            new_facts.extend(chunk_facts)

    # --- Fireflies ---
    for meeting in sorted(meetings, key=lambda m: m.get("date") or ""):
        meeting_date = meeting.get("date") or ""
        meeting_dt = f"{meeting_date}T00:00:00+00:00" if meeting_date else ""
        if not meeting_dt:
            continue
        if last_ff and meeting_dt <= last_ff:
            continue
        if latest_ff is None or meeting_dt > latest_ff:
            latest_ff = meeting_dt

        title = meeting.get("title") or "Untitled"
        pseudo_msg = _fireflies_pseudo_message(meeting)
        if not pseudo_msg.get("text", "").strip():
            print(f"  Fireflies '{title}': no content, skipping")
            continue

        redacted_msg = _redact_message(pseudo_msg)
        meeting_facts = _extract_chunk(
            ai, client_name, title, [redacted_msg], 0, source="fireflies"
        )
        new_facts.extend(meeting_facts)
        if meeting_facts:
            print(f"  Fireflies '{title}' ({meeting_date}): {len(meeting_facts)} facts")

    # --- Manual override ---
    manual_facts = _load_manual(slug)

    if not new_facts and not existing_facts and not manual_facts:
        print("  no facts found")
        return

    # Merge: existing + new first; manual facts overwrite on ID collision.
    merged: dict[str, dict] = {}
    for f in existing_facts + new_facts:
        if f["id"] not in merged:
            merged[f["id"]] = f
    for f in manual_facts:
        merged[f["id"]] = f  # human always wins on collision

    deduped = _apply_supersede(list(merged.values()))
    current = _build_current_map(deduped)

    output = {
        "slug": slug,
        "generated_at": now_iso,
        "last_processed_at": {"whatsapp": latest_wa, "fireflies": latest_ff},
        "current": current,
        "facts": deduped,
    }
    _save(slug, output)
    n_new = len(new_facts) + len(manual_facts)
    print(f"  wrote facts/{slug}.json ({len(deduped)} total facts, {n_new} new)")


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

    print("build_facts: fetching Fireflies transcripts...")
    try:
        days_back_ff = _compute_ff_days_back(slug_map)
        all_meetings = fetch_transcripts(days_back=days_back_ff)
        print(f"  {len(all_meetings)} meetings loaded (days_back={days_back_ff})")
    except Exception as exc:
        print(f"  ⚠️  Fireflies fetch failed: {exc}")
        all_meetings = []

    ai = _anthropic_client()
    now_iso = datetime.now(timezone.utc).isoformat()

    # Group WhatsApp chats by resolved canonical client name.
    by_client_wa: dict[str, list[tuple[str, list[dict]]]] = {}
    for chat_name, msgs in history.items():
        canonical = resolve_client(chat_name, clients_config, fuzzy=True)
        if canonical == "Unmapped":
            print(f"  skip WA (unmapped): {chat_name}")
            continue
        by_client_wa.setdefault(canonical, []).append((chat_name, msgs))

    # Group Fireflies meetings by resolved canonical client name.
    # Resolve first (so meeting_map entries are identified), then dedupe per client.
    meeting_map = _load_meeting_map()
    inactive = _inactive_slugs()
    client_domains = config.get("client_domains", {})

    pre_dedup_by_client_ff: dict[str, list[dict]] = {}
    for meeting in all_meetings:
        title = meeting.get("title") or ""
        date = meeting.get("date") or ""
        meeting_id = meeting.get("id") or ""

        # 1. Manual meeting_map override (transcript_id → slug)
        mapped_slug = meeting_map.get(meeting_id)
        if mapped_slug:
            canonical_override = _canonical_for_slug(mapped_slug, slug_map, clients_config)
            if canonical_override:
                pre_dedup_by_client_ff.setdefault(canonical_override, []).append(meeting)
            else:
                print(f"  ⚠️  meeting_map slug {mapped_slug!r} has no canonical: {title!r}")
            continue

        canonical = "Unmapped"

        # 2. Title — strip agency tokens first so internal mentions don't misdirect
        clean_title = _strip_agency_tokens(title)
        if clean_title:
            canonical = _resolve_active_ff(clean_title, clients_config, slug_map, inactive)

        # 3. Participant email domains (requires client_domains in config.json)
        if canonical == "Unmapped" and client_domains:
            canonical = _resolve_by_participants(meeting, client_domains, clients_config, slug_map, inactive)

        # 4. Summary text fallback — only when exactly one active client matches.
        #    Zero or multiple matches → internal/ambiguous; skip with a log line.
        if canonical == "Unmapped":
            s = meeting.get("summary") or {}
            if isinstance(s, dict):
                summary_text = " ".join(filter(None, [s.get("overview"), s.get("action_items")]))
                if summary_text:
                    active_matches = [
                        c for c in all_alias_matches(summary_text, clients_config)
                        if _resolve_slug(c, slug_map) not in inactive
                    ]
                    if len(active_matches) == 1:
                        canonical = active_matches[0]
                    elif len(active_matches) > 1:
                        print(f"  skip FF (multi-client): {title!r} ({date})")
                        continue

        if canonical == "Unmapped":
            print(f"  skip FF (unmapped): {title!r} ({date})")
            continue

        pre_dedup_by_client_ff.setdefault(canonical, []).append(meeting)

    # Dedupe within each client's list, protecting meeting_map entries.
    by_client_ff: dict[str, list[dict]] = {
        c: _dedupe_meetings(ms, meeting_map)
        for c, ms in pre_dedup_by_client_ff.items()
    }

    all_clients = set(by_client_wa) | set(by_client_ff)
    for client_name in sorted(all_clients):
        slug = _resolve_slug(client_name, slug_map)
        if slug is None:
            print(f"  ⚠️  skip (no clients.json match): {client_name!r}")
            continue

        print(f"\n── {client_name} ({slug}) ──")
        try:
            _process_client(
                ai, slug, client_name,
                by_client_wa.get(client_name, []),
                by_client_ff.get(client_name, []),
                now_iso,
            )
        except Exception as exc:
            print(f"  ✗ {client_name}: failed — {exc}\n{traceback.format_exc()}")


if __name__ == "__main__":
    with open("config.json") as f:
        cfg = json.load(f)
    build_facts(cfg)
