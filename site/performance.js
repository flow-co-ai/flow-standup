// Performance tab — fetches daily pulse JSONs and renders the scan strip + client cards.

const PULSE_BASE = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/pulse';

// Maps standup client display names → pulse slug (covers known aliases).
// Inactive clients (active: false in clients.json) are omitted.
const PULSE_SLUG = {
  'Billy Doe Meats':       'billy-doe',
  'Full Smile':            'full-smile',
  'Healing Helps':         'healing-helps',
  'HVAC':                  'hvac',
  'Quality HVAC':          'hvac',
  'Quality HVAC by Fibid': 'hvac',
  'Justice Consumer Law':  'jcl',
  'Liferun':               'liferun',
  'Maadi Law':             'maadi-law',
  'Maadi Law, LLC':        'maadi-law',
  'Steel Round Bars':      'steel-ohare',   // legacy standup name; ohare is the umbrella slug
  'Forte Metals':          'steel-forte',
  'Advance Grinding':      'steel-advance',
  "O'Hare Precision":      'steel-ohare',
};

// Pulse-only clients that may not appear in the standup (inactive excluded).
const PULSE_ONLY = [
  { client: 'Maadi Law, LLC',   slug: 'maadi-law' },
  { client: 'Healing Helps',    slug: 'healing-helps' },
  { client: 'Forte Metals',     slug: 'steel-forte' },
  { client: 'Advance Grinding', slug: 'steel-advance' },
  { client: "O'Hare Precision", slug: 'steel-ohare' },
];

// ── DOM builder (same pattern as app.js) ──────────────────────────

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if      (k === 'class')                                   e.className = v;
    else if (k === 'text')                                    e.textContent = v;
    else if (k === 'html')                                    e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function')  e[k] = v;
    else if (k === 'style'      && typeof v === 'object')    Object.assign(e.style, v);
    else                                                      e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

// ── Color tokens ──────────────────────────────────────────────────

const C = {
  olive:  '#A9B478',
  amber:  '#d9a441',
  orange: '#d96c4a',
  muted:  '#6b7060',
  cream:  '#EDE9DA',
};

function statusColor(score) {
  if (score == null) return C.muted;
  if (score >= 80)   return C.olive;
  if (score >= 50)   return C.amber;
  return C.orange;
}

// Sparkline stroke color based on delta; inverted = positive delta is bad (e.g. CPL).
function deltaColor(pct, inverted = false) {
  if (pct == null) return C.muted;
  const bad = inverted ? pct : -pct;
  if (bad <= 10)  return C.olive;
  if (bad <= 30)  return C.amber;
  return C.orange;
}

// ── Formatting ────────────────────────────────────────────────────

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + (+n).toFixed(0);
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return String(Math.round(n));
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso + 'T12:00:00Z')
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      .toUpperCase();
  } catch { return iso.slice(0, 10); }
}

function fmtPct(pct) {
  if (pct == null) return '—';
  return (pct >= 0 ? '+' : '') + pct + '%';
}

