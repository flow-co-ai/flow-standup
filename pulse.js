// Daily Pulse — numbers-only, no AI calls.
// Writes pulse/[slug].json and history/[slug].json for every client.

import { fetchWindsor } from './fetch_windsor.js';
import { fetchGHL }     from './fetch_ghl.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require         = createRequire(import.meta.url);
const CLIENTS         = require('./clients.json');
const WINDSOR_TOKEN   = process.env.WINDSOR_API_KEY    || '';
const GHL_TOKEN       = process.env.GHL_API_TOKEN      || '';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY  || '';
const GHL_TOKENS      = (() => {
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

// --- Deltas from _dailyRows (last 7 vs prior 7) ---

function computeDeltas7(dailyRows, clientType) {
  const last7  = dailyRows.slice(-7);
  const prior7 = dailyRows.length >= 14 ? dailyRows.slice(-14, -7) : [];

  const sum = (rows, f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0);
  const pct = (last, prior) => prior > 0 ? round2((last - prior) / prior * 100) : null;

  const lastSpend  = sum(last7, 'spend');
  const priorSpend = sum(prior7, 'spend');
  const lastLeads  = sum(last7, 'leads');
  const priorLeads = sum(prior7, 'leads');
  const lastCPL    = lastLeads  > 0 ? lastSpend  / lastLeads  : 0;
  const priorCPL   = priorLeads > 0 ? priorSpend / priorLeads : 0;

  const deltas = {
    spend_7d_pct:        pct(lastSpend,             priorSpend),
    leads_7d_pct:        pct(lastLeads,             priorLeads),
    cpl_7d_pct:          priorCPL > 0 ? round2((lastCPL - priorCPL) / priorCPL * 100) : null,
    meta_leads_7d_pct:   pct(lastLeads,             priorLeads),
    google_spend_7d_pct: pct(sum(last7, 'google_spend'), sum(prior7, 'google_spend')),
    gbp_7d_pct:          pct(sum(last7, 'gbp_actions'), sum(prior7, 'gbp_actions')),
    sc_7d_pct:           pct(sum(last7, 'sc_clicks'),   sum(prior7, 'sc_clicks')),
    ga4_7d_pct:          pct(sum(last7, 'ga4_sessions'),sum(prior7, 'ga4_sessions')),
    ig_7d_pct:           pct(sum(last7, 'ig_reach'),    sum(prior7, 'ig_reach')),
    spend_per_day_7d:    round2(lastSpend / 7),
  };

  if (clientType === 'ecom') {
    const lastPurch  = sum(last7, 'purchases');
    const priorPurch = sum(prior7, 'purchases');
    const lastRev    = sum(last7, 'revenue');
    const priorRev   = sum(prior7, 'revenue');
    const lastROAS   = lastSpend  > 0 ? lastRev  / lastSpend  : 0;
    const priorROAS  = priorSpend > 0 ? priorRev / priorSpend : 0;
    deltas.purchases_7d_pct = pct(lastPurch, priorPurch);
    deltas.roas_7d_pct      = priorROAS > 0 ? round2((lastROAS - priorROAS) / priorROAS * 100) : null;
  }

  return deltas;
}

// --- Anomaly flags ---

function computeFlags(latestDay, dailyRows) {
  const flags = [];
  if (!latestDay || !dailyRows.length) return flags;

  const recent = dailyRows.slice(-Math.min(dailyRows.length, 7));
  const avg7dSpend = recent.reduce((s, r) => s + r.spend, 0) / recent.length;

  if (latestDay.spend === 0 && avg7dSpend > 0) flags.push('zero_spend_day');

  let streak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].leads === 0 && recent[i].spend > 0) streak++;
    else break;
  }
  if (streak >= 3) flags.push('lead_drought');

  if (dailyRows.length >= 9) {
    const last2   = dailyRows.slice(-2);
    const prior7d = dailyRows.slice(-9, -2);

    const hadMeta    = prior7d.some(r => r.meta_spend   > 0);
    const hadGoogle  = prior7d.some(r => r.google_spend  > 0);
    const darkMeta   = last2.every(r => r.meta_spend   === 0);
    const darkGoogle = last2.every(r => r.google_spend  === 0);

    if (hadMeta   && darkMeta)   flags.push('channel_dark:meta');
    if (hadGoogle && darkGoogle) flags.push('channel_dark:google');
  }

  return flags;
}

