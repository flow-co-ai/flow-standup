// Performance tab — fetches daily pulse JSONs from flow-analyst and renders per-client cards.

const PULSE_BASE = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/pulse';

// Maps standup client display names → pulse slug (covers known aliases).
const PULSE_SLUG = {
  'Billy Doe Meats':      'billy-doe',
  'Cotton Collections':   'cotton-collections',
  'Flow Company':         'flow-company',
  'Full Smile':           'full-smile',
  'Healing Helps':        'healing-helps',
  'HVAC':                 'hvac',
  'Quality HVAC':         'hvac',
  'Quality HVAC by Fibid':'hvac',
  'Justice Consumer Law': 'jcl',
  'Liferun':              'liferun',
  'Maadi Law':            'maadi-law',
  'Maadi Law, LLC':       'maadi-law',
  'Steel Round Bars':     'steel-round-bars',
  'Vous Physique':        'vous-physique',
};

// Pulse-only clients that may not appear in the standup.
const PULSE_ONLY = [
  { client: 'Vous Physique',    slug: 'vous-physique' },
  { client: 'Maadi Law, LLC',   slug: 'maadi-law' },
  { client: 'Flow Company',     slug: 'flow-company' },
  { client: 'Cotton Collections', slug: 'cotton-collections' },
  { client: 'Healing Helps',    slug: 'healing-helps' },
  { client: 'Steel Round Bars', slug: 'steel-round-bars' },
];

// ── minimal DOM builder (same pattern as app.js) ──────────────────

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if      (k === 'class')                                   e.className = v;
    else if (k === 'text')                                    e.textContent = v;
    else if (k === 'html')                                    e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function')  e[k] = v;
    else if (k === 'style'     && typeof v === 'object')     Object.assign(e.style, v);
    else                                                      e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

// ── formatting helpers ────────────────────────────────────────────

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + n.toFixed(0);
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return String(Math.round(n));
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

function deltaEl(pct, invertColors) {
  if (pct == null) return null;
  const up   = pct >= 0;
  const sign = up ? '+' : '';
  // For spend: up = more spend = neutral-ish; for leads: up = good.
  // invertColors=true means up is bad (e.g. CPL going up).
  let cls;
  if (invertColors) cls = up ? 'down' : 'up';
  else              cls = up ? 'up'   : 'down';
  const arrow = up ? '▲' : '▼';
  return el('span', { class: `perf-delta ${cls}`, text: `${arrow} ${sign}${pct}%` });
}

// ── card builders ─────────────────────────────────────────────────

function buildStat(label, value, delta) {
  const stat = el('div', { class: 'perf-stat' });
  stat.append(el('span', { class: 'perf-stat-label', text: label }));
  const valueEl = el('span', { class: 'perf-stat-value', text: value });
  stat.append(valueEl);
  if (delta) stat.append(delta);
  return stat;
}

function buildWindsorBlock(windsor, deltas) {
  const t = windsor.totals;

  const block = el('div', { class: 'perf-block' });
  block.append(el('div', { class: 'perf-block-label', text: 'Windsor · Paid & Organic' }));

  const stats = el('div', { class: 'perf-stats' });

  const spendDelta = deltas?.spend_7d_pct != null
    ? deltaEl(deltas.spend_7d_pct, false) : null;
  stats.append(buildStat('Spend', fmtMoney(t?.spend), spendDelta));

  const leadsDelta = deltas?.leads_7d_pct != null
    ? deltaEl(deltas.leads_7d_pct, false) : null;
  stats.append(buildStat('Leads', fmtNum(t?.leads), leadsDelta));

  if (t?.cpl > 0) {
    stats.append(buildStat('Cost / lead', fmtMoney(t.cpl)));
  }

  const gbp = t?.byChannel?.gbp;
  if (gbp?.actions > 0) {
    stats.append(buildStat('GBP actions', fmtNum(gbp.actions)));
  }

  const ig = windsor.organic?.ig_reach;
  if (ig > 0) {
    stats.append(buildStat('IG reach', fmtNum(ig)));
  }

  block.append(stats);

  const tc = windsor.top_campaign;
  if (tc?.name) {
    block.append(
      el('div', { class: 'perf-campaign' },
        'Top campaign: ',
        el('span', { class: 'perf-campaign-name', text: tc.name }),
        ` · ${fmtMoney(tc.spend)}`
      )
    );
  }

  const flags = windsor.flags || [];
  if (flags.length) {
    const flagsEl = el('div', { class: 'perf-flags' });
    for (const f of flags) flagsEl.append(el('span', { class: 'perf-flag', text: f }));
    block.append(flagsEl);
  }

  return block;
}