// Extract a short human label from a GHL error string, never exposing raw JSON.
function extractGhlError(err) {
  if (!err) return 'error';
  if (err.includes('not_set')) return 'no token';
  const m = err.match(/\{[^}]{0,300}\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (p.message) return p.message.toLowerCase().replace(/['"]/g, '').slice(0, 32);
    } catch {}
  }
  const colon = err.indexOf(':');
  return ((colon >= 0 ? err.slice(colon + 1).trim() : err)).slice(0, 32);
}

// ── Sparkline ─────────────────────────────────────────────────────
// Returns an inline SVG string. Renders a flat gray midline for empty/missing series
// so old pulse JSONs (without the series block) never break the page.

function sparkline(values, color, w = 80, h = 22) {
  const nums = (values || [])
    .filter(v => v != null && isFinite(+v))
    .map(Number);

  if (nums.length < 2) {
    const mid = (h / 2).toFixed(1);
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="${mid}" x2="${w}" y2="${mid}" stroke="${C.muted}" stroke-width="1.5" opacity="0.35"/></svg>`;
  }

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const pad = 2;

  const pts = nums.map((v, i) => {
    const x = (i / (nums.length - 1)) * w;
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ── Derived series ────────────────────────────────────────────────

function roasSeries(series) {
  return (series.revenue || []).map((rev, i) => {
    const s = (series.spend || [])[i];
    return (s > 0) ? rev / s : null;
  });
}

function cplSeries(series) {
  return (series.spend || []).map((s, i) => {
    const l = (series.leads || [])[i];
    return (l > 0) ? s / l : null;
  });
}

// ── Domain helpers ────────────────────────────────────────────────

// Returns { key, label } for the biggest absolute delta for the scan chip.
function biggestScanDelta(deltas, type) {
  const candidates = (type === 'ecom')
    ? [{ key: 'roas_7d_pct', label: 'roas' }, { key: 'purchases_7d_pct', label: 'purchases' }]
    : [{ key: 'leads_7d_pct', label: 'leads' }, { key: 'cpl_7d_pct', label: 'cpl' }];
  return candidates
    .filter(c => (deltas || {})[c.key] != null)
    .sort((a, b) => Math.abs(deltas[b.key]) - Math.abs(deltas[a.key]))[0] ?? null;
}

// Client-side verdict fallback for old pulse JSONs without server-generated verdict.
function buildVerdictFallback(name, deltas, flags) {
  const CANDS = [
    { key: 'leads_7d_pct',     label: 'leads' },
    { key: 'purchases_7d_pct', label: 'purchases' },
    { key: 'roas_7d_pct',      label: 'ROAS' },
    { key: 'cpl_7d_pct',       label: 'cost per lead' },
    { key: 'spend_7d_pct',     label: 'spend' },
    { key: 'sc_7d_pct',        label: 'search clicks' },
    { key: 'ga4_7d_pct',       label: 'website sessions' },
    { key: 'gbp_7d_pct',       label: 'Google Business actions' },
    { key: 'ig_7d_pct',        label: 'Instagram reach' },
  ].filter(c => (deltas || {})[c.key] != null)
   .sort((a, b) => Math.abs(deltas[b.key]) - Math.abs(deltas[a.key]));

  if (!CANDS.length) return null;
  const top = CANDS[0];
  const val = deltas[top.key];
  const dir = val > 0 ? 'up' : 'down';
  let text = `${name} ${top.label} is ${dir} ${Math.abs(val)}% vs the prior 7 days.`;
  if ((flags || []).includes('lead_drought')) text += ' Lead drought flag is active.';
  return text;
}

// Human-readable flag labels.
function flagLabel(f) {
  const MAP = {
    'zero_spend_day':      'zero spend today',
    'lead_drought':        'lead drought',
    'channel_dark:meta':   'Meta went dark',
    'channel_dark:google': 'Google went dark',
  };
  return MAP[f] ?? f.replace(/_/g, ' ');
}

// ── Status dot ────────────────────────────────────────────────────

function statusDot(score, size = 7) {
  return el('span', {
    class: 'perf-dot',
    style: { width: size + 'px', height: size + 'px', background: statusColor(score) },
  });
}

// ── Scan strip ────────────────────────────────────────────────────

function buildScanStrip(entries) {
  const strip = el('div', { class: 'perf-scan-strip' });

  for (const { name, cardId, hasFeed, pulse } of entries) {
    const score   = hasFeed ? pulse?.score : null;
    const deltas  = pulse?.windsor?.deltas;
    const type    = pulse?.type || 'leadgen';
    const bd      = hasFeed ? biggestScanDelta(deltas, type) : null;

    const chip = el('div', {
      class: 'perf-scan-chip' + (hasFeed ? '' : ' no-feed'),
      ...(hasFeed ? {
        onclick() {
          const slug = pulse?.slug || cardId;
          const c = document.getElementById(`perf-card-${slug}`);
          if (!c) return;
          c.classList.remove('collapsed');
          c.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      } : {}),
    });

    chip.append(statusDot(score, 6));
    chip.append(el('span', { class: 'perf-scan-name', text: name }));

    if (hasFeed && score != null) {
      chip.append(el('span', {
        class: 'perf-scan-score',
        style: { color: statusColor(score) },
        text: String(score),
      }));
      if (bd) {
        const val = deltas[bd.key];
        chip.append(el('span', {
          class: 'perf-scan-delta',
          text: `${bd.label} ${fmtPct(val)}`,
        }));
      }
    } else {
      chip.append(el('span', { class: 'perf-scan-nofeed', text: 'no feed' }));
    }

    strip.append(chip);
  }

  return strip;
}

// ── Hero tile ─────────────────────────────────────────────────────

function buildHeroTile(label, value, ser, delta, { inverted = false, onPaceWhen = false } = {}) {
  const color  = deltaColor(delta, inverted);
  const onPace = onPaceWhen && delta != null && Math.abs(delta) <= 10;

  const tile = el('div', { class: 'perf-hero-tile' });
  tile.append(el('span', { class: 'perf-hero-label', text: label }));
  tile.append(el('span', { class: 'perf-hero-value', text: value }));

  if (delta != null) {
    const pctStr = fmtPct(delta);
    tile.append(el('span', {
      class: 'perf-hero-delta',
      style: { color: onPace ? C.muted : color },
      text:  onPace ? pctStr + ' on pace' : pctStr,
    }));
  }

  const sparkEl = el('div', { class: 'perf-hero-spark' });
  sparkEl.innerHTML = sparkline(ser, color, 108, 28);
  tile.append(sparkEl);

  return tile;
}

// ── Channel row ───────────────────────────────────────────────────

function buildChannelRow(label, ser, metric, delta, inverted = false) {
  const color = deltaColor(delta, inverted);
  const row   = el('div', { class: 'perf-channel-row' });

  row.append(el('span', { class: 'perf-ch-label', text: label }));

  const sparkEl = el('span', { class: 'perf-ch-spark' });
  sparkEl.innerHTML = sparkline(ser, color, 80, 20);
  row.append(sparkEl);

  row.append(el('span', { class: 'perf-ch-metric', text: metric }));
  row.append(el('span', {
    class: 'perf-ch-delta' + (delta == null ? ' perf-ch-delta--null' : ''),
    style: delta != null ? { color } : {},
    text:  fmtPct(delta),
  }));

  return row;
}

// ── GHL row ───────────────────────────────────────────────────────

function buildGhlRow(ghl) {
  if (!ghl) return null;

  if (ghl.error) {
    return el('div', { class: 'perf-ghl-row' },
      el('span', { class: 'perf-ghl-error-chip' }, 'GHL · ' + extractGhlError(ghl.error))
    );
  }

  const contacts = fmtNum(ghl.contacts);
  const opps     = fmtNum(ghl.opportunities?.created?.count);
  const appts    = fmtNum(ghl.appointments);

  return el('div', { class: 'perf-ghl-row' },
    el('span', { class: 'perf-ch-label', text: 'GHL' }),
    el('span', { class: 'perf-ghl-text' }, `${contacts} contacts · ${opps} opps · ${appts} appts`)
  );
}

// ── Buyer layer: passcode + decisions + suggestion pills ──────────
const KEY_PASSCODE = 'flowops-passcode'; // same key app.js uses

function getPasscode() {
  let p = localStorage.getItem(KEY_PASSCODE);
  if (!p) {
    p = prompt('Ops passcode');
    if (p) localStorage.setItem(KEY_PASSCODE, p);
  }
  return p;
}

async function postSuggestion(body) {
  const pass = getPasscode();
  if (!pass) return { error: 'no passcode' };
  const res = await fetch('/.netlify/functions/suggestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-key': pass },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    localStorage.removeItem(KEY_PASSCODE);
    return { error: 'wrong passcode — click again to retry' };
  }
  try { return await res.json(); } catch { return { error: `HTTP ${res.status}` }; }
}

async function fetchDecidedIds() {
  // Only when a passcode is already stored — never prompt on page load.
  const pass = localStorage.getItem(KEY_PASSCODE);
  if (!pass) return new Set();
  try {
    const res = await fetch('/.netlify/functions/suggestions', { headers: { 'x-ops-key': pass } });
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set((data.items || []).map(d => `${d.slug}:${d.suggestionId}`));
  } catch { return new Set(); }
}

function buildSuggestionPill(s, slug, clientName) {
  const pill = el('div', { class: `perf-suggestion perf-sug-${s.type}` });
  pill.append(el('div', { class: 'perf-sug-head' },
    el('span', { class: 'perf-sug-type', text: s.type.replace('_', ' ') }),
    el('span', { class: 'perf-sug-text', text: s.text }),
  ));
  if (s.monday_update) pill.append(el('div', { class: 'perf-sug-update', text: s.monday_update }));

  const status     = el('span', { class: 'perf-sug-status' });
  const approveBtn = el('button', { class: 'perf-btn perf-btn-approve', text: 'Approve → Monday',
    onclick: async () => {
      approveBtn.disabled = true; dismissBtn.disabled = true;
      status.textContent = 'Sending…';
      const r = await postSuggestion({ action: 'approve', slug, clientName, suggestion: s });
      if (r.ok) { status.textContent = `Sent · item ${r.mondayItemId}`; pill.classList.add('decided'); }
      else { status.textContent = r.error || 'Failed'; approveBtn.disabled = false; dismissBtn.disabled = false; }
    } });
  const dismissBtn = el('button', { class: 'perf-btn perf-btn-dismiss', text: 'Dismiss',
    onclick: async () => {
      const reason = prompt('Why dismiss? (the lens learns from this)');
      if (!reason || !reason.trim()) return;
      approveBtn.disabled = true; dismissBtn.disabled = true;
      status.textContent = 'Saving…';
      const r = await postSuggestion({ action: 'dismiss', slug, clientName, suggestion: s, reason });
      if (r.ok) { status.textContent = 'Dismissed'; pill.classList.add('decided'); }
      else { status.textContent = r.error || 'Failed'; approveBtn.disabled = false; dismissBtn.disabled = false; }
    } });

  const actions = el('div', { class: 'perf-sug-actions' });
  actions.append(approveBtn, dismissBtn, status);
  pill.append(actions);
  return pill;
}

function buildLensBlock(perf, slug, clientName, decidedIds) {
  const block = el('div', { class: 'perf-lens' });
  const when  = perf.generated_at ? fmtDate(perf.generated_at.slice(0, 10)) : '';
  block.append(el('div', { class: 'perf-lens-label',
    text: `Analyst + Buyer · ${when}${perf.stale ? ' · carried' : ''}` }));

  if (perf.verdict) block.append(el('p', { class: 'perf-lens-verdict', text: perf.verdict }));

  const findings = perf.findings || [];
  if (findings.length) {
    const list = el('div', { class: 'perf-findings' });
    for (const f of findings) {
      list.append(el('div', { class: 'perf-finding' },
        el('span', { class: `perf-conf perf-conf-${f.confidence}`, text: f.confidence }),
        el('span', { text: f.text }),
      ));
    }
    block.append(list);
  }

  const open = (perf.suggestions || []).filter(s => !decidedIds.has(`${slug}:${s.id}`));
  for (const s of open) block.append(buildSuggestionPill(s, slug, clientName));

  if (perf.next_check) {
    block.append(el('p', { class: 'perf-lens-meta', text: `Next check: ${fmtDate(perf.next_check)}` }));
  }
  return block;
}

// ── Main card ─────────────────────────────────────────────────────

function buildCard(entry, decidedIds = new Set()) {
  const { name, cardId, hasFeed, pulse } = entry;
  const slug = pulse?.slug || cardId;
  const card = el('article', {
    class: 'perf-card' + (hasFeed ? '' : ' perf-card--nofeed'),
    id: `perf-card-${slug}`,
  });

  if (!hasFeed) {
    card.append(
      el('div', { class: 'perf-card-header' },
        el('div', { class: 'perf-card-header-left' },
          statusDot(null, 8),
          el('span', { class: 'perf-client-name', text: name })
        ),
        el('div', { class: 'perf-card-header-right' },
          el('span', { class: 'perf-stamp', text: 'NO FEED' })
        )
      )
    );
    return card;
  }

  const score   = pulse.score;
  const type    = pulse.type || 'leadgen';
  const windsor = pulse.windsor || {};
  const ghl     = pulse.ghl;
  const deltas  = windsor.deltas || {};
  const series  = windsor.series || {};
  const totals  = windsor.totals || {};
  const flags   = windsor.flags  || [];

  // ── Header (always visible, toggles collapse) ──
  const dateStr = fmtDate(pulse.date);
  const stamp   = (dateStr ? dateStr + ' · ' : '') + '7D VS PRIOR 7D';

  const chevron = el('span', { class: 'perf-chevron', text: '▾' });

  const header = el('div', {
    class: 'perf-card-header',
    style: { cursor: 'pointer' },
    onclick() { card.classList.toggle('collapsed'); },
  },
    el('div', { class: 'perf-card-header-left' },
      statusDot(score, 8),
      el('span', { class: 'perf-client-name', text: name })
    ),
    el('div', { class: 'perf-card-header-right' },
      score != null
        ? el('span', { class: 'perf-score', style: { color: statusColor(score) }, text: `${score}/100` })
        : null,
      el('span', { class: 'perf-stamp', text: stamp }),
      chevron
    )
  );
  card.append(header);

  // ── Body (collapses) ──
  const body = el('div', { class: 'perf-card-body' });

  // ── Verdict ──
  const verdictText = pulse.verdict || buildVerdictFallback(name, deltas, flags);
  if (verdictText) body.append(el('p', { class: 'perf-verdict', text: verdictText }));

  // ── Hero grid + channel rows (only when Windsor data is present) ──
  if (!windsor.error) {
    const heroGrid = el('div', { class: 'perf-hero-grid' });

    if (type === 'ecom') {
      const roas = totals.roas ?? null;
      heroGrid.append(buildHeroTile(
        'ROAS',
        roas != null ? roas + 'x' : '—',
        roasSeries(series),
        deltas.roas_7d_pct
      ));
      heroGrid.append(buildHeroTile(
        'PURCHASES',
        fmtNum(totals.byChannel?.meta?.purchases),
        series.purchases,
        deltas.purchases_7d_pct
      ));
      heroGrid.append(buildHeroTile(
        'SPEND',
        fmtMoney(totals.spend),
        series.spend,
        deltas.spend_7d_pct,
        { onPaceWhen: true }
      ));
    } else {
      heroGrid.append(buildHeroTile(
        'LEADS',
        fmtNum(totals.leads),
        series.leads,
        deltas.leads_7d_pct
      ));
      heroGrid.append(buildHeroTile(
        'CPL',
        fmtMoney(totals.cpl),
        cplSeries(series),
        deltas.cpl_7d_pct,
        { inverted: true }
      ));
      heroGrid.append(buildHeroTile(
        'SPEND',
        fmtMoney(totals.spend),
        series.spend,
        deltas.spend_7d_pct,
        { onPaceWhen: true }
      ));
    }
    body.append(heroGrid);

    // ── Channel rows ──
    const chWrap = el('div', { class: 'perf-channels' });
    let anyChannel = false;

    const meta = totals.byChannel?.meta;
    if (meta && (meta.leads > 0 || meta.spend > 0)) {
      chWrap.append(buildChannelRow('META', series.leads, fmtNum(meta.leads), deltas.meta_leads_7d_pct));
      anyChannel = true;
    }

    const gads = totals.byChannel?.google_ads;
    if (gads?.spend > 0) {
      chWrap.append(buildChannelRow('GOOGLE', series.google_spend, fmtMoney(gads.spend), deltas.google_spend_7d_pct));
      anyChannel = true;
    }

    if (windsor.search) {
      chWrap.append(buildChannelRow('SEARCH', series.sc_clicks, fmtNum(windsor.search.clicks), deltas.sc_7d_pct));
      anyChannel = true;
    }

    const gbpActions = totals.byChannel?.gbp?.actions ?? windsor.organic?.gbp_actions ?? 0;
    if (gbpActions > 0) {
      chWrap.append(buildChannelRow('GBP', series.gbp_actions, fmtNum(gbpActions), deltas.gbp_7d_pct));
      anyChannel = true;
    }

    if (windsor.analytics) {
      chWrap.append(buildChannelRow('GA4', series.ga4_sessions, fmtNum(windsor.analytics.sessions), deltas.ga4_7d_pct));
      anyChannel = true;
    }

    const igReach = windsor.organic?.ig_reach ?? 0;
    if (igReach > 0) {
      chWrap.append(buildChannelRow('IG', series.ig_reach, fmtNum(igReach), deltas.ig_7d_pct));
      anyChannel = true;
    }

    if (anyChannel) body.append(chWrap);
  }

  // ── GHL ──
  const ghlRow = buildGhlRow(ghl);
  if (ghlRow) body.append(ghlRow);

  // ── Flags ──
  if (flags.length) {
    const flagsEl = el('div', { class: 'perf-flags-row' });
    for (const f of flags) flagsEl.append(el('span', { class: 'perf-flag-chip', text: flagLabel(f) }));
    body.append(flagsEl);
  }

  // ── Analyst + Buyer (performance lens) ──
  if (pulse.performance) {
    body.append(buildLensBlock(pulse.performance, pulse.slug, name, decidedIds));
  }

  card.append(body);
  return card;
}

// ── Data fetching ─────────────────────────────────────────────────

async function fetchPulse(slug) {
  const res = await fetch(`${PULSE_BASE}/${slug}.json?t=${Date.now()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadStandup() {
  try {
    const res = await fetch(`latest.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Init ──────────────────────────────────────────────────────────

async function init() {
  const app = document.getElementById('perf-app');

  const standup = await loadStandup();
  const standupClients = (standup?.by_client || [])
    .filter(c => c.client !== 'Unmapped')
    .map(c => c.client);

  // Build ordered client list: standup clients first, then pulse-only extras.
  const seenSlugs  = new Set();
  const allClients = [];

  for (const name of standupClients) {
    const slug = PULSE_SLUG[name] || null;
    if (slug) seenSlugs.add(slug);
    allClients.push({ name, slug });
  }
  for (const { client, slug } of PULSE_ONLY) {
    if (!seenSlugs.has(slug) && !allClients.some(c => c.name === client)) {
      allClients.push({ name: client, slug });
    }
  }

  // Fetch all pulse JSONs + past decisions in parallel.
  const pulseMap = {};
  const [, decidedIds] = await Promise.all([
    Promise.all(
      [...new Set(allClients.map(c => c.slug).filter(Boolean))].map(async slug => {
        try { pulseMap[slug] = await fetchPulse(slug); }
        catch (e) { pulseMap[slug] = { _fetchError: e.message }; }
      })
    ),
    fetchDecidedIds(),
  ]);

  // Build entry objects.
  const entries = allClients.map(({ name, slug }) => {
    const pulse   = slug ? (pulseMap[slug] ?? null) : null;
    const hasFeed = !!(pulse && !pulse._fetchError);
    const cardId  = slug || name.replace(/\s+/g, '-').toLowerCase();
    return { name, slug, pulse, hasFeed, cardId };
  });

  app.innerHTML = '';

  // Scan strip — original order (matches standup + PULSE_ONLY order).
  app.append(buildScanStrip(entries));

  // Cards — lowest score first, no-feed last.
  const withFeed = entries
    .filter(e => e.hasFeed)
    .sort((a, b) => (a.pulse.score ?? 100) - (b.pulse.score ?? 100));
  const noFeed = entries.filter(e => !e.hasFeed);

  const cardList = el('div', { class: 'perf-list' });

  // Build all cards collapsed by default.
  for (const e of [...withFeed, ...noFeed]) {
    const card = buildCard(e, decidedIds);
    card.classList.add('collapsed');
    cardList.append(card);
  }

  // Worst-score card (first in withFeed) starts expanded.
  if (withFeed.length) {
    const worstSlug = withFeed[0].pulse?.slug || withFeed[0].cardId;
    cardList.querySelector(`#perf-card-${worstSlug}`)?.classList.remove('collapsed');
  }

  // Cards with open (undecided) suggestions start expanded.
  for (const e of withFeed) {
    const perf = e.pulse?.performance;
    if (!perf) continue;
    const hasOpen = (perf.suggestions || []).some(s => !decidedIds.has(`${e.slug}:${s.id}`));
    if (hasOpen) {
      const slug = e.pulse?.slug || e.cardId;
      cardList.querySelector(`#perf-card-${slug}`)?.classList.remove('collapsed');
    }
  }

  app.append(cardList);

  const ts = document.getElementById('perf-footer-ts');
  if (ts) ts.textContent = 'Performance data updated daily at 11:00 UTC from Windsor (paid media) and GHL (CRM).';
}

document.addEventListener('DOMContentLoaded', init);
