"""
build_comms.py — Deterministic WhatsApp thread analysis. No model calls.
Writes comms/[slug].json. Run after build_facts.py in the Daily Standup workflow.
"""

import hashlib
import json
import re
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv

load_dotenv()

from fetch_whatsapp import fetch_whatsapp_history
from client_aliases import resolve_client

COMMS_DIR = Path("comms")
WINDOW_DAYS = 14
THREAD_GAP_HOURS = 6
TEXT_CAP = 160
DEFAULT_TZ = "America/Chicago"

# Identical patterns to build_facts.py
_EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
_PHONE_RE = re.compile(r"\b\d{10,}\b|\+\d[\d\s\-(). ]{7,}\d")
_LONG_DIGIT_RE = re.compile(r"\d{10,}")
_CRED_RE = re.compile(
    r"(password|passwd|senha|api[\s_-]*key|token)\s*[=:\-]\s*\S+",
    re.IGNORECASE,
)
_MENTION_RE = re.compile(r"@\d{6,}|@\S+")

# iOS exports prepend ~ and Unicode direction/isolation marks to sender names
_SENDER_PREFIX_RE = re.compile(
    r"^[~‎‏‪‫‬‭‮⁦⁧⁨⁩\s]+"
)


# ── redaction ─────────────────────────────────────────────────────────────────

def _redact_count(text: str) -> tuple[str, int]:
    """Return (redacted_text, substitution_count)."""
    count = 0
    t, n = _EMAIL_RE.subn("[email]", text); count += n
    t, n = _PHONE_RE.subn("[phone]", t); count += n
    t, n = _CRED_RE.subn(lambda m: m.group(1) + ": [credential]", t); count += n
    t, n = _MENTION_RE.subn("[mention]", t); count += n
    t, n = _LONG_DIGIT_RE.subn("[number]", t); count += n
    return t, count


def _redact_name(name: str) -> str:
    """Redact PII from sender names (phone-number contacts)."""
    t = _EMAIL_RE.sub("[email]", name)
    t = _LONG_DIGIT_RE.sub("[number]", t)
    t = _MENTION_RE.sub("[mention]", t)
    return t


# ── sender resolution ─────────────────────────────────────────────────────────

def _is_flow_sender(clean_name: str, team: list[str]) -> bool:
    s = clean_name.lower()
    if not s:
        return False
    for member in team:
        m = member.lower()
        if m in s or s in m:
            return True
    return False


def _prepare_sender(sender_raw: str, team: list[str]) -> tuple[str, str]:
    """Return (display_name, side). Strips iOS prefix chars, checks team membership, redacts."""
    stripped = _SENDER_PREFIX_RE.sub("", sender_raw).strip()
    side = "flow" if _is_flow_sender(stripped, team) else "client"
    display = _redact_name(stripped)
    return display, side


# ── timezone ──────────────────────────────────────────────────────────────────

def _load_client_timezones() -> dict[str, str]:
    try:
        entries = json.loads(Path("clients.json").read_text(encoding="utf-8"))
        return {e["slug"]: e.get("timezone", DEFAULT_TZ) for e in entries if "slug" in e}
    except Exception as exc:
        print(f"  ⚠️  could not load clients.json for timezones: {exc}")
        return {}


def _localize_dt(iso_str: str, tz: ZoneInfo) -> datetime:
    """WhatsApp timestamps have no timezone. Treat the stored naive time as client-local."""
    dt = datetime.fromisoformat(iso_str)
    return dt.replace(tzinfo=None).replace(tzinfo=tz)


# ── slug resolution (identical logic to build_facts.py) ──────────────────────

def _load_clients_slug_map() -> dict[str, str]:
    try:
        entries = json.loads(Path("clients.json").read_text(encoding="utf-8"))
        return {e["name"].lower(): e["slug"] for e in entries if "name" in e and "slug" in e}
    except Exception as exc:
        print(f"  ⚠️  could not load clients.json: {exc}")
        return {}


