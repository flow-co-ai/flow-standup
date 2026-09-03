// The ONE canonical client-name resolver, shared with the Python side
// (client_aliases.py) -- both read config.json's `clients` alias map. Keep
// the algorithm identical across the two if either changes.
//
// Why this exists: Monday's own group titles for one client aren't even
// consistent with EACH OTHER across boards -- CRM/Web+SEO show "Quality
// HVAC by FIbid" (capital-I typo and all), Ads/Video show "Quality HVAC",
// same client. generate.py always resolved both through config.json's alias
// table; queue.js read group titles raw with no resolution at all, which is
// what split one client into two Daily Ops buckets (8 cards vs 3, live
// 2026-09-02). Fix at the mechanism level: resolve through this table,
// don't special-case the one client name that happened to get caught.

const { clients: CLIENT_ALIASES } = require("../../../config.json");

function norm(s) {
  return (s || "").toLowerCase().trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// All clients whose alias appears as a whole word in text, spacing-tolerant
// -- mirrors client_aliases.py's all_alias_matches() exactly.
function allAliasMatches(text) {
  const needle = norm(text);
  const found = [];
  for (const [canonical, aliases] of Object.entries(CLIENT_ALIASES)) {
    const variants = new Set();
    for (const alias of aliases) {
      const a = norm(alias);
      if (a) {
        variants.add(a);
        variants.add(a.replace(/\s+/g, ""));
      }
    }
    for (const v of variants) {
      const re = new RegExp(`(?<!\\w)${escapeRe(v)}(?!\\w)`);
      if (re.test(needle)) {
        found.push(canonical);
        break;
      }
    }
  }
  return found;
}

// Resolves free text (a Monday group title, a draft card's `group` field,
// etc.) to the canonical client name from config.json. Returns the input
// unchanged when nothing matches -- an unresolved prospect/new-client string
// is a real value, not an error condition.
function resolveClientName(text) {
  if (!text) return text;
  const needle = norm(text);
  for (const [canonical, aliases] of Object.entries(CLIENT_ALIASES)) {
    for (const alias of aliases) {
      if (needle === norm(alias)) return canonical;
    }
  }
  const matches = allAliasMatches(text);
  return matches[0] || text;
}

module.exports = { resolveClientName, allAliasMatches, CLIENT_ALIASES };
