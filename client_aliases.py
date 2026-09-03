"""
client_aliases.py -- the ONE canonical client-name resolver, ported to JS as
netlify/functions/lib/clientAliases.js. Both read config.json's `clients`
alias map; keep the algorithm identical across the two if either changes.

Extracted out of fetch_monday.py (2026-09-02) so drafter/validate.py's §19b
pending-queue audit can reuse the exact same resolution generate.py already
relies on, instead of a second hand-maintained copy. fetch_monday.py
re-exports these two names unchanged -- every existing `from fetch_monday
import resolve_client` caller keeps working.

Root cause this exists for: Monday's own group titles for one client aren't
even consistent with EACH OTHER across boards (CRM/Web+SEO show "Quality
HVAC by FIbid", Ads/Video show "Quality HVAC" -- same group_mm231wbb-style
ids, different display text, capital I typo and all). generate.py always
resolved both through this table; queue.js/lib/monday.js didn't, which is
what split one client into two Daily Ops buckets.
"""

from __future__ import annotations

import re


def resolve_client(text: str, clients_config: dict, fuzzy: bool = False) -> str:
    """
    Map text to a canonical client name using the alias table from config.json.

    fuzzy=False (default): text must exactly equal one alias (case-insensitive).
                           Used for Monday group titles.
    fuzzy=True:            any alias that appears as a substring of text matches.
                           Used for meeting titles and chat file names.

    Returns "Unmapped" when nothing matches.
    """
    needle = text.lower().strip()

    # Exact equality always wins first (original strict behavior).
    for canonical, aliases in clients_config.items():
        for alias in aliases:
            if needle == alias.lower().strip():
                return canonical

    # Word-boundary matching: an alias must appear as whole word(s), so
    # "Flow" matches "Flow OS" but never "workflow". Spaced and unspaced
    # spellings are treated as equal ("Med Station" == "MedStation").
    matches = all_alias_matches(text, clients_config)
    return matches[0] if matches else "Unmapped"


def all_alias_matches(text: str, clients_config: dict) -> list[str]:
    """All clients whose alias appears as a whole word in text, spacing-tolerant."""
    needle = text.lower()
    found = []
    for canonical, aliases in clients_config.items():
        variants = set()
        for alias in aliases:
            a = alias.lower().strip()
            if a:
                variants.add(a)
                variants.add(a.replace(" ", ""))
        for v in variants:
            if re.search(r"(?<!\w)" + re.escape(v) + r"(?!\w)", needle):
                found.append(canonical)
                break
    return found
