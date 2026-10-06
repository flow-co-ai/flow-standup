// build_history.js -- longer daily history for the Ops page's 30 and 90-day ranges,
// plus discovery of every Google Business Profile listing Windsor can see.
//
// 1. Lists all GBP listings connected in Windsor and links each to a client:
//    clients.json first, then config.json ops.gbp_links, then a client-name
//    match on the listing title. Unlinked listings are reported, not guessed.
// 2. Pulls HISTORY_DAYS of daily data per client (same fetcher pulse.js uses,
//    one GBP listing per call) and writes series/<slug>.json.
// Aggregates only -- Windsor never returns PII.
//
// Run after pulse.js:  node build_history.js   (needs WINDSOR_API_KEY)

import { fetchWindsor } from './fetch_windsor.js';
import { writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');
const CONFIG = require('./config.json');
const { allAliasMatches } = require('./netlify/functions/lib/clientAliases.js');
const HISTORY_DAYS = 186;
const KEY = process.env.WINDSOR_API_KEY;
const OPS = CONFIG.ops || {};

if (!KEY) { console.log('build_history: WINDSOR_API_KEY not set, skipping.'); process.exit(0); }
mkdirSync('series', { recursive: true });
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

// ── 1. discover listings ────────────────────────────────────────────────
async function discoverListings() {
  const params = new URLSearchParams({ api_key: KEY, fields: 'account_id,location_title', date_from: day(60), date_to: day(1), _max_rows: '50000' });
  const res = await fetch(`https://connectors.windsor.ai/google_my_business?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()).data || [];
  const seen = new Map();
  for (const r of rows) if (r.account_id && !seen.has(r.account_id)) seen.set(r.account_id, (r.location_title || '').trim());
  return [...seen].map(([id, title]) => ({ id, title }));
}

const slugOfClient = (name) => ((OPS.ad_slugs || {})[name] || [])[0];
const configured = new Map(); // listing id -> slug
for (const c of CLIENTS) for (const id of [].concat((c.windsor || {}).google_my_business || [])) configured.set(id, c.slug);

const extra = {};   // slug -> [{id,title}]
let listings = [];
try {
  listings = (await discoverListings()).map((l) => {
    if (configured.has(l.id)) return { ...l, slug: configured.get(l.id), how: 'clients.json' };
    const linked = (OPS.gbp_links || {})[l.id];
    const byName = allAliasMatches(l.title || '');
    const client = linked || (byName.length === 1 ? byName[0] : null);
    const slug = client ? slugOfClient(client) : null;
    if (slug) (extra[slug] = extra[slug] || []).push(l);
    return { ...l, slug: slug || null, client: client || null, how: linked ? 'gbp_links' : (slug ? 'name match' : null) };
  });
  console.log(`  listings: ${listings.length} in Windsor, ${listings.filter((l) => !l.slug).length} not linked to a client`);
} catch (err) {
  console.log(`  ✗ listing discovery: ${err.message}`);
}
writeFileSync('series/_gbp_discovery.json', JSON.stringify({ generated_at: new Date().toISOString(), ok: listings.length > 0, listings }, null, 1));

// ── 2. history per client ───────────────────────────────────────────────
const bySlug = new Map(CLIENTS.filter((c) => c.active !== false).map((c) => [c.slug, c]));
for (const slugs of Object.values(OPS.ad_slugs || {})) for (const s of slugs) if (!bySlug.has(s) && extra[s]) bySlug.set(s, { slug: s, windsor: {}, gbp_labels: {} });

for (const client of bySlug.values()) {
  const windsor = { ...(client.windsor || {}) };
  const labels = { ...(client.gbp_labels || {}) };
  if (extra[client.slug]) {
    windsor.google_my_business = [...new Set([].concat(windsor.google_my_business || [], extra[client.slug].map((l) => l.id)))];
    for (const l of extra[client.slug]) labels[l.id] = labels[l.id] || l.title;
  }
  if (!Object.keys(windsor).length) continue;
  try {
    const raw = await fetchWindsor(windsor, KEY, labels, HISTORY_DAYS);
    const profileLabels = Object.fromEntries((raw._gbpProfiles || []).map((p) => [p.account_id, p.label]));
    for (const id of [].concat(windsor.google_my_business || [])) profileLabels[id] = profileLabels[id] || labels[id] || id;
    writeFileSync(`series/${client.slug}.json`, JSON.stringify({
      generated_at: new Date().toISOString(), days: HISTORY_DAYS, kind: client.type === 'ecom' ? 'sales' : 'leads',
      connectors: Object.keys(windsor).filter((k) => !/_fields?$/.test(k)), profile_labels: profileLabels, rows: raw._dailyRows || [],
    }));
    console.log(`  ✓ ${client.slug}: ${(raw._dailyRows || []).length} days, ${Object.keys(profileLabels).length} listings`);
  } catch (err) {
    console.log(`  ✗ ${client.slug}: ${err.message}`);
  }
}
