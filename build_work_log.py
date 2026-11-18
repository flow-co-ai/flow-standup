"""
build_work_log.py -- what the Flow team said in WhatsApp about each client,
for the Work reports page. No model calls. Writes work-log/[slug].json.
Runs after build_comms.py in the Daily Pulse workflow.

Monday is where work gets recorded. This is the safety net: work the team
only mentioned in WhatsApp still reaches the client's weekly report, and the
page flags it so it can be logged in Monday.

What goes in:
  - Team messages (config.json "team" / "team_phones") in a client's own
    groups, from the last WINDOW_DAYS.
  - Team messages in internal groups (non_client_entities, or any chat that
    doesn't map to a client) that name a client by one of its aliases.
What stays out: client messages, sender names, media and system lines, and
anything the comms redaction catches (emails, phones, long numbers,
credentials, mentions).
"""

import json
import re
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

from build_comms import (
    TEAM_PHONES, _LONG_DIGIT_RE, _assert_no_pii, _is_emoji_only, _load_active_clients,
    _load_clients_slug_map, _prepare_sender, _redact_count, _resolve_slug, _strip_fwd,
)
from client_aliases import all_alias_matches, resolve_client
from fetch_whatsapp import fetch_whatsapp_history

OUT_DIR = Path("work-log")
WINDOW_DAYS = 35          # covers a "since last report" window of up to five weeks
TEXT_CAP = 900
MIN_CHARS = 12            # "ok", "thanks", "on it" are not work
SKIP_RE = re.compile(
    r"^(<media omitted>|<attached:.*>|image omitted|video omitted|audio omitted|document omitted|sticker omitted"
    r"|gif omitted|this message was deleted|you deleted this message|null|missed (voice|video) call|.*\.(jpg|jpeg|png|pdf|mp4|opus) \(file attached\))$",
    re.IGNORECASE,
)
NOT_CLIENTS = {"Flow Company", "Unmapped"}


def _keep(text: str) -> bool:
    t = text.strip()
    return len(t) >= MIN_CHARS and not SKIP_RE.match(t) and not _is_emoji_only(t)


def _entry(msg: dict, kind: str) -> dict | None:
    text = _strip_fwd(msg.get("text", ""))
    if not _keep(text):
        return None
    redacted, _ = _redact_count(text)
    redacted = _LONG_DIGIT_RE.sub("[number]", redacted)
    if len(redacted) > TEXT_CAP:
        redacted = redacted[:TEXT_CAP].rstrip() + "…"
    return {"at": msg.get("datetime", ""), "chat": kind, "text": redacted}


def _save(slug: str, data: dict) -> None:
    serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    scrubbed, _ = _redact_count(serialized)
    scrubbed = _LONG_DIGIT_RE.sub("[number]", scrubbed)
    _assert_no_pii(slug, scrubbed)
    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / f"{slug}.json").write_text(scrubbed, encoding="utf-8")


def build_work_log(config: dict) -> None:
    team = config.get("team", [])
    TEAM_PHONES.clear()
    TEAM_PHONES.update(re.sub(r"\D", "", str(p)) for p in config.get("team_phones", []) if p)
    aliases = config.get("clients", {})
    internal_names = {n.lower() for n in config.get("non_client_entities", [])}
    slug_map = _load_clients_slug_map()
    active = _load_active_clients()
    ad_slugs = (config.get("ops") or {}).get("ad_slugs", {})

    def slugs_for(client: str) -> list[str]:
        if client in ad_slugs:
            return [s for s in ad_slugs[client] if s in active]
        s = _resolve_slug(client, slug_map)
        return [s] if s and s in active else []

    print("build_work_log: fetching WhatsApp history...")
    history = fetch_whatsapp_history(config)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).isoformat()
    by_slug: dict[str, list[dict]] = {s: [] for s in active}
    chats_by_slug: dict[str, set] = {s: set() for s in active}

    def chat_client(chat_name: str) -> str | None:
        # A client group is often named "<Client> | Flow Marketing", which also
        # matches the "Flow" alias. Any real client in the name wins over Flow.
        exact = resolve_client(chat_name, aliases)
        if exact not in NOT_CLIENTS:
            return exact
        found = [c for c in all_alias_matches(chat_name, aliases) if c not in NOT_CLIENTS]
        return found[0] if found else None

    for chat_name, msgs in history.items():
        client = None if chat_name.lower().strip() in internal_names else chat_client(chat_name)
        internal = client is None
        for msg in msgs:
            if msg.get("datetime", "") < cutoff:
                continue
            _, side = _prepare_sender(msg.get("sender", ""), team)
            if side != "flow":
                continue
            if internal:
                targets = [c for c in all_alias_matches(msg.get("text", ""), aliases) if c not in NOT_CLIENTS]
                kind = "team"
            else:
                targets = [client]
                kind = "client"
            if not targets:
                continue
            entry = _entry(msg, kind)
            if not entry:
                continue
            for c in targets:
                for slug in slugs_for(c):
                    by_slug[slug].append(entry)
                    chats_by_slug[slug].add(kind)

    now = datetime.now(timezone.utc).isoformat()
    for slug in sorted(by_slug):
        seen, msgs = set(), []
        for m in sorted(by_slug[slug], key=lambda x: x["at"]):
            key = (m["at"], m["text"])
            if key not in seen:
                seen.add(key)
                msgs.append(m)
        try:
            _save(slug, {"slug": slug, "generated_at": now, "window_days": WINDOW_DAYS, "count": len(msgs), "messages": msgs})
            print(f"  wrote work-log/{slug}.json ({len(msgs)} team messages)")
        except Exception as exc:
            print(f"  ✗ {slug}: {exc}")
            print(traceback.format_exc())
            _save(slug, {"slug": slug, "generated_at": now, "window_days": WINDOW_DAYS, "count": 0, "messages": [], "error": "redaction check failed; nothing written"})


if __name__ == "__main__":
    with open("config.json") as f:
        cfg = json.load(f)
    build_work_log(cfg)
