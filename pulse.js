// Daily Pulse: numbers only, no AI calls.
// Writes pulse/[slug].json and history/[slug].json for every active client.
// Connector failures are written to pulse.windsor.errors and pulse.ghl.error so
// the Sources page shows them. A failure never reads as a zero.

import { fetchWindsor } from './fetch_windsor.js';
import { fetchGHL }     from './fetch_ghl.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require         = createRequire(import.meta.url);
const CLIENTS         = require('./clients.json');
const WINDSOR_TOKEN   = process.env.WINDSOR_API_KEY    || '';
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

function computeFlags(latestDay, dailyRows, gbpProfiles = [], ghl = null, clientType = 'leadgen') {
  const flags = [];
  if (!latestDay || !dailyRows.length) return flags;

  const recent = dailyRows.slice(-Math.min(dailyRows.length, 7));
  const avg7dSpend = recent.reduce((s, r) => s + r.spend, 0) / recent.length;

  if (latestDay.spend === 0 && avg7dSpend > 0) flags.push('zero_spend_day');

  if (clientType !== 'ecom') {
    let streak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].leads === 0 && recent[i].spend > 0) streak++;
      else break;
    }
    if (streak >= 3) {
      if (ghl && !ghl.error && (ghl.contacts ?? 0) > 0) {
        // Windsor shows no leads but GHL has contacts — tracking gap, not demand collapse.
        flags.push('attribution_gap');
      } else {
        flags.push('lead_drought');
      }
    }
  }

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

  if (gbpProfiles.length > 0) {
    for (const profile of gbpProfiles) {
      if (profile.impressions === 0 && dailyRows.length > 3) {
        flags.push(`gbp_profile_dark:${profile.label}`);
      } else if (profile.impressions > 0 && profile.calls === 0) {
        if (profile.calls_prior > 0) {
          flags.push(`gbp_conversion_break:${profile.label}`);
        } else {
          flags.push(`gbp_no_calls_with_impressions:${profile.label}`);
        }
      }
    }

    if (gbpProfiles.length >= 2) {
      const bestRate = Math.max(...gbpProfiles.map(p => p.call_rate ?? 0));
      if (bestRate > 0) {
        for (const profile of gbpProfiles) {
          if (profile.impressions < 50) continue;
          if (profile.call_rate == null) continue;
          if (flags.some(f => f === `gbp_no_calls_with_impressions:${profile.label}`)) continue;
          if (profile.call_rate < bestRate / 2) {
            flags.push(`gbp_low_call_rate:${profile.label}`);
          }
        }
      }
    }
  }

  return flags;
}

// --- Lead-source reconciliation ---

function computeReconciliation(windsor, ghl) {
  const windsorLeads   = windsor?.totals?.leads ?? null;
  const ghlContacts    = ghl?.contacts ?? null;
  const ghlOppsCreated = ghl?.opportunities?.created?.count ?? null;
  const ghlOppsWon     = ghl?.opportunities?.won?.count ?? null;

  let status;
  if (!ghl || ghl.error || ghlContacts == null) {
    status = 'ghl_unavailable';
  } else if ((windsorLeads ?? 0) === 0 && ghlContacts === 0) {
    status = 'both_zero';
  } else if ((windsorLeads ?? 0) > 0 && ghlContacts === 0) {
    status = 'windsor_only';
  } else if ((windsorLeads ?? 0) === 0 && ghlContacts > 0) {
    status = 'ghl_only';
  } else {
    status = 'both_active';
  }

  return { windsor_leads: windsorLeads, ghl_contacts: ghlContacts, ghl_opps_created: ghlOppsCreated, ghl_opps_won: ghlOppsWon, status };
}

// --- Per-client processing ---

