// build_cards.js — pure assembly of L2 files into cards/[slug].json
//
// No model calls. No network. Runs after build_timeline.js.
// Steel exception: each of steel-forte/-advance/-ohare gets its own card reading
// its own pulse/facts/comms files, but all three share timeline/steel-round-bars.plan.json
// for the contract block.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');

// ── constants ─────────────────────────────────────────────────────────────────

const STEEL_SUBS      = new Set(['steel-forte', 'steel-advance', 'steel-ohare']);
const STEEL_PLAN_SLUG = 'steel-round-bars';
const INACTIVE        = new Set(CLIENTS.filter(c => c.active === false).map(c => c.slug));

// ── helpers ───────────────────────────────────────────────────────────────────

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isoToday() { return new Date().toISOString().slice(0, 10); }

function fmt$(n) {
  if (n == null || isNaN(n)) return '$0.00';
  return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtInt$(n) {
  if (n == null || isNaN(n)) return '$0';
  return '$' + Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function readHistory(slug) {
  return readJSON(`history/${slug}.json`) || [];
}

// 14d paid metrics from history. Returns { spend, leads, cpl, days } or null.
function paid14d(slug) {
  const rows = readHistory(slug).slice(-14);
  if (!rows.length) return null;
  const spend     = rows.reduce((s, r) => s + (r.spend        || 0), 0);
  const leads     = rows.reduce((s, r) => s + (r.leads        || 0), 0);
  const metaSpend = rows.reduce((s, r) => s + (r.meta_spend   || 0), 0);
  const gadSpend  = rows.reduce((s, r) => s + (r.google_spend || 0), 0);
  return { spend, leads, cpl: leads > 0 ? spend / leads : null, days: rows.length, meta_spend: metaSpend, gad_spend: gadSpend };
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function monthsBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
}

// "gbp_no_calls_with_impressions:Profile Name" → { flagType, profile }
function parseGbpFlag(f) {
  for (const prefix of ['gbp_conversion_break:', 'gbp_no_calls_with_impressions:', 'gbp_low_call_rate:']) {
    if (f.startsWith(prefix)) return { flagType: prefix.slice(0, -1), profile: f.slice(prefix.length) };
  }
  return null;
}

function resolveFact(factsData, id) {
  if (!id || !factsData?.facts) return null;
  return factsData.facts.find(f => f.id === id) || null;
}

function inboxForName(byClient, displayName) {
  if (!byClient || !displayName) return [];
  const dn = displayName.toLowerCase();
  const items = [];
  for (const [clientName, entries] of Object.entries(byClient)) {
    const nl = clientName.toLowerCase();
    if (nl.includes(dn) || dn.includes(nl)) items.push(...(entries || []));
  }
  return items;
}

// ── organic lane ──────────────────────────────────────────────────────────────

function buildOrganicLane(client, pulse) {
  const hasGbp = (client.windsor?.google_my_business || []).length > 0;

  if (!hasGbp) {
    return {
      state:    'quiet',
      headline: 'no GBP',
      sentence: 'No Google Business Profile configured.',
      basis:    { type: 'not_found', source: 'clients.json', window: 'config' },
      flags:    [],
      detail:   {},
    };
  }

  if (!pulse) {
    return {
      state:    'unknown',
      headline: 'no data',
      sentence: 'Pulse data unavailable.',
      basis:    { type: 'unavailable', source: 'Windsor GBP', window: '28d' },
      flags:    [],
      detail:   {},
    };
  }

  const allProfiles = pulse.windsor?.totals?.byChannel?.gbp?.by_profile || [];
  const gbpFlagMap  = {}; // profile label → [flagType, ...]
  const rawGbpFlags = [];

  for (const f of pulse.windsor?.flags || []) {
    const parsed = parseGbpFlag(f);
    if (!parsed) continue;
    rawGbpFlags.push(f);
    if (!gbpFlagMap[parsed.profile]) gbpFlagMap[parsed.profile] = [];
    gbpFlagMap[parsed.profile].push(parsed.flagType);
  }

  const flaggedProfiles = allProfiles.filter(p => gbpFlagMap[p.label || p.account_id]);
  const totalProfiles   = allProfiles.length;
  const totalCalls      = allProfiles.reduce((s, p) => s + (p.calls || 0), 0);

  const hasConversionBreak = Object.values(gbpFlagMap).some(arr => arr.includes('gbp_conversion_break'));
  const hasAmberFlag       = Object.values(gbpFlagMap).some(arr =>
    arr.includes('gbp_no_calls_with_impressions') || arr.includes('gbp_low_call_rate')
  );

  let state;
  if (hasConversionBreak)     state = 'red';
  else if (hasAmberFlag)      state = 'amber';
  else if (totalProfiles > 0) state = 'green';
  else                        state = 'unknown';

  const callsHeadline = `${totalCalls} call${totalCalls !== 1 ? 's' : ''}`;
  const activeCount   = totalProfiles - flaggedProfiles.length;
  const headline = (flaggedProfiles.length > 0 && totalProfiles > 1)
    ? `${activeCount} of ${totalProfiles} profiles active`
    : callsHeadline;

  const sentenceProfiles = flaggedProfiles.length > 0 ? flaggedProfiles : allProfiles;
  const sentence = sentenceProfiles.length
    ? sentenceProfiles.map(p => `${p.label || p.account_id} took ${p.calls} calls on ${p.impressions} impressions`).join('; ') + '.'
    : `${totalCalls} calls across ${totalProfiles} profile${totalProfiles !== 1 ? 's' : ''}.`;

  return {
    state,
    headline,
    sentence,
    basis:  { type: 'observed', source: 'Windsor GBP', window: '28d' },
    flags:  rawGbpFlags,
    detail: {
      profiles:         allProfiles,
      flagged_profiles: flaggedProfiles.map(p => ({
        label: p.label || p.account_id,
        flags: gbpFlagMap[p.label || p.account_id] || [],
      })),
      total_calls:    totalCalls,
      total_profiles: totalProfiles,
    },
  };
}

// ── paid lane ─────────────────────────────────────────────────────────────────

function buildPaidLane(client, pulse, slug) {
  const hasMeta = (client.windsor?.facebook || []).length > 0;
  const hasGAds = (client.windsor?.google_ads || []).length > 0;

  if (!hasMeta && !hasGAds) {
    return {
      state:    'quiet',
      headline: 'no paid',
      sentence: 'No paid channels configured.',
      basis:    { type: 'not_found', source: 'clients.json', window: 'config' },
      flags:    [],
      detail:   {},
    };
  }

  if (!pulse) {
    return {
      state:    'unknown',
      headline: 'no data',
      sentence: 'Pulse data unavailable.',
      basis:    { type: 'unavailable', source: 'Windsor Paid', window: '28d' },
      flags:    [],
      detail:   {},
    };
  }

  const byCh      = pulse.windsor?.totals?.byChannel || {};
  const metaSpend = byCh.meta?.spend       || 0;
  const metaLeads = byCh.meta?.leads       || 0;
  const metaClicks= byCh.meta?.clicks      || 0;
  const gadSpend  = byCh.google_ads?.spend       || 0;
  const gadConvs  = byCh.google_ads?.conversions || 0;
  const gadClicks = byCh.google_ads?.clicks      || 0;
  const allFlags  = pulse.windsor?.flags || [];
  const recon     = pulse.windsor?.reconciliation || null;
  const totalSpend = metaSpend + gadSpend;

  const hasLeadDrought = allFlags.includes('lead_drought');
  const hasAttribGap   = allFlags.includes('attribution_gap');
  const metaZero       = hasMeta && metaSpend === 0;
  const gadZero        = hasGAds  && gadSpend  === 0;

  let state;
  if (hasLeadDrought)                          state = 'red';
  else if (hasAttribGap || metaZero || gadZero) state = 'amber';
  else if (totalSpend > 0)                     state = 'green';
  else                                         state = 'unknown';

  const h14         = paid14d(slug);
  const labelPlural = client.meta_leads_label || 'leads';
  const labelSing   = labelPlural.replace(/s$/, '');

  // Sentence must use the same window and label as the headline.
  // When h14 is the headline source (14d history), sentence uses h14 too.
  // When h14 is absent, both fall back to 28d Windsor totals.
  const parts = [];
  if (h14) {
    if (hasMeta) parts.push(`Meta ${fmt$(h14.meta_spend)} spend, ${h14.leads} ${h14.leads === 1 ? labelSing : labelPlural}`);
    if (hasGAds) parts.push(`Google Ads ${fmt$(h14.gad_spend)} spend`);
  } else {
    if (hasMeta) parts.push(`Meta ${fmt$(metaSpend)} spend, ${metaLeads} ${metaLeads === 1 ? labelSing : labelPlural}`);
    if (hasGAds) parts.push(`Google Ads ${fmt$(gadSpend)} spend, ${gadConvs} conversions`);
  }
  let sentence = parts.join('; ') + '.';

  if (recon?.status === 'both_active') {
    const w = recon.windsor_leads ?? '?';
    const c = recon.ghl_contacts  ?? '?';
    const o = recon.ghl_opps_created ?? '?';
    sentence += ` Windsor ${w} leads, GHL ${c} contacts, ${o} opportunities, unreconciled.`;
  } else if (recon?.status === 'ghl_only') {
    sentence += ` Windsor reporting no leads; GHL active.`;
  } else if (recon?.status === 'windsor_only') {
    sentence += ` GHL reporting no contacts; Windsor active.`;
  }

  let paidHeadline;
  if (h14) {
    paidHeadline = h14.leads > 0
      ? `${fmtInt$(h14.spend)} · ${h14.leads} ${h14.leads === 1 ? labelSing : labelPlural} · ${fmtInt$(h14.cpl)} per ${labelSing}`
      : `${fmtInt$(h14.spend)} · no ${labelPlural}`;
  } else {
    paidHeadline = fmtInt$(totalSpend);
  }

  return {
    state,
    headline: paidHeadline,
    sentence,
    basis:  { type: 'observed', source: 'Windsor Paid', window: h14 ? '14d' : '28d' },
    flags:  allFlags.filter(f => f === 'lead_drought' || f === 'attribution_gap' || f.startsWith('channel_dark:')),
    detail: {
      meta:          hasMeta ? { spend: metaSpend, leads: metaLeads, clicks: metaClicks } : null,
      google_ads:    hasGAds  ? { spend: gadSpend,  convs: gadConvs,  clicks: gadClicks  } : null,
      total_spend:   totalSpend,
      reconciliation: recon,
    },
  };
}

// ── crm lane ──────────────────────────────────────────────────────────────────

function buildCrmLane(client, factsData, commsData, pulse) {
  const hasGhl   = (client.ghl_location_id || '').length > 0;
  const hasComms = commsData != null;

  if (!hasGhl && !hasComms) {
    return {
      state:    'quiet',
      headline: 'no CRM',
      sentence: 'No GHL and no comms on file.',
      basis:    { type: 'not_found', source: 'clients.json', window: 'config' },
      flags:    [],
      detail:   {},
    };
  }

  // Resolve intake owner from facts
  let intakeOwnerText = null;
  let intakeOwnerFact = null;
  let intakeOwnerBasis;

  if (!factsData) {
    intakeOwnerBasis = { type: 'unavailable', source: 'facts', window: 'current' };
  } else {
    const ownerId = factsData.current?.intake_owner;
    if (ownerId) {
      intakeOwnerFact = resolveFact(factsData, ownerId);
      if (intakeOwnerFact) {
        intakeOwnerText  = intakeOwnerFact.value;
        intakeOwnerBasis = {
          type:   'fact',
          source: intakeOwnerFact.source || 'whatsapp',
          window: intakeOwnerFact.stated_at?.slice(0, 10) || 'unknown',
        };
      } else {
        intakeOwnerBasis = { type: 'not_found', source: 'facts', window: 'current' };
      }
    } else {
      intakeOwnerBasis = { type: 'not_found', source: 'facts', window: 'current' };
    }
  }

  const awaiting    = commsData?.counts?.awaiting_flow    || 0;
  const oldestHours = commsData?.oldest_unanswered_hours || 0;

  let state;
  if (awaiting > 3 && oldestHours > 72) state = 'red';
  else if (awaiting > 0)                state = 'amber';
  else if (hasComms)                    state = 'green';
  else                                  state = 'unknown';

  const headline = awaiting > 0
    ? `${awaiting} waiting ${Math.round(oldestHours)}h`
    : (intakeOwnerText ? 'owner on file' : 'no owner');

  let ownerPart;
  if (intakeOwnerText) {
    const date   = intakeOwnerFact?.stated_at?.slice(0, 10) || 'unknown date';
    const source = intakeOwnerFact?.source || 'whatsapp';
    ownerPart = `${intakeOwnerText}, as of ${date} per ${source}.`;
  } else {
    const sources = factsData
      ? Object.keys(factsData.last_processed_at || { whatsapp: 1, fireflies: 1 }).join(', ')
      : 'known sources';
    ownerPart = `No intake owner found in ${sources}.`;
  }

  const commsPart = awaiting > 0
    ? ` ${awaiting} client thread${awaiting !== 1 ? 's' : ''} awaiting Flow, oldest ${Math.round(oldestHours)}h.`
    : '';

  return {
    state,
    headline,
    sentence: ownerPart + commsPart,
    basis:    { type: commsData ? 'observed' : 'fact', source: commsData ? 'GHL / WhatsApp' : 'facts', window: '14d' },
    flags:    awaiting > 0 ? [`awaiting_flow:${awaiting}`] : [],
    detail: {
      intake_owner:            intakeOwnerText,
      intake_owner_basis:      intakeOwnerBasis,
      awaiting_flow:           awaiting,
      oldest_unanswered_hours: oldestHours,
      threads:                 commsData?.counts || {},
      ghl:                     pulse?.ghl || null,
    },
  };
}

// ── dormant lane (no signal this week) ───────────────────────────────────────

function buildDormantLane() {
  return {
    state:    'dormant',
    headline: 'no activity this week',
    sentence: '',
    basis:    { type: 'not_found', source: 'Monday / Fireflies / WhatsApp', window: '7d' },
    flags:    [],
    detail:   {},
  };
}

// ── contract ──────────────────────────────────────────────────────────────────

function buildContract(plan, today) {
  if (!plan) {
    return {
      start: null, end: null, validated: false,
      month_of: null, months_total: null, days_left: null,
      basis: { type: 'unavailable', source: 'timeline/plan', window: 'engagement' },
    };
  }

  if (!plan.validated || !plan.engagement) {
    return {
      start: null, end: null, validated: false,
      month_of: null, months_total: null, days_left: null,
      basis: { type: 'not_found', source: 'timeline/plan', window: 'engagement' },
    };
  }

  const { start, end } = plan.engagement;
  if (!start || !end) {
    return {
      start: null, end: null, validated: plan.validated,
      month_of: null, months_total: null, days_left: null,
      basis: { type: 'not_found', source: 'timeline/plan', window: 'engagement' },
    };
  }

  const monthsTotal = monthsBetween(start, end);
  const monthOf     = Math.max(1, Math.min(monthsBetween(start, today) + 1, monthsTotal));
  const daysLeft    = daysBetween(today, end);

  return {
    start,
    end,
    validated:    true,
    month_of:     monthOf,
    months_total: monthsTotal,
    days_left:    daysLeft,
    basis:        { type: 'observed', source: 'timeline/plan', window: 'engagement' },
  };
}

// ── status & scope_out ────────────────────────────────────────────────────────

function buildStatus(lanes, daysLeft) {
  const states = Object.values(lanes).map(l => l.state);
  if (states.includes('red') || (daysLeft != null && daysLeft <= 30)) return 'critical';
  if (states.includes('amber')) return 'warn';
  if (states.every(s => s === 'unknown')) return 'unknown';
  return 'ok';
}

function buildScopeOut(lanes) {
  return Object.entries(lanes)
    .filter(([, lane]) => lane.state === 'quiet')
    .map(([name]) => name);
}

// ── needs_you ─────────────────────────────────────────────────────────────────

function buildNeedsYou(lanes, contract, commsData) {
  const items = [];

  if (lanes.organic.state === 'red' || lanes.organic.state === 'amber') {
    const flaggedLabels = lanes.organic.detail.flagged_profiles?.map(p => p.label).join(', ') || 'profiles';
    items.push({
      text:     `GBP issue (${lanes.organic.state}): ${flaggedLabels}.`,
      severity: lanes.organic.state === 'red' ? 'high' : 'medium',
      age_days: null,
      basis:    lanes.organic.basis,
    });
  }

  if (lanes.paid.state === 'red' || lanes.paid.state === 'amber') {
    if (lanes.paid.flags.length) {
      items.push({
        text:     `Paid issue (${lanes.paid.state})`,
        flags:    lanes.paid.flags,
        severity: lanes.paid.state === 'red' ? 'high' : 'medium',
        age_days: null,
        basis:    lanes.paid.basis,
      });
    } else {
      const fallback = lanes.paid.state === 'red' ? 'lead drought' : 'zero rows or attribution gap';
      items.push({
        text:     `Paid issue (${lanes.paid.state}): ${fallback}.`,
        severity: lanes.paid.state === 'red' ? 'high' : 'medium',
        age_days: null,
        basis:    lanes.paid.basis,
      });
    }
  }

  if (lanes.crm.state === 'red' || lanes.crm.state === 'amber') {
    const awaiting = lanes.crm.detail.awaiting_flow || 0;
    const oldest   = lanes.crm.detail.oldest_unanswered_hours || 0;
    items.push({
      text:     `${awaiting} thread${awaiting !== 1 ? 's' : ''} awaiting Flow, oldest ${Math.round(oldest)}h.`,
      severity: lanes.crm.state === 'red' ? 'high' : 'medium',
      age_days: oldest > 0 ? Math.round(oldest / 24) : null,
      basis:    lanes.crm.basis,
    });
  }

  // Additional call-out for oldest > 72h when CRM state didn't already capture it
  const oldest   = commsData?.oldest_unanswered_hours || 0;
  const awaiting = commsData?.counts?.awaiting_flow   || 0;
  if (oldest > 72 && awaiting > 0 && lanes.crm.state !== 'red' && lanes.crm.state !== 'amber') {
    items.push({
      text:     `Oldest awaiting-Flow thread is ${Math.round(oldest)}h old.`,
      severity: 'high',
      age_days: Math.round(oldest / 24),
      basis:    lanes.crm.basis,
    });
  }

  if (contract.days_left != null && contract.days_left <= 30) {
    items.push({
      text:     `Contract ends in ${contract.days_left} day${contract.days_left !== 1 ? 's' : ''} (${contract.end}).`,
      severity: 'high',
      age_days: null,
      basis:    contract.basis,
    });
  }

  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return (b.age_days ?? -1) - (a.age_days ?? -1);
  });

  return items;
}

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('=== Build cards ===');

  mkdirSync('cards', { recursive: true });

  const inbox     = readJSON('site/inbox.json');
  const quietSet  = new Set(readJSON('site/quiet_this_week.json') || []);
  const today = isoToday();
  let built   = 0;

  for (const client of CLIENTS) {
    if (INACTIVE.has(client.slug)) continue;

    const { slug, name } = client;
    // Steel sub-slugs share one plan file; every other client owns its own.
    const planSlug = STEEL_SUBS.has(slug) ? STEEL_PLAN_SLUG : slug;

    const pulse      = readJSON(`pulse/${slug}.json`);
    const factsData  = readJSON(`facts/${slug}.json`);
    const commsData  = readJSON(`comms/${slug}.json`);
    const plan       = readJSON(`timeline/${planSlug}.plan.json`);
    const timeline   = readJSON(`timeline/${planSlug}.json`);
    const inboxItems = inboxForName(inbox?.by_client, name);

    const sourcesRead = {
      pulse:    pulse    != null,
      facts:    factsData != null,
      comms:    commsData != null,
      plan:     plan     != null,
      timeline: timeline != null,
      inbox:    inboxItems.length > 0,
    };

    const isQuiet     = quietSet.has(slug);
    const organicLane = isQuiet ? buildDormantLane() : buildOrganicLane(client, pulse);
    const paidLane    = isQuiet ? buildDormantLane() : buildPaidLane(client, pulse, slug);

    // When organic and paid report different windows, label both headlines
    // so they are never read as comparable.
    if (!isQuiet && organicLane.basis.window !== paidLane.basis.window) {
      organicLane.headline += ` · ${organicLane.basis.window}`;
      paidLane.headline    += ` · ${paidLane.basis.window}`;
    }
    const crmLane     = buildCrmLane(client, factsData, commsData, pulse);
    const lanes       = { organic: organicLane, paid: paidLane, crm: crmLane };

    const contract  = buildContract(plan, today);
    const status    = buildStatus(lanes, contract.days_left);
    const scope_out = buildScopeOut(lanes);
    const needs_you = buildNeedsYou(lanes, contract, commsData);

    writeFileSync(`cards/${slug}.json`, JSON.stringify({
      slug,
      name,
      generated_at: new Date().toISOString(),
      contract,
      status,
      lanes,
      scope_out,
      needs_you,
      sources_read: sourcesRead,
    }, null, 2));

    console.log(`  ${slug}: ${status} — organic:${organicLane.state} paid:${paidLane.state} crm:${crmLane.state}`);
    built++;
  }

  console.log(`\nDone: ${built} cards built.`);
}

main();
