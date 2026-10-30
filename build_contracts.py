"""
build_contracts.py — Writes site/contracts.json, the scope block on each client's hero.

Reads, never fetches:
  contracts/[slug].json   what we agreed to do, edited by hand (playbook + agreed changes)
  facts/[facts_slug].json scope talk the facts layer pulled from WhatsApp and Fireflies

Anything the facts layer heard about scope after a contract's reviewed_through date is
listed under "Heard since review". It is shown, never applied. A person reads it,
updates the contract file, and moves reviewed_through forward.

Runs in the Daily Pulse workflow. A bad contract file is skipped with a warning so the
run never fails because of one typo.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

CONTRACTS_DIR = Path("contracts")
FACTS_DIR = Path("facts")
OUT = Path("site/contracts.json")

MENTION_SUBJECTS = {"scope", "contract_start", "contract_end", "kpi"}
MAX_MENTIONS = 5

_EMAIL = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
_PHONE = re.compile(r"\+?\d[\d\s\-().]{8,}\d")


def _clean(text) -> str:
    text = str(text or "").strip()
    return _PHONE.sub("[phone]", _EMAIL.sub("[email]", text))


def _day(value) -> str | None:
    if not value:
        return None
    m = re.match(r"\d{4}-\d{2}-\d{2}", str(value))
    return m.group(0) if m else None


def _entries(raw, label: str, slug: str) -> list[dict]:
    out = []
    for e in raw or []:
        if isinstance(e, str):
            e = {"text": e}
        if not isinstance(e, dict) or not e.get("text"):
            print(f"  warn {slug}: skipped an empty {label} entry")
            continue
        out.append({"date": _day(e.get("date")), "source": _clean(e.get("source")), "text": _clean(e["text"])})
    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return out


def _mentions(facts_slug: str, after: str | None) -> list[dict]:
    path = FACTS_DIR / f"{facts_slug}.json"
    if not facts_slug or not path.exists():
        return []
    try:
        facts = json.loads(path.read_text()).get("facts", [])
    except Exception as exc:  # a broken facts file must not break the run
        print(f"  warn {facts_slug}: facts unreadable ({exc})")
        return []
    seen, out = set(), []
    for f in facts:
        day = _day(f.get("stated_at"))
        if f.get("subject") not in MENTION_SUBJECTS or not day or (after and day <= after):
            continue
        if f.get("source") == "human":
            continue
        text = _clean(f.get("value"))
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        where = "Call" if f.get("source") == "fireflies" else "WhatsApp"
        out.append({"date": day, "source": where, "text": text})
    out.sort(key=lambda x: x["date"], reverse=True)
    return out[:MAX_MENTIONS]


def _budget(raw) -> dict:
    raw = raw or {}
    out = {}
    for k in ("google", "meta", "lsa", "total"):
        v = raw.get(k)
        if isinstance(v, (int, float)) and v > 0:
            out[k] = v
    if raw.get("note"):
        out["note"] = _clean(raw["note"])
    return out


def build() -> int:
    clients, problems = {}, 0
    for path in sorted(CONTRACTS_DIR.glob("*.json")):
        if path.name.startswith("_"):
            continue
        slug = path.stem
        try:
            c = json.loads(path.read_text())
            name = (c.get("name") or "").strip()
            if not name:
                raise ValueError("missing \"name\" (must match the client name on the Standup)")
        except Exception as exc:
            problems += 1
            print(f"  skip {path}: {exc}")
            continue
        reviewed = _day(c.get("reviewed_through"))
        term = c.get("term") or {}
        clients[name] = {
            "slug": slug,
            "reviewed_through": reviewed,
            "term": {"start": _day(term.get("start")), "end": _day(term.get("end")), "note": _clean(term.get("note"))},
            "budget": _budget(c.get("budget")),
            "we_run": [_clean(x) for x in c.get("we_run") or [] if x],
            "not_ours": [_clean(x) for x in c.get("not_ours") or [] if x],
            "changed": _entries(c.get("changed"), "changed", slug),
            "unclear": _entries(c.get("unclear"), "unclear", slug),
            "heard": _mentions(c.get("facts_slug") or slug, reviewed),
            "edit_path": f"contracts/{path.name}",
        }
        print(f"  {name}: {len(clients[name]['changed'])} changed, {len(clients[name]['unclear'])} unclear, "
              f"{len(clients[name]['heard'])} heard since {reviewed or 'never'}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "clients": clients}, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT} ({len(clients)} clients{f', {problems} skipped' if problems else ''})")
    return 0


if __name__ == "__main__":
    sys.exit(build())
