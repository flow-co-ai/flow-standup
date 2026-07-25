// Daily Pulse — numbers-only, no AI calls.
// Writes pulse/[slug].json and history/[slug].json for every client.

import { fetchWindsor } from './fetch_windsor.js';
import { fetchGHL }     from './fetch_ghl.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require       = createRequire(import.meta.url);
const CLIENTS       = require('./clients.json');
const WINDSOR_TOKEN = process.env.WINDSOR_API_KEY || '';
const GHL_TOKEN     = process.env.GHL_API_TOKEN   || '';
const GHL_TOKENS    = (() => {
  try { return process.env.GHL_TOKENS ? JSON.parse(process.env.GHL_TOKENS) : {}; }
  catch { console.warn('Warning: GHL_TOKENS is not valid JSON — ignoring'); return {}; }
})();

// --- Helpers ---

function round2(n) { return Math.round(n * 100) / 100; }
function dateStr(d) { return d.toISOString().slice(0, 10); }

// --- History management (unchanged) ---

function updateHistory(slug, newRow) {
  const path = `history/${slug}.json`;
  let history = [];

  if (existsSync(path)) {
    try {
      history = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      console.warn(`  Warning: corrupt history file, starting fresh (${e.message})`);
    }
  }

  const idx = history.findIndex(r => r.date === newRow.date);
  if (idx >= 0) {
    history[idx] = newRow;
  } else {
    history.push(newRow);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > 90) history = history.slice(-90);

  writeFileSync(path, JSON.stringify(history, null, 2));
  return history;
}

// --- Deltas (unchanged) ---

function computeDeltas(history) {
  if (history.length < 14) {
    return { spend_7d_pct: null, leads_7d_pct: null, spend_per_day_7d: null };
  }

  const last7  = history.slice(-7);
  const prior7 = history.slice(-14, -7);

  const last7Spend  = last7.reduce((s, r) => s + r.spend, 0);
  const prior7Spend = prior7.reduce((s, r) => s + r.spend, 0);
  const last7Leads  = last7.reduce((s, r) => s + r.leads, 0);
  const prior7Leads = prior7.reduce((s, r) => s + r.leads, 0);

  return {
    spend_7d_pct:     prior7Spend > 0 ? round2((last7Spend  - prior7Spend)  / prior7Spend  * 100) : null,
    leads_7d_pct:     prior7Leads > 0 ? round2((last7Leads  - prior7Leads)  / prior7Leads  * 100) : null,
    spend_per_day_7d: round2(last7Spend / 7),
  };
}

// --- Anomaly flags (unchanged) ---

function computeFlags(latestDay, history) {
  const flags = [];
  if (!latestDay || !history.length) return flags;

  const recent = history.slice(-Math.min(history.length, 7));
  const avg7dSpend = recent.reduce((s, r) => s + r.spend, 0) / recent.length;

  if (latestDay.spend === 0 && avg7dSpend > 0) flags.push('zero_spend_day');

  let streak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].leads === 0 && recent[i].spend > 0) streak++;
    else break;
  }
  if (streak >= 3) flags.push('lead_drought');

  if (history.length >= 9) {
    const last2   = history.slice(-2);
    const prior7h = history.slice(-9, -2);

    const hadMeta    = prior7h.some(r => r.meta_spend   > 0);
    const hadGoogle  = prior7h.some(r => r.google_spend  > 0);
    const darkMeta   = last2.every(r => r.meta_spend   === 0);
    const darkGoogle = last2.every(r => r.google_spend  === 0);

    if (hadMeta   && darkMeta)   flags.push('channel_dark:meta');
    if (hadGoogle && darkGoogle) flags.push('channel_dark:google');
  }

  return flags;
}

// --- Per-client processing ---