// --- Score (0-100) ---

function computeScore(deltas, flags, windsor, ghl, clientType) {
  if (windsor?.error) return 20;

  let score = 100;

  // Primary performance signal: leads (leadgen) or worst of roas/purchases (ecom).
  let leadSignal;
  if (clientType === 'ecom') {
    const r = deltas.roas_7d_pct;
    const p = deltas.purchases_7d_pct;
    leadSignal = (r != null && p != null) ? Math.min(r, p) : (r ?? p ?? null);
  } else {
    leadSignal = deltas.leads_7d_pct ?? null;
  }
  if (leadSignal != null && leadSignal < 0) {
    score -= Math.min(30, Math.abs(leadSignal) * 0.3);
  }

  // CPL penalty (leadgen only): positive cpl delta = worse.
  if (clientType !== 'ecom' && deltas.cpl_7d_pct != null && deltas.cpl_7d_pct > 0) {
    score -= Math.min(20, deltas.cpl_7d_pct * 0.2);
  }

  // Channel deltas <= -30 → -10 each, capped at -20 total.
  const channelPenalty = [
    deltas.gbp_7d_pct,
    deltas.sc_7d_pct,
    deltas.ga4_7d_pct,
    deltas.ig_7d_pct,
    deltas.google_spend_7d_pct,
  ].reduce((pen, d) => pen + (d != null && d <= -30 ? 10 : 0), 0);
  score -= Math.min(20, channelPenalty);

  if (flags.includes('lead_drought')) score -= 20;
  score -= flags.filter(f => f.startsWith('channel_dark')).length * 10;
  if (ghl?.error) score -= 5;

  return Math.round(Math.max(0, Math.min(100, score)));
}

// --- Verdict ---

function buildVerdictFallback(name, deltas, flags) {
  const CANDIDATES = [
    { key: 'leads_7d_pct',       label: 'leads' },
    { key: 'purchases_7d_pct',   label: 'purchases' },
    { key: 'roas_7d_pct',        label: 'ROAS' },
    { key: 'cpl_7d_pct',         label: 'cost per lead' },
    { key: 'spend_7d_pct',       label: 'spend' },
    { key: 'sc_7d_pct',          label: 'search clicks' },
    { key: 'ga4_7d_pct',         label: 'website sessions' },
    { key: 'gbp_7d_pct',         label: 'Google Business actions' },
    { key: 'ig_7d_pct',          label: 'Instagram reach' },
    { key: 'google_spend_7d_pct',label: 'Google Ads spend' },
  ].filter(c => deltas[c.key] != null)
   .sort((a, b) => Math.abs(deltas[b.key]) - Math.abs(deltas[a.key]));

  if (!CANDIDATES.length) return `${name}: no significant week-over-week movement in the last 7 days.`;

  const top = CANDIDATES[0];
  const val = deltas[top.key];
  const dir = val > 0 ? 'up' : 'down';
  let sentence = `${name} ${top.label} is ${dir} ${Math.abs(val)}% vs the prior 7 days.`;

  if (flags.includes('lead_drought'))               sentence += ' Lead drought flag is active.';
  else if (flags.some(f => f.startsWith('channel_dark'))) sentence += ' A channel dark flag is active.';

  return sentence;
}

