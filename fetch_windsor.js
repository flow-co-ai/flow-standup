// Windsor.ai connector HTTP API — aggregate-only metrics, never returns PII.
// Field IDs verified from https://connectors.windsor.ai/{connector}/fields
//
// Key field notes:
//   facebook:          date=date_start, campaign=campaign_name, spend=spend, leads=actions_lead
//   google_ads:        date=segments.date, campaign=campaign.name, spend=cost_micros (÷1e6)
//   googleanalytics4:  date=date, users=active_users
//   instagram:         date=date, followers=follower_count_1d, reach=reach_1d, eng=media_engagement
//   searchconsole:     date=date
//   google_my_business:date=date, calls=call_clicks

const WINDSOR_BASE = 'https://connectors.windsor.ai';

// Normalise a connector value from clients.json.
// Array shorthand → sum all accounts. Object with pick:true → keep largest only.
function norm(cfg) {
  if (Array.isArray(cfg)) return { accounts: cfg, pick: false };
  return { accounts: cfg.accounts, pick: !!cfg.pick };
}

function round2(n) { return Math.round(n * 100) / 100; }

function toNum(val) {
  const n = typeof val === 'number' ? val : parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function dateStr(d) { return d.toISOString().slice(0, 10); }

// 28-day window ending yesterday (inclusive both ends).
function windowDates() {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() - 1);
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 27);
  return { dateFrom: dateStr(from), dateTo: dateStr(to) };
}

// Fetch one connector. Returns the `data` array (may be empty).
async function callConnector(connector, fields, accounts, dateFrom, dateTo, apiKey) {
  const params = new URLSearchParams({
    api_key:         apiKey,
    fields:          fields.join(','),
    date_from:       dateFrom,
    date_to:         dateTo,
    select_accounts: accounts.join(','),
    _max_rows:       '50000',
  });

  const url = `${WINDSOR_BASE}/${connector}?${params}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Windsor ${connector} HTTP ${res.status}${body ? ': ' + body.slice(0, 150) : ''}`);
  }

  const json = await res.json();
  return Array.isArray(json.data) ? json.data : [];
}

// When pick=true, keep only the account with the highest total of primaryField.
function pickLargest(rows, primaryField) {
  if (!rows.length) return rows;
  const totals = {};
  for (const r of rows) {
    const id = r.account_id ?? '';
    totals[id] = (totals[id] ?? 0) + toNum(r[primaryField]);
  }
  const best = Object.entries(totals).sort((a, b) => b[1] - a[1])[0]?.[0];
  return rows.filter(r => (r.account_id ?? '') === best);
}