async function processClient(client) {
  console.log(`\nProcessing ${client.slug} (${client.name})...`);

  // Windsor
  let windsorOut = null;
  let sources    = [];

  if (client.windsor && WINDSOR_TOKEN) {
    try {
      const raw = await fetchWindsor(client.windsor, WINDSOR_TOKEN);

      // Extract internal fields before writing.
      const { _dailyRows, _latestDay, _sources, ...metrics } = raw;
      sources = _sources;

      // Update history and compute deltas/flags only when we have daily data.
      let deltas   = { spend_7d_pct: null, leads_7d_pct: null, spend_per_day_7d: null };
      let flags    = [];
      let latestDay = _latestDay;

      if (_latestDay) {
        if (!existsSync('history')) mkdirSync('history');
        const history = updateHistory(client.slug, _latestDay);
        deltas    = computeDeltas(history);
        flags     = computeFlags(_latestDay, history);
      }

      windsorOut = { ...metrics, latest_day: latestDay, deltas, flags };
      console.log(`  Windsor: spend $${metrics.totals?.spend} | leads ${metrics.totals?.leads} | sources: ${sources.join(', ')}`);

    } catch (err) {
      windsorOut = { error: err.message };
      console.error(`  Windsor error: ${err.message}`);
    }
  } else if (client.windsor && !WINDSOR_TOKEN) {
    console.warn(`  WINDSOR_API_KEY not set — skipping Windsor for ${client.slug}`);
    windsorOut = { error: 'WINDSOR_API_KEY_not_set' };
  } else {
    windsorOut = { error: 'no_windsor_config' };
  }

  // GHL — prefer per-location token from GHL_TOKENS map, fall back to GHL_TOKEN
  let ghl = null;
  const locationToken = GHL_TOKENS[client.ghl_location_id] || GHL_TOKEN;
  if (client.ghl_location_id && locationToken) {
    try {
      ghl = await fetchGHL(client.ghl_location_id, locationToken);
      console.log(`  GHL: ${ghl.contacts} contacts, ${ghl.opportunities.created.count} opps, ${ghl.appointments} appts`);
    } catch (err) {
      ghl = { error: err.message };
      console.error(`  GHL error: ${err.message}`);
    }
  } else if (client.ghl_location_id && !locationToken) {
    console.warn(`  GHL_API_TOKEN not set — skipping GHL for ${client.slug}`);
  }

  if (!existsSync('pulse')) mkdirSync('pulse');

  const pulse = {
    generated_at: new Date().toISOString(),
    date:         dateStr(new Date()),
    slug:         client.slug,
    name:         client.name,
    window_days:  28,
    windsor:      windsorOut,
    ghl,
    _meta: {
      source:  'windsor_api',
      sources,
    },
  };

  writeFileSync(`pulse/${client.slug}.json`, JSON.stringify(pulse, null, 2));
  console.log(`  ✓ pulse/${client.slug}.json written`);
  return true;
}

// --- Main ---

async function main() {
  console.log('=== Flow Analyst — Daily Pulse ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  if (!existsSync('pulse'))   mkdirSync('pulse');
  if (!existsSync('history')) mkdirSync('history');

  if (!WINDSOR_TOKEN) console.warn('Warning: WINDSOR_API_KEY not set — Windsor blocks will error for all clients\n');
  if (!GHL_TOKEN)     console.warn('Warning: GHL_API_TOKEN not set — GHL blocks will be null for all clients\n');

  let succeeded = 0;
  const failed  = [];

  for (const client of CLIENTS) {
    try {
      await processClient(client);
      succeeded++;
    } catch (err) {
      console.error(`  ✗ ${client.slug} failed: ${err.message}`);
      const failPulse = {
        generated_at: new Date().toISOString(),
        date:         dateStr(new Date()),
        slug:         client.slug,
        name:         client.name,
        window_days:  28,
        windsor:      { error: err.message },
        ghl:          null,
        _meta:        { source: 'windsor_api', sources: [] },
      };
      if (!existsSync('pulse')) mkdirSync('pulse');
      writeFileSync(`pulse/${client.slug}.json`, JSON.stringify(failPulse, null, 2));
      failed.push(client.slug);
    }
  }

  console.log(`\n=== Done: ${succeeded}/${CLIENTS.length} clients succeeded ===`);
  if (failed.length) console.log(`Failed: ${failed.join(', ')}`);

  if (succeeded === 0) process.exit(1);
}

main();