function buildAnalyticsBlock(analytics) {
  const block = el('div', { class: 'perf-block' });
  block.append(el('div', { class: 'perf-block-label', text: 'GA4 · Last 28 days' }));
  const stats = el('div', { class: 'perf-stats' });
  stats.append(buildStat('Sessions',    fmtNum(analytics.sessions)));
  stats.append(buildStat('Users',       fmtNum(analytics.users)));
  if ((analytics.conversions || 0) > 0)
    stats.append(buildStat('Conversions', fmtNum(analytics.conversions)));
  block.append(stats);
  return block;
}

function buildSearchBlock(search) {
  const block = el('div', { class: 'perf-block' });
  block.append(el('div', { class: 'perf-block-label', text: 'Search Console · Last 28 days' }));
  const stats = el('div', { class: 'perf-stats' });
  stats.append(buildStat('Clicks',      fmtNum(search.clicks)));
  stats.append(buildStat('Impressions', fmtNum(search.impressions)));
  block.append(stats);
  return block;
}

function buildSocialBlock(social) {
  const block = el('div', { class: 'perf-block' });
  block.append(el('div', { class: 'perf-block-label', text: 'Instagram · Last 28 days' }));
  const stats = el('div', { class: 'perf-stats' });
  if ((social.followers || 0) > 0)
    stats.append(buildStat('Followers',   fmtNum(social.followers)));
  stats.append(buildStat('Reach',       fmtNum(social.reach)));
  stats.append(buildStat('Impressions', fmtNum(social.impressions)));
  if ((social.engagement || 0) > 0)
    stats.append(buildStat('Engagement', fmtNum(social.engagement)));
  block.append(stats);
  return block;
}

function buildGhlBlock(ghl) {
  const block = el('div', { class: 'perf-block' });
  block.append(el('div', { class: 'perf-block-label', text: 'GHL CRM · Last 28 days' }));

  const stats = el('div', { class: 'perf-stats' });

  stats.append(buildStat('New contacts',   fmtNum(ghl.contacts)));
  stats.append(buildStat('Opps created',   fmtNum(ghl.opportunities?.created?.count)));
  stats.append(buildStat('Opp value',      fmtMoney(ghl.opportunities?.created?.value)));
  stats.append(buildStat('Opps won',       fmtNum(ghl.opportunities?.won?.count)));
  if ((ghl.opportunities?.won?.value || 0) > 0) {
    stats.append(buildStat('Won value',    fmtMoney(ghl.opportunities.won.value)));
  }
  stats.append(buildStat('Appointments',   fmtNum(ghl.appointments)));

  block.append(stats);
  return block;
}

