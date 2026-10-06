// build_history.js -- longer daily history for the Ops page's 30 and 90-day ranges.
//
// pulse.js only keeps 28 days. This pulls the last HISTORY_DAYS days per client
// from Windsor (same fetcher, same fields) and writes series/<slug>.json:
// one row per day with spend, leads, per-channel results and per-listing
// Google profile actions. Aggregates only -- Windsor never returns PII.
// 186 days = two 90-day windows plus a few days for Google profile lag.
//
// Run after pulse.js:  node build_history.js   (needs WINDSOR_API_KEY)

import { fetchWindsor } from './fetch_windsor.js';
import { writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');
const HISTORY_DAYS = 186;
const KEY = process.env.WINDSOR_API_KEY;

if (!KEY) { console.log('build_history: WINDSOR_API_KEY not set, skipping.'); process.exit(0); }
mkdirSync('series', { recursive: true });

for (const client of CLIENTS) {
  if (client.active === false || !client.windsor) continue;
  try {
    const raw = await fetchWindsor(client.windsor, KEY, client.gbp_labels || {}, HISTORY_DAYS);
    const labels = Object.fromEntries((raw._gbpProfiles || []).map((p) => [p.account_id, p.label]));
    writeFileSync(`series/${client.slug}.json`, JSON.stringify({
      generated_at: new Date().toISOString(),
      days: HISTORY_DAYS,
      kind: client.type === 'ecom' ? 'sales' : 'leads',
      profile_labels: labels,
      rows: raw._dailyRows || [],
    }));
    console.log(`  ✓ ${client.slug}: ${(raw._dailyRows || []).length} days`);
  } catch (err) {
    console.log(`  ✗ ${client.slug}: ${err.message}`);   // keep going; the page falls back to 28 days
  }
}