async function callVerdict(name, clientType, totals, deltas, flags, topCampaign) {
  const fallback = buildVerdictFallback(name, deltas, flags);
  if (!ANTHROPIC_KEY) return fallback;

  // Build a compact, non-null delta map for the prompt.
  const deltaSlim = Object.fromEntries(
    Object.entries(deltas).filter(([k, v]) => v !== null && k !== 'spend_per_day_7d' && k !== 'meta_leads_7d_pct'),
  );

  const prompt = [
    `Client: ${name} (${clientType})`,
    `Totals (28d): ${JSON.stringify(totals)}`,
    `7d vs prior-7d deltas (%): ${JSON.stringify(deltaSlim)}`,
    `Flags: ${flags.join(', ') || 'none'}`,
    topCampaign?.name ? `Top campaign: "${topCampaign.name}" ($${topCampaign.spend} spend)` : null,
    '',
    'Rules: 1-2 sentences. Name the biggest movement and its likely driver. Use exact numbers from the data. Never invent numbers not shown above. No URLs. No em dashes.',
  ].filter(l => l !== null).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:       'claude-sonnet-4-6',
        max_tokens:  200,
        temperature: 0,
        tools: [{
          name:         'emit_verdict',
          description:  'Emit a short performance verdict for the client.',
          input_schema: {
            type:       'object',
            properties: { verdict: { type: 'string' } },
            required:   ['verdict'],
          },
        }],
        tool_choice: { type: 'tool', name: 'emit_verdict' },
        messages:    [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.warn(`  Verdict API ${res.status} — using fallback`);
      return fallback;
    }

    const json  = await res.json();
    const block = json.content?.find(b => b.type === 'tool_use' && b.name === 'emit_verdict');
    return block?.input?.verdict || fallback;

  } catch (err) {
    console.warn(`  Verdict error: ${err.message} — using fallback`);
    return fallback;
  }
}

// --- Per-client processing ---

async function processClient(client) {
  console.log(`\nProcessing ${client.slug} (${client.name})...`);

  const clientType = client.type || 'leadgen';

  // Windsor
  let windsorOut = null;
  let sources    = [];

  if (client.windsor && WINDSOR_TOKEN) {
    try {
      const raw = await fetchWindsor(client.windsor, WINDSOR_TOKEN);

      // Extract internal fields before writing.
      const { _dailyRows, _latestDay, _sources, ...metrics } = raw;
      sources = _sources;

      // Write history archive (90-day rolling); not used for delta computation.
      if (_latestDay) {
        if (!existsSync('history')) mkdirSync('history');
        updateHistory(client.slug, _latestDay);
      }

      const deltas = computeDeltas7(_dailyRows, clientType);
      const flags  = computeFlags(_latestDay, _dailyRows);

      const series = {
        dates:        _dailyRows.map(r => r.date),
        spend:        _dailyRows.map(r => r.spend),
        leads:        _dailyRows.map(r => r.leads),
        meta_spend:   _dailyRows.map(r => r.meta_spend),
        google_spend: _dailyRows.map(r => r.google_spend),
        gbp_actions:  _dailyRows.map(r => r.gbp_actions),
        ig_reach:     _dailyRows.map(r => r.ig_reach),
        sc_clicks:    _dailyRows.map(r => r.sc_clicks),
        ga4_sessions: _dailyRows.map(r => r.ga4_sessions),
        purchases:    _dailyRows.map(r => r.purchases),
        revenue:      _dailyRows.map(r => r.revenue),
      };

      windsorOut = { ...metrics, latest_day: _latestDay, deltas, flags, series };
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

  const score  = computeScore(windsorOut?.deltas ?? {}, windsorOut?.flags ?? [], windsorOut, ghl, clientType);
  const status = score >= 80 ? 'green' : score >= 50 ? 'amber' : 'orange';

  let verdict = null;
  if (windsorOut && !windsorOut.error) {
    try {
      verdict = await callVerdict(
        client.name,
        clientType,
        windsorOut.totals      ?? {},
        windsorOut.deltas      ?? {},
        windsorOut.flags       ?? [],
        windsorOut.top_campaign,
      );
    } catch (err) {
      console.warn(`  Verdict failed: ${err.message}`);
    }
  }

  const pulse = {
    generated_at: new Date().toISOString(),
    date:         dateStr(new Date()),
    slug:         client.slug,
    name:         client.name,
    type:         clientType,
    window_days:  28,
    score,
    status,
    verdict,
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
    if (client.active === false) {
      console.log(`\nSkipping ${client.slug} (inactive)`);
      continue;
    }
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
        type:         client.type || 'leadgen',
        window_days:  28,
        score:        20,
        status:       'orange',
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
