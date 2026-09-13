"""One-time script: purge intake_owner/primary_contact facts that are agency team
members from all facts/*.json, then recompute supersede chain and current map."""
import hashlib, json, sys
from pathlib import Path

FACTS_DIR = Path("facts")
SUPERSEDING_SUBJECTS = frozenset({
    "intake_owner", "primary_contact", "contract_start", "contract_end",
    "scope", "kpi", "crm_system", "booking_system",
})
_BARE_AGENCY_NAMES = frozenset({"sohib", "flow", "flowco", "flow company", "flow co"})


def _is_team_member(value: str, team: list) -> bool:
    v = value.strip().lower()
    if not v:
        return False
    if v in _BARE_AGENCY_NAMES:
        return True
    for member in team:
        m = member.lower()
        if m in v or v in m:
            return True
    return False


def _apply_supersede(facts: list) -> list:
    def _sort_key(f):
        return (f.get("stated_at") or "", 1 if f.get("source") == "human" else 0)
    sorted_facts = sorted(facts, key=_sort_key)
    for f in sorted_facts:
        f["superseded_by"] = None
    latest = {}
    for fact in sorted_facts:
        subject = fact["subject"]
        if subject in SUPERSEDING_SUBJECTS:
            prev = latest.get(subject)
            if prev is not None:
                prev["superseded_by"] = fact["id"]
            latest[subject] = fact
    return sorted_facts


def _build_current_map(facts: list) -> dict:
    current = {s: None for s in sorted(SUPERSEDING_SUBJECTS)}
    for fact in facts:
        if fact["subject"] in SUPERSEDING_SUBJECTS and fact["superseded_by"] is None:
            current[fact["subject"]] = fact["id"]
    return current


def main():
    cfg = json.loads(Path("config.json").read_text())
    team = cfg.get("team", [])
    if not team:
        print("No team list in config.json — nothing to do.")
        return

    total_dropped = 0
    for path in sorted(FACTS_DIR.glob("*.json")):
        if "manual" in path.name or path.name == "meeting_map.json":
            continue
        slug = path.stem
        data = json.loads(path.read_text())
        facts = data.get("facts", [])
        kept, dropped = [], []
        for f in facts:
            if f.get("subject") in ("intake_owner", "primary_contact") and _is_team_member(f.get("value", ""), team):
                dropped.append(f)
            else:
                kept.append(f)
        if not dropped:
            continue
        print(f"\n{slug}: dropping {len(dropped)} fact(s)")
        for f in dropped:
            print(f"  {f['subject']}={f.get('value')!r}  id={f.get('id')}")
        total_dropped += len(dropped)
        reprocessed = _apply_supersede(kept)
        current = _build_current_map(reprocessed)
        out = {**data, "facts": reprocessed, "current": current}
        path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"  → saved ({len(reprocessed)} facts remaining)")

    print(f"\nDone. Dropped {total_dropped} team-member facts total.")


if __name__ == "__main__":
    main()