function buildPerfCard(clientName, pulse) {
  const card = el('article', { class: 'perf-card' });

  const dateLabel = pulse?.date ? fmtDate(pulse.date) : '';
  card.append(
    el('div', { class: 'perf-card-header' },
      el('span', { class: 'perf-client-name', text: clientName }),
      dateLabel ? el('span', { class: 'perf-date-stamp', text: dateLabel }) : null,
    )
  );

  if (!pulse) {
    card.classList.add('no-feed');
    card.append(el('p', { class: 'perf-no-feed-msg', text: 'No performance feed connected.' }));
    return card;
  }

  const windsor = pulse.windsor;
  const ghl     = pulse.ghl;
  const deltas  = windsor?.deltas;

  // Windsor — paid & organic block
  if (windsor && !windsor.error) {
    card.append(buildWindsorBlock(windsor, deltas));
  } else if (windsor?.error) {
    card.append(
      el('div', { class: 'perf-block' },
        el('div', { class: 'perf-block-label', text: 'Windsor' }),
        el('p', { class: 'perf-error-msg', text: `No data: ${windsor.error}` }),
      )
    );
  }

  // Analytics / Search Console / Instagram — only when data exists
  if (windsor?.analytics) card.append(buildAnalyticsBlock(windsor.analytics));
  if (windsor?.search)    card.append(buildSearchBlock(windsor.search));
  if (windsor?.social)    card.append(buildSocialBlock(windsor.social));

  // GHL block
  if (ghl && !ghl.error) {
    card.append(buildGhlBlock(ghl));
  } else if (ghl?.error) {
    card.append(
      el('div', { class: 'perf-block' },
        el('div', { class: 'perf-block-label', text: 'GHL CRM' }),
        el('p', { class: 'perf-error-msg', text: `Error: ${ghl.error}` }),
      )
    );
  }

  return card;
}

function buildErrorCard(clientName, errMsg) {
  const card = el('article', { class: 'perf-card' });
  card.append(
    el('div', { class: 'perf-card-header' },
      el('span', { class: 'perf-client-name', text: clientName }),
    )
  );
  card.append(el('p', { class: 'perf-error-msg', text: errMsg }));
  return card;
}

// ── data fetching ─────────────────────────────────────────────────

async function fetchPulse(slug) {
  const url = `${PULSE_BASE}/${slug}.json?t=${Date.now()}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function loadStandup() {
  try {
    const res = await fetch(`latest.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── render ────────────────────────────────────────────────────────

async function init() {
  const app = document.getElementById('perf-app');

  const standup = await loadStandup();
  const standupClients = (standup?.by_client || [])
    .filter(c => c.client !== 'Unmapped')
    .map(c => c.client);

  // Build the ordered list: standup clients first, then pulse-only extras.
  const seenSlugs  = new Set();
  const allClients = []; // { client: name, slug: slug|null }

  for (const name of standupClients) {
    const slug = PULSE_SLUG[name] || null;
    if (slug) seenSlugs.add(slug);
    allClients.push({ client: name, slug });
  }

  for (const { client, slug } of PULSE_ONLY) {
    if (!seenSlugs.has(slug) && !allClients.some(c => c.client === client)) {
      allClients.push({ client, slug });
    }
  }

  // Fetch all pulse JSONs in parallel.
  const pulseMap = {};
  await Promise.all(
    [...new Set(allClients.map(c => c.slug).filter(Boolean))].map(async slug => {
      try {
        pulseMap[slug] = await fetchPulse(slug);
      } catch (e) {
        pulseMap[slug] = { _fetchError: e.message };
      }
    })
  );

  // Render.
  app.innerHTML = '';
  app.className = 'perf-list';

  for (const { client, slug } of allClients) {
    if (!slug) {
      app.append(buildPerfCard(client, null));
      continue;
    }

    const pulse = pulseMap[slug];
    if (!pulse) {
      app.append(buildPerfCard(client, null)); // 404 — not connected yet
    } else if (pulse._fetchError) {
      app.append(buildErrorCard(client, `Fetch failed: ${pulse._fetchError}`));
    } else {
      app.append(buildPerfCard(client, pulse));
    }
  }

  const ts = document.getElementById('perf-footer-ts');
  if (ts) ts.textContent = 'Performance data updated daily at 11:00 UTC from Windsor (paid media) and GHL (CRM).';
}

document.addEventListener('DOMContentLoaded', init);