// Fetch one connector safely: returns empty array on failure, logs the error.
async function safeFetch(connector, fields, cfg, dateFrom, dateTo, apiKey, pickField) {
  if (!cfg) return [];
  const { accounts, pick } = norm(cfg);
  if (!accounts?.length) return [];

  try {
    let rows = await callConnector(connector, fields, accounts, dateFrom, dateTo, apiKey);
    if (pick && pickField && rows.length) rows = pickLargest(rows, pickField);
    console.log(`    ${connector}: ${rows.length} rows`);
    return rows;
  } catch (err) {
    console.error(`    ${connector} error: ${err.message}`);
    return [];
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function fetchWindsor(windsorCfg, apiKey) {
  const { dateFrom, dateTo } = windowDates();

  // Fetch all six connectors in parallel.
  const [metaRows, gadsRows, ga4Rows, igRows, scRows, gmbRows] = await Promise.all([
    safeFetch('facebook', [
      'date_start', 'account_id', 'campaign_name',
      'spend', 'clicks', 'impressions', 'reach', 'actions_lead',
      'actions_click_to_call_call_confirm',
      'actions_click_to_call_native_call_placed',
      'actions_click_to_call_native_20s_call_connect',
      'actions_click_to_call_native_60s_call_connect',
      ...(windsorCfg.facebook_extra_fields || []),
    ], windsorCfg.facebook, dateFrom, dateTo, apiKey, null),

    safeFetch('google_ads', [
      'segments.date', 'account_id', 'campaign.name',
      'cost_micros', 'clicks', 'impressions', 'conversions',
    ], windsorCfg.google_ads, dateFrom, dateTo, apiKey, null),

    safeFetch('googleanalytics4', [
      'date', 'account_id', 'sessions', 'active_users', 'conversions',
    ], windsorCfg.googleanalytics4, dateFrom, dateTo, apiKey, 'sessions'),

    safeFetch('instagram', [
      'date', 'account_id',
      'follower_count_1d', 'reach_1d', 'impressions_1d', 'media_engagement',
    ], windsorCfg.instagram, dateFrom, dateTo, apiKey, null),

    safeFetch('searchconsole', [
      'date', 'account_id', 'clicks', 'impressions',
    ], windsorCfg.searchconsole, dateFrom, dateTo, apiKey, 'clicks'),

    safeFetch('google_my_business', [
      'date', 'account_id',
      'impressions', 'call_clicks', 'direction_requests', 'website_clicks',
    ], windsorCfg.google_my_business, dateFrom, dateTo, apiKey, null),
  ]);

  // ── 28-day paid totals ──────────────────────────────────────────────────────

  // Per-client override: some clients track calls instead of form leads.
  const metaLeadsField = windsorCfg.meta_leads_field || 'actions_lead';

  const metaSpend     = metaRows.reduce((s, r) => s + toNum(r.spend), 0);
  const metaLeads     = metaRows.reduce((s, r) => s + toNum(r[metaLeadsField]), 0);
  const metaClicks    = metaRows.reduce((s, r) => s + toNum(r.clicks), 0);
  const metaPurchases = metaRows.reduce((s, r) => s + toNum(r.actions_purchase), 0);
  const metaRevenue   = metaRows.reduce((s, r) => s + toNum(r.action_values_purchase), 0);

  // cost_micros = spend in millionths of the currency unit
  const gadsSpend       = gadsRows.reduce((s, r) => s + toNum(r.cost_micros) / 1_000_000, 0);
  const gadsConversions = gadsRows.reduce((s, r) => s + toNum(r.conversions), 0);
  const gadsClicks      = gadsRows.reduce((s, r) => s + toNum(r.clicks), 0);

  const totalSpend = round2(metaSpend + gadsSpend);
  const totalLeads = Math.round(metaLeads); // leads from Meta conversion actions only
  const cpl        = totalLeads > 0 ? round2(totalSpend / totalLeads) : 0;
  const roas       = metaRevenue > 0 && totalSpend > 0 ? round2(metaRevenue / totalSpend) : null;

  // Top campaign by spend (Meta + Google Ads blended)
  const byCampaign = {};
  for (const r of metaRows) {
    const n = (r.campaign_name || '').trim();
    if (n) byCampaign[n] = (byCampaign[n] ?? 0) + toNum(r.spend);
  }
  for (const r of gadsRows) {
    const n = (r['campaign.name'] || '').trim();
    if (n) byCampaign[n] = (byCampaign[n] ?? 0) + toNum(r.cost_micros) / 1_000_000;
  }
  let topCampaign = { name: '', spend: 0 };
  for (const [n, sp] of Object.entries(byCampaign)) {
    if (sp > topCampaign.spend) topCampaign = { name: n, spend: round2(sp) };
  }

  // ── GMB totals ─────────────────────────────────────────────────────────────

  const gbpCalls      = gmbRows.reduce((s, r) => s + toNum(r.call_clicks), 0);
  const gbpDirections = gmbRows.reduce((s, r) => s + toNum(r.direction_requests), 0);
  const gbpWebClicks  = gmbRows.reduce((s, r) => s + toNum(r.website_clicks), 0);
  const gbpActions    = gbpCalls + gbpDirections + gbpWebClicks;

  // ── Instagram totals ────────────────────────────────────────────────────────

  const igReach       = igRows.reduce((s, r) => s + toNum(r.reach_1d), 0);
  const igImpressions = igRows.reduce((s, r) => s + toNum(r.impressions_1d), 0);
  const igEngagement  = igRows.reduce((s, r) => s + toNum(r.media_engagement), 0);

  // Latest follower count — most recent date's value (it's a daily snapshot, not additive).
  const lastIgDate = igRows.reduce((max, r) => (r.date > max ? r.date : max), '');
  const igFollowers = igRows
    .filter(r => r.date === lastIgDate)
    .reduce((s, r) => s + toNum(r.follower_count_1d), 0);

  // ── GA4 totals ─────────────────────────────────────────────────────────────

  const ga4Sessions    = ga4Rows.reduce((s, r) => s + toNum(r.sessions), 0);
  const ga4Users       = ga4Rows.reduce((s, r) => s + toNum(r.active_users), 0);
  const ga4Conversions = ga4Rows.reduce((s, r) => s + toNum(r.conversions), 0);

  // ── Search Console totals ──────────────────────────────────────────────────

  const scClicks      = scRows.reduce((s, r) => s + toNum(r.clicks), 0);
  const scImpressions = scRows.reduce((s, r) => s + toNum(r.impressions), 0);

  // ── Per-day rows for history ───────────────────────────────────────────────
  // One row per date with spend/lead/channel split for the delta/flag engine.
  const daily = {};

  const ensureDay = d => {
    if (!d) return null;
    if (!daily[d]) daily[d] = { date: d, spend: 0, leads: 0, meta_spend: 0, google_spend: 0, gbp_actions: 0, ig_reach: 0 };
    return daily[d];
  };

  for (const r of metaRows) {
    const row = ensureDay(r.date_start);
    if (!row) continue;
    row.spend      += toNum(r.spend);
    row.meta_spend += toNum(r.spend);
    row.leads      += toNum(r[metaLeadsField]);
  }
  for (const r of gadsRows) {
    const row = ensureDay(r['segments.date']);
    if (!row) continue;
    const s = toNum(r.cost_micros) / 1_000_000;
    row.spend        += s;
    row.google_spend += s;
  }
  for (const r of gmbRows) {
    const row = ensureDay(r.date);
    if (!row) continue;
    row.gbp_actions += toNum(r.call_clicks) + toNum(r.direction_requests) + toNum(r.website_clicks);
  }
  for (const r of igRows) {
    const row = ensureDay(r.date);
    if (!row) continue;
    row.ig_reach += toNum(r.reach_1d);
  }
  // SC and GA4 have dates but contribute no spend/leads/gbp/ig fields — include
  // their dates so the daily map is populated even for organic-only clients.
  for (const r of scRows)  ensureDay(r.date);
  for (const r of ga4Rows) ensureDay(r.date);

  const dailyRows = Object.values(daily).map(r => ({
    date:         r.date,
    spend:        round2(r.spend),
    leads:        Math.round(r.leads),
    meta_spend:   round2(r.meta_spend),
    google_spend: round2(r.google_spend),
    gbp_actions:  Math.round(r.gbp_actions),
    ig_reach:     Math.round(r.ig_reach),
  })).sort((a, b) => a.date.localeCompare(b.date));

  // Most recent date with any data.
  const latestDay = dailyRows.at(-1) ?? null;

  // ── Sources list ───────────────────────────────────────────────────────────

  const sources = [];
  if (metaRows.length)  sources.push('facebook');
  if (gadsRows.length)  sources.push('google_ads');
  if (ga4Rows.length)   sources.push('googleanalytics4');
  if (igRows.length)    sources.push('instagram');
  if (scRows.length)    sources.push('searchconsole');
  if (gmbRows.length)   sources.push('google_my_business');

  // ── Build structured result ────────────────────────────────────────────────

  const result = {
    totals: {
      spend: totalSpend,
      leads: totalLeads,
      cpl,
      ...(roas !== null ? { roas } : {}),
      byChannel: {
        meta: {
          spend:     round2(metaSpend),
          leads:     Math.round(metaLeads),
          clicks:    Math.round(metaClicks),
          ...(metaPurchases > 0 ? { purchases: Math.round(metaPurchases), revenue: round2(metaRevenue) } : {}),
        },
        google_ads: {
          spend:       round2(gadsSpend),
          conversions: Math.round(gadsConversions),
          clicks:      Math.round(gadsClicks),
        },
        gbp: {
          actions:    Math.round(gbpActions),
          calls:      Math.round(gbpCalls),
          directions: Math.round(gbpDirections),
          web_clicks: Math.round(gbpWebClicks),
        },
      },
    },
    organic: {
      gbp_actions: Math.round(gbpActions), // kept for performance.js backwards compat
      ig_reach:    Math.round(igReach),
    },
    top_campaign: topCampaign.name ? topCampaign : null,
    // Internal: consumed by pulse.js, stripped before writing
    _dailyRows: dailyRows,
    _latestDay: latestDay,
    _sources:   sources,
  };

  // Optional blocks — omit entirely when no data exists for that connector.
  if (ga4Rows.length) {
    result.analytics = {
      sessions:    Math.round(ga4Sessions),
      users:       Math.round(ga4Users),
      conversions: Math.round(ga4Conversions),
    };
  }

  if (scRows.length) {
    result.search = {
      clicks:      Math.round(scClicks),
      impressions: Math.round(scImpressions),
    };
  }

  if (igRows.length) {
    result.social = {
      followers:   Math.round(igFollowers),
      reach:       Math.round(igReach),
      impressions: Math.round(igImpressions),
      engagement:  Math.round(igEngagement),
    };
  }

  return result;
}