def _resolve_slug(client_name: str, slug_map: dict[str, str]) -> str | None:
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
    return matches[best_key]


# ── thread id ─────────────────────────────────────────────────────────────────

def _thread_id(chat: str, opened_at: str) -> str:
    return hashlib.sha1(f"{chat}|{opened_at}".encode()).hexdigest()[:12]


# ── PII assertion ─────────────────────────────────────────────────────────────

def _assert_no_pii(slug: str, serialized: str) -> None:
    if "@" in serialized:
        idx = serialized.index("@")
        ctx = serialized[max(0, idx - 40) : idx + 40]
        raise AssertionError(f"comms/{slug}.json: @ found in output — {ctx!r}")
    m = _LONG_DIGIT_RE.search(serialized)
    if m:
        raise AssertionError(
            f"comms/{slug}.json: long digit run {m.group()!r} not sanitized"
        )


# ── per-client processing ─────────────────────────────────────────────────────

def _process_client(
    slug: str,
    chat_list: list[tuple[str, list[dict]]],
    tz_str: str,
    team: list[str],
    now: datetime,
) -> dict:
    try:
        tz = ZoneInfo(tz_str)
    except ZoneInfoNotFoundError:
        print(f"  ⚠️  {slug}: unknown timezone {tz_str!r}, falling back to {DEFAULT_TZ}")
        tz = ZoneInfo(DEFAULT_TZ)
        tz_str = DEFAULT_TZ

    all_threads: list[dict] = []
    messages_scanned = 0

    for chat_name, msgs in chat_list:
        messages_scanned += len(msgs)

        annotated: list[dict] = []
        for msg in msgs:
            sender_raw = msg.get("sender", "")
            display, side = _prepare_sender(sender_raw, team)
            text_raw = msg.get("text", "")
            redacted, flags = _redact_count(text_raw)
            iso_str = msg.get("datetime", "")
            try:
                local_dt = _localize_dt(iso_str, tz)
            except Exception:
                continue
            annotated.append({
                "sender": display,
                "side": side,
                "redacted_text": redacted,
                "redaction_flags": flags,
                "local_dt": local_dt,
            })

        if not annotated:
            continue

        # Segment by 6-hour gap
        groups: list[list[dict]] = [[annotated[0]]]
        for msg in annotated[1:]:
            gap_h = (msg["local_dt"] - groups[-1][-1]["local_dt"]).total_seconds() / 3600
            if gap_h > THREAD_GAP_HOURS:
                groups.append([msg])
            else:
                groups[-1].append(msg)

        for group in groups:
            first = group[0]
            last = group[-1]
            opened_at = first["local_dt"].isoformat()
            last_at = last["local_dt"].isoformat()

            client_msgs = [m for m in group if m["side"] == "client"]
            flow_msgs = [m for m in group if m["side"] == "flow"]
            participants = sorted({m["sender"] for m in group if m["sender"]})
            total_flags = sum(m["redaction_flags"] for m in group)

            # State
            last_side = last["side"]
            unanswered_since: str | None = None
            unanswered_hours: float | None = None

            if last_side == "client":
                state = "awaiting_flow"
                unanswered_since = last_at
                delta = now - last["local_dt"].astimezone(timezone.utc)
                unanswered_hours = round(delta.total_seconds() / 3600, 1)
            elif flow_msgs:
                last_two_flow = flow_msgs[-2:]
                if any(m["redacted_text"].rstrip().endswith("?") for m in last_two_flow):
                    state = "awaiting_client"
                    unanswered_since = last_at
                    delta = now - last["local_dt"].astimezone(timezone.utc)
                    unanswered_hours = round(delta.total_seconds() / 3600, 1)
                else:
                    state = "settled"
            else:
                state = "settled"

            all_threads.append({
                "id": _thread_id(chat_name, opened_at),
                "chat": chat_name,
                "opened_at": opened_at,
                "last_at": last_at,
                "_last_at_dt": last["local_dt"],
                "opened_by": first["sender"],
                "opened_side": first["side"],
                "msg_count": len(group),
                "client_msgs": len(client_msgs),
                "flow_msgs": len(flow_msgs),
                "participants": participants,
                "first_text": group[0]["redacted_text"][:TEXT_CAP],
                "last_text": group[-1]["redacted_text"][:TEXT_CAP],
                "redaction_flags": total_flags,
                "state": state,
                "unanswered_since": unanswered_since,
                "unanswered_hours": unanswered_hours,
            })

    # Window: last 14 days, plus any awaiting_flow regardless of age
    cutoff = now - timedelta(days=WINDOW_DAYS)
    output_threads = [
        t for t in all_threads
        if t["_last_at_dt"] >= cutoff or t["state"] == "awaiting_flow"
    ]

    # Sort: longest-unanswered first; settled (None) at the end
    output_threads.sort(
        key=lambda t: (
            t["unanswered_hours"] is None,
            -(t["unanswered_hours"] or 0),
        )
    )

    # Strip internal field
    for t in output_threads:
        del t["_last_at_dt"]

    af_hours = [
        t["unanswered_hours"]
        for t in output_threads
        if t["state"] == "awaiting_flow" and t["unanswered_hours"] is not None
    ]

    return {
        "slug": slug,
        "generated_at": now.isoformat(),
        "timezone": tz_str,
        "window_days": WINDOW_DAYS,
        "counts": {
            "messages_scanned": messages_scanned,
            "threads": len(output_threads),
            "awaiting_flow": sum(1 for t in output_threads if t["state"] == "awaiting_flow"),
            "awaiting_client": sum(1 for t in output_threads if t["state"] == "awaiting_client"),
            "settled": sum(1 for t in output_threads if t["state"] == "settled"),
            "stale_over_24h": sum(
                1 for t in output_threads if (t["unanswered_hours"] or 0) > 24
            ),
        },
        "oldest_unanswered_hours": max(af_hours) if af_hours else None,
        "threads": output_threads,
    }