async function processClient(client) {
  console.log(`\nProcessing ${client.slug} (${client.name})...`);

  const clientType = client.type || 'leadgen';

  // Windsor
  let windsorOut = null;
  let sources    = [];
  let flagInputs = null;

  if (client.windsor && WINDSOR_TOKEN) {
    try {
      const raw = await fetchWindsor(client.windsor, WINDSOR_TOKEN, client.gbp_labels || {});

      // Extract internal fields before writing.
      const { _dailyRows, _latestDay, _sources, _gbpProfiles, _errors, ...metrics } = raw;
      sources = _sources;

      // Write history archive (90-day rolling); not used for delta computation.
      let gbpProfilesWithPrior = _gbpProfiles ?? [];
      if (_latestDay) {
        if (!existsSync('history')) mkdirSync('history');
        // Update every day in the 28-day fetch window, not just yesterday.
        // A config change (e.g. meta_leads_field) self-corrects on the next
        // run without a separate backfill step.
        let history = [];
        for (const row of _dailyRows) {
          history = updateHistory(client.slug, row);
        }

        // Derive per-profile calls_prior from the 90-day archive (prior period = 8–14 days back).
        const latestDate     = new Date(_latestDay.date + 'T00:00:00Z');
        const priorEndDate   = dateStr(new Date(latestDate.getTime() -  7 * 86400000));
        const priorStartDate = dateStr(new Date(latestDate.getTime() - 13 * 86400000));
        const callsPrior = {};
        for (const row of history) {
          if (row.date < priorStartDate || row.date > priorEndDate || !row.gbp_profiles) continue;
          for (const [id, calls] of Object.entries(row.gbp_profiles)) {
            callsPrior[id] = (callsPrior[id] ?? 0) + calls;
          }
        }
        gbpProfilesWithPrior = (_gbpProfiles ?? []).map(p => ({
          ...p,
          calls_prior: callsPrior[p.account_id] ?? 0,
        }));
      }

      const deltas = computeDeltas7(_dailyRows, clientType);
      flagInputs = { latestDay: _latestDay, dailyRows: _dailyRows, gbpProfiles: gbpProfilesWithPrior };

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
        purchases:        _dailyRows.map(r => r.purchases),
        revenue:          _dailyRows.map(r => r.revenue),
        ctc_call_confirm: _dailyRows.map(r => r.ctc_call_confirm || 0),
        ctc_call_placed:  _dailyRows.map(r => r.ctc_call_placed  || 0),
        ctc_20s_connect:  _dailyRows.map(r => r.ctc_20s_connect  || 0),
        ctc_60s_connect:  _dailyRows.map(r => r.ctc_60s_connect  || 0),
      };

      windsorOut = { ...metrics, latest_day: _latestDay, deltas, flags: [], series, errors: _errors || [] };
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

  // GHL: one sub-account Private Integration token per location.
  // A per-client secret (GHL_TOKEN_MEDSTATION, GHL_TOKEN_SENIOR_INSURANCE, ...)
  // wins over the GHL_TOKENS map. There is no agency-token fallback: agency
  // tokens cannot read a location and only produce "Invalid JWT".
  let ghl = null;
  if (client.ghl_location_id) {
    const envKey = 'GHL_TOKEN_' + client.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const locationToken = process.env[envKey] || GHL_TOKENS[client.ghl_location_id] || '';
    if (!locationToken) {
      ghl = { error: `No token. Add ${envKey} (or this location in GHL_TOKENS) to GitHub secrets.` };
      console.warn(`  GHL: ${ghl.error}`);
    } else {
      try {
        ghl = await fetchGHL(client.ghl_location_id, locationToken);
        console.log(`  GHL: ${ghl.contacts} contacts, ${ghl.opportunities.created.count} opps, ${ghl.appointments} appts`);
      } catch (err) {
        const msg = String(err.message || err);
        ghl = { error: /401|Invalid JWT/i.test(msg)
          ? `Token rejected (${msg.slice(0, 80)}). Create a sub-account Private Integration token for location ${client.ghl_location_id} and save it as ${envKey}.`
          : msg.slice(0, 300) };
        console.error(`  GHL error: ${ghl.error}`);
      }
    }
  }

  if (windsorOut && !windsorOut.error && flagInputs) {
    windsorOut.flags = computeFlags(flagInputs.latestDay, flagInputs.dailyRows, flagInputs.gbpProfiles, ghl, clientType);
  }

  const reconciliation = computeReconciliation(windsorOut, ghl);

  if (!existsSync('pulse')) mkdirSync('pulse');

  const pulse = {
    generated_at: new Date().toISOString(),
    date:         dateStr(new Date()),
    slug:         client.slug,
    name:         client.name,
    type:         clientType,
    window_days:  28,
    windsor:      windsorOut,
    ghl,
    reconciliation,
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
        windsor:      { error: err.message, errors: [{ connector: 'all', accounts: [], message: String(err.message).slice(0, 300) }] },
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