# ── persistence ───────────────────────────────────────────────────────────────

def _save(slug: str, data: dict) -> None:
    serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    _assert_no_pii(slug, serialized)
    COMMS_DIR.mkdir(exist_ok=True)
    (COMMS_DIR / f"{slug}.json").write_text(serialized, encoding="utf-8")


# ── main ──────────────────────────────────────────────────────────────────────

def build_comms(config: dict) -> None:
    team = config.get("team", [])
    clients_config = config.get("clients", {})
    slug_map = _load_clients_slug_map()
    tz_map = _load_client_timezones()

    print("build_comms: fetching full WhatsApp history...")
    history = fetch_whatsapp_history(config)
    print(f"  {len(history)} chats loaded")

    now = datetime.now(timezone.utc)

    by_client: dict[str, list[tuple[str, list[dict]]]] = {}
    for chat_name, msgs in history.items():
        canonical = resolve_client(chat_name, clients_config, fuzzy=True)
        if canonical == "Unmapped":
            print(f"  skip (unmapped): {chat_name}")
            continue
        by_client.setdefault(canonical, []).append((chat_name, msgs))

    for client_name in sorted(by_client):
        slug = _resolve_slug(client_name, slug_map)
        if slug is None:
            print(f"  ⚠️  skip (no clients.json match): {client_name!r}")
            continue

        tz_str = tz_map.get(slug, DEFAULT_TZ)
        print(f"\n── {client_name} ({slug}, tz={tz_str}) ──")

        try:
            output = _process_client(slug, by_client[client_name], tz_str, team, now)
            _save(slug, output)
            c = output["counts"]
            print(
                f"  wrote comms/{slug}.json "
                f"({c['threads']} threads, {c['awaiting_flow']} awaiting_flow, "
                f"{c['awaiting_client']} awaiting_client)"
            )
        except Exception as exc:
            print(f"  ✗ {client_name}: failed — {exc}\n{traceback.format_exc()}")


if __name__ == "__main__":
    with open("config.json") as f:
        cfg = json.load(f)
    build_comms(cfg)
