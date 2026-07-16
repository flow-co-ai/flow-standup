/* app.js — Flow Ops dashboard
 *
 * Persistence model:
 *   READ  — public GitHub raw URL, no auth needed
 *   WRITE — /.netlify/functions/save-checks, requires X-Ops-Key passcode
 *   LOCAL — localStorage mirror used when the network read fails (offline)
 *
 * Checks are stored as { rowId: true } (only checked rows kept).
 * Each week gets its own file: checks/{week_of}.json on the "state" branch.
 */

// ── constants ─────────────────────────────────────────────────────────────────

const HEALTH = {
  on_track: {
    label: 'On track',
    accent: '#8CBE6E',
    chipBorder: 'rgba(140,190,110,0.35)',
    chipBg: 'rgba(140,190,110,0.08)',
    glow: 'rgba(140,190,110,0.3)',
  },
  needs_attention: {
    label: 'Needs attention',
    accent: '#DCA746',
    chipBorder: 'rgba(220,167,70,0.35)',
    chipBg: 'rgba(220,167,70,0.08)',
    glow: 'rgba(220,167,70,0.3)',
  },
  at_risk: {
    label: 'At risk',
    accent: '#DE6E4C',
    chipBorder: 'rgba(222,110,76,0.4)',
    chipBg: 'rgba(222,110,76,0.1)',
    glow: 'rgba(222,110,76,0.32)',
  },
};

const SOURCE_TAG   = { monday: 'MON', meeting: 'MTG', whatsapp: 'WA' };
const STALE_DAYS   = 8;
const REPO_OWNER   = 'flow-co-ai';
const REPO_NAME    = 'flow-standup';

const KEY_PASSCODE = 'flowops-passcode';
const localChecksKey = (weekOf) => `flowops-v4-${weekOf}`;
const KEY_DISMISSED_ALERTS = 'flowops-dismissed-alerts';

// ── state ─────────────────────────────────────────────────────────────────────

let standup   = null;
let handled   = {};       // { rowId: true }  — only checked rows stored
let copiedId  = null;
let copyTimer = null;
let saveTimer = null;
let priorWeekExpanded = {}; // { clientName: true } — collapsed-by-default per card
let dismissedAlerts   = loadDismissedAlerts(); // Set of alert keys already seen

// ── view routing (grid <-> client detail via location.hash) ──────────────────

function currentClientView() {
  const m = location.hash.match(/^#c=(.+)$/);
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  const exists = (standup?.by_client || []).some(c => c.client === name);
  return exists ? name : null;
}

function openClient(name) {
  location.hash = `c=${encodeURIComponent(name)}`;
}

function backToGrid() {
  // Prefer history.back() when the grid is in history (keeps back-gesture natural)
  if (location.hash) history.back(); else render();
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ── persistence layer ─────────────────────────────────────────────────────────

// --- localStorage (offline mirror) -------------------------------------------

function loadLocal() {
  if (!standup?.week_of) return;
  try { handled = JSON.parse(localStorage.getItem(localChecksKey(standup.week_of)) || '{}'); }
  catch { handled = {}; }
}

function saveLocal() {
  if (!standup?.week_of) return;
  try { localStorage.setItem(localChecksKey(standup.week_of), JSON.stringify(handled)); } catch {}
}

// --- passcode -----------------------------------------------------------------

function getPasscode()        { return localStorage.getItem(KEY_PASSCODE) || null; }
function storePasscode(p)     { localStorage.setItem(KEY_PASSCODE, p); }
function clearStoredPasscode(){ localStorage.removeItem(KEY_PASSCODE); }

// --- dismissed auto-completed alerts (localStorage) ---------------------------

function loadDismissedAlerts() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY_DISMISSED_ALERTS) || '[]')); }
  catch { return new Set(); }
}
function saveDismissedAlerts(set) {
  try { localStorage.setItem(KEY_DISMISSED_ALERTS, JSON.stringify([...set])); } catch {}
}
// item+board+timestamp is stable across reloads and unique per real alert —
// dismissing marks exactly the alerts shown at dismiss time, so a NEW alert
// added later (different timestamp) still brings the banner back.
function alertKey(a) { return `${a.item}|${a.board}|${a.timestamp}`; }

// --- remote read (public, no auth) -------------------------------------------

async function loadRemoteChecks() {
  if (!standup?.week_of) return;
  const url =
    `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}` +
    `/refs/heads/state/checks/${standup.week_of}.json?t=${Date.now()}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) return;   // fresh week — all unchecked
    if (!res.ok)            return;   // silently fall back to local
    const remote = await res.json();
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      handled = remote;
      saveLocal(); // keep local mirror in sync
      render();
    }
  } catch { /* network error — local mirror already loaded */ }
}

// --- remote write (requires passcode) ----------------------------------------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 2000);
}

async function doSave() {
  const passcode = getPasscode();
  if (!passcode) {
    showPasscodePrompt();
    return;
  }

  setSyncStatus('saving');

  try {
    const res = await fetch('/.netlify/functions/save-checks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Key': passcode,
      },
      body: JSON.stringify({ week_of: standup.week_of, checks: handled }),
    });

    if (res.status === 401) {
      clearStoredPasscode();
      setSyncStatus('failed');
      showPasscodePrompt();
      return;
    }

    if (!res.ok) {
      setSyncStatus('failed');
      return;
    }

    setSyncStatus('saved');
  } catch {
    // Network error — local state is safe; retry on next toggle
    setSyncStatus('failed');
  }
}

// --- toggle ------------------------------------------------------------------

function toggleHandled(id) {
  if (handled[id]) delete handled[id]; else handled[id] = true;
  saveLocal();
  render();
  scheduleSave(); // doSave will show passcode prompt if needed
}

// ── sync status indicator ─────────────────────────────────────────────────────

let fadeTimer = null;

function setSyncStatus(status) {
  const el_ = document.getElementById('sync-status');
  if (!el_) return;
  clearTimeout(fadeTimer);

  const config = {
    saving: { text: '· syncing…',    color: 'rgba(169,180,120,0.55)' },
    saved:  { text: '· synced',      color: 'rgba(169,180,120,0.35)' },
    failed: { text: '· sync failed', color: 'rgba(220,167,70,0.75)'  },
  }[status];

  if (!config) { el_.hidden = true; return; }

  el_.textContent = config.text;
  el_.style.color = config.color;
  el_.hidden = false;

  if (status === 'saved') {
    fadeTimer = setTimeout(() => { el_.hidden = true; }, 3500);
  }
}

// ── passcode prompt ───────────────────────────────────────────────────────────

let promptBar = null;

function showPasscodePrompt() {
  if (promptBar) { promptBar.hidden = false; focusPasscodeInput(); return; }

  promptBar = el('div', { class: 'passcode-bar', role: 'dialog', 'aria-label': 'Enter ops passcode to sync' },
    el('form', { class: 'passcode-form', onsubmit: onPasscodeSubmit },
      el('label', { class: 'passcode-label', for: 'passcode-input', text: 'Sync passcode' }),
      el('input', {
        id: 'passcode-input',
        class: 'passcode-input',
        type: 'password',
        placeholder: 'enter passcode…',
        autocomplete: 'current-password',
        required: '',
      }),
      el('button', { class: 'passcode-submit', type: 'submit', text: 'Sync' }),
      el('button', {
        class: 'passcode-dismiss',
        type: 'button',
        'aria-label': 'Dismiss',
        html: '&#10005;',
        onclick: () => { promptBar.hidden = true; },
      }),
    ),
  );

  document.body.append(promptBar);
  focusPasscodeInput();
}

function focusPasscodeInput() {
  setTimeout(() => document.getElementById('passcode-input')?.focus(), 80);
}

function onPasscodeSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('passcode-input');
  const val   = (input?.value || '').trim();
  if (!val) return;
  storePasscode(val);
  if (input) input.value = '';
  promptBar.hidden = true;
  // Trigger the pending save immediately (skip debounce)
  clearTimeout(saveTimer);
  doSave();
}

// ── clipboard ─────────────────────────────────────────────────────────────────

function copyText(id, text) {
  const done = () => {
    copiedId = id;
    render();
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedId = null; render(); }, 1800);
  };
  const fallback = () => {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    Object.assign(ta.style, { position: 'fixed', opacity: '0' });
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { fallback(); done(); });
  } else { fallback(); done(); }
}

// ── minimal DOM builder ───────────────────────────────────────────────────────

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if      (k === 'class')                                    e.className = v;
    else if (k === 'text')                                     e.textContent = v;
    else if (k === 'html')                                     e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function')    e[k] = v;
    else if (k === 'style'      && typeof v === 'object')      Object.assign(e.style, v);
    else                                                       e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

// ── checkbox builder ──────────────────────────────────────────────────────────

function isHandled(id) { return !!handled[id]; }

function buildCheckbox(id, isStalled) {
  const checked = isHandled(id);
  const inner = el('span', {
    class: `checkbox-inner${checked ? ' checked' : ''}`,
    html: checked ? '&#10003;' : '',
  });
  const wrap = el('span', {
    class: `row-checkbox${isStalled ? ' stalled-checkbox' : ''}`,
    role: 'button',
    tabindex: '0',
    'aria-label': 'Mark handled',
    onclick: () => toggleHandled(id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHandled(id); } },
  }, inner);
  return wrap;
}

// ── row builder ───────────────────────────────────────────────────────────────

function buildRow(item, isStalled) {
  if (!item || typeof item !== 'object') return null;
  const { id, text, source, monday_url: url, item_name, days_stalled } = item;
  const tag = SOURCE_TAG[source] || '';

  const textSpan = el('span', { class: 'row-text', text });

  const metaEls = [];
  if (isStalled && days_stalled != null) {
    metaEls.push(el('span', { class: 'days-badge', text: `${days_stalled}d` }));
  }
  if (tag) metaEls.push(el('span', { class: 'source-chip', text: tag }));

  let rightEl;
  if (url) {
    rightEl = el('a', {
      href: url,
      target: '_blank',
      rel: 'noopener',
      title: item_name || 'Open in Monday.com',
      class: 'row-right row-link',
      onclick: (e) => e.stopPropagation(),
    }, ...metaEls, el('span', { class: 'chevron', html: '&#8599;' }));
  } else {
    rightEl = el('span', { class: 'row-right' }, ...metaEls);
  }

  const rowContent = el('div', {
    class: isStalled ? 'stalled-row' : 'highlight-row',
  }, textSpan, rightEl);

  return el('div', { class: 'row-wrapper no-checkbox' }, rowContent);
}

// completed_this_week / completed_prior_week rows: {text, who, source, monday_url}.
// source here is already the short tag (MTG/MON/WA) from the accumulator —
// unlike buildRow's items, it's not mapped through SOURCE_TAG.
function buildCompletedRow(item) {
  if (!item || typeof item !== 'object') return null;
  const { text, who, source, monday_url: url } = item;
  const label = who ? `${text} — ${who}` : (text || '');

  const textSpan = el('span', { class: 'row-text', text: label });
  const metaEls = [];
  if (source) metaEls.push(el('span', { class: 'source-chip', text: source }));

  let rightEl;
  if (url) {
    rightEl = el('a', {
      href: url,
      target: '_blank',
      rel: 'noopener',
      title: 'Open in Monday.com',
      class: 'row-right row-link',
      onclick: (e) => e.stopPropagation(),
    }, ...metaEls, el('span', { class: 'chevron', html: '&#8599;' }));
  } else {
    rightEl = el('span', { class: 'row-right' }, ...metaEls);
  }

  const rowContent = el('div', { class: 'completed-row' }, textSpan, rightEl);
  return el('div', { class: 'row-wrapper no-checkbox' }, rowContent);
}

// ── pill builder ──────────────────────────────────────────────────────────────

function buildPill(action, id) {
  if (!action) return null;

  if (action.type === 'email') {
    const params = new URLSearchParams();
    if (action.subject) params.set('subject', action.subject);
    if (action.body)    params.set('body', action.body);
    return el('a', {
      class: 'pill',
      href: `mailto:${action.to || ''}?${params.toString()}`,
      target: '_blank',
      rel: 'noopener',
      html: 'Draft email &#8599;',
    });
  }

  if (action.type === 'copy') {
    if (copiedId === id) {
      return el('span', { class: 'copied-pill', html: 'Copied &#10003;' });
    }
    return el('button', {
      class: 'pill',
      type: 'button',
      text: 'Copy draft',
      onclick: () => copyText(id, action.body || ''),
    });
  }

  return null;
}

// ── next-step row builder ─────────────────────────────────────────────────────

function buildNextRow(priority) {
  if (!priority) return null;
  const id   = priority.id;
  const done = isHandled(id);

  let displayText = priority.text || '';
  const colonIdx  = displayText.indexOf(': ');
  if (colonIdx > 0 && colonIdx < 45) displayText = displayText.slice(colonIdx + 2);

  const textEl = el('span', {
    class: 'next-text',
    style: { textDecoration: done ? 'line-through' : 'none' },
    text: displayText,
  });

  const content = el('div', { class: 'next-content' }, textEl, buildPill(priority.action, id));

  return el('div', { class: 'row-wrapper no-checkbox' }, content);
}

// ── priority matcher ──────────────────────────────────────────────────────────

function findPriorityForClient(priorities, clientEntry) {
  const name = clientEntry.client;

  let m = priorities.find(p => p.client && p.client === name);
  if (m) return m;

  const prefix = name.toLowerCase() + ': ';
  m = priorities.find(p => (p.text || '').toLowerCase().startsWith(prefix));
  if (m) return m;

  m = priorities.find(p => (p.text || '').toLowerCase().includes(name.toLowerCase()));
  return m || null;
}

// ── mini card builder (grid view) ─────────────────────────────────────────────

function buildMiniCard(entry) {
  const h = HEALTH[entry.health] || HEALTH.on_track;

  const card = el('article', {
    class: 'mini-card',
    role: 'button',
    tabindex: '0',
    'aria-label': `Open ${entry.client}`,
    onclick: () => openClient(entry.client),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClient(entry.client); }
    },
  });

  card.append(el('div', { class: 'mini-state' },
    el('span', { class: 'mini-dot', style: { background: h.accent, boxShadow: `0 0 8px ${h.glow}` } }),
    el('span', { class: 'mini-state-label', style: { color: h.accent }, text: h.label }),
  ));
  card.append(el('h2', { class: 'mini-name', text: entry.client }));
  card.append(el('p', { class: 'mini-micro', text: entry.headline || 'No activity recorded this week.' }));

  const s = entry.stats || {};
  if (s.tasks > 0 || s.monday_msgs > 0 || s.meetings > 0 || s.wa_msgs > 0) {
    const statsEl = el('div', { class: 'mini-stats' });
    const chip = (n, label, warn) => el('span', { class: `mini-stat${warn ? ' stat-warn' : ''}` },
      el('span', { class: 'mini-stat-n', text: String(n) }),
      ` ${label}`,
    );
    if (s.tasks)      statsEl.append(chip(s.tasks, 'tasks', false));
    if (s.working)    statsEl.append(chip(s.working, 'working', false));
    if (s.review)     statsEl.append(chip(s.review, 'review', false));
    if (s.stuck)      statsEl.append(chip(s.stuck, 'stuck', true));
    if (s.done)       statsEl.append(chip(s.done, 'done', false));
    if (s.monday_msgs) statsEl.append(chip(s.monday_msgs, 'msgs', false));
    if (s.meetings)   statsEl.append(chip(s.meetings, 'mtgs', false));
    if (s.wa_msgs)    statsEl.append(chip(s.wa_msgs, 'wa', false));
    card.append(statsEl);
  }

  return card;
}

// ── card builder ──────────────────────────────────────────────────────────────

function buildCard(entry, priorities) {
  const h = HEALTH[entry.health] || HEALTH.on_track;

  const highlights = (entry.work_by_department || []).flatMap(d => d.highlights    || []);
  const stalled    = (entry.work_by_department || []).flatMap(d => d.stalled_items || []);
  const clientPrio = findPriorityForClient(priorities, entry);

  const card = el('article', { class: 'client-card' });

  card.append(el('div', { class: 'card-header' },
    el('span', { class: 'client-name', text: entry.client }),
    el('span', {
      class: 'health-chip',
      style: { color: h.accent, borderColor: h.chipBorder, background: h.chipBg },
      text: h.label,
    }),
  ));

  const sections = el('div', { class: 'card-sections' });

  if (highlights.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label', text: 'What happened' }));
    highlights.forEach(h => { const r = buildRow(h, false); if (r) sec.append(r); });
    sections.append(sec);
  }

  if (stalled.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label stalled-label', text: 'Stalled' }));
    stalled.forEach(s => { const r = buildRow(s, true); if (r) sec.append(r); });
    sections.append(sec);
  }

  const completedThisWeek  = entry.completed_this_week || [];
  const completedPriorWeek = entry.completed_prior_week || {};
  const completedPriorItems = completedPriorWeek.items || [];

  if (completedThisWeek.length || completedPriorItems.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label completed-label', text: 'Completed' }));
    completedThisWeek.forEach(c => { const r = buildCompletedRow(c); if (r) sec.append(r); });

    if (completedPriorItems.length) {
      const expanded   = !!priorWeekExpanded[entry.client];
      const rangeLabel = isoWeekToDateRange(completedPriorWeek.week_of) || 'prior week';
      const toggle = el('button', {
        class: 'prior-week-toggle',
        type: 'button',
        onclick: () => { priorWeekExpanded[entry.client] = !expanded; render(); },
      },
        el('span', { class: 'prior-week-caret', text: expanded ? '▾' : '▸' }),
        ` ${rangeLabel} (${completedPriorItems.length})`,
      );
      sec.append(toggle);

      if (expanded) {
        const priorList = el('div', { class: 'prior-week-list' });
        completedPriorItems.forEach(c => { const r = buildCompletedRow(c); if (r) priorList.append(r); });
        sec.append(priorList);
      }
    }
    sections.append(sec);
  }

  if (clientPrio) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label', text: 'Next' }));
    const r = buildNextRow(clientPrio);
    if (r) sec.append(r);
    sections.append(sec);
  }

  card.append(sections);
  return card;
}

// ── footer renderer ───────────────────────────────────────────────────────────

function renderFooter() {
  const commsFlags = standup.comms_flags || [];
  const unmapped   = (standup.by_client || []).filter(c => c.client === 'Unmapped');

  // Unmatched section removed by request — unmapped work stays in the email only.

  const ts = document.getElementById('footer-ts');
  if (ts && standup.week_of) {
    ts.textContent =
      `Generated for week of ${standup.week_of} from Monday.com boards, meeting transcripts, and team messages.`;
  }
}

// ── auto-completed alert banner (page-level, not per-card) ────────────────────
//
// generate.py's completion tracker can auto-mark an item Done on Monday from
// comms evidence alone — GitHub Actions has no way to ping anyone directly,
// so this banner is the notification channel for that specifically. It stays
// dismissed (per-alert, via localStorage) once seen, but a genuinely NEW
// alert (different item/board/timestamp) brings it back.

function renderAlertBanner() {
  const container = document.getElementById('alert-banner-container');
  if (!container) return;
  container.innerHTML = '';

  const alerts = (standup?.auto_completed_alerts || []).filter(a => !dismissedAlerts.has(alertKey(a)));
  if (!alerts.length) return;

  const list = el('ul', { class: 'alert-banner-list' },
    ...alerts.map(a => el('li', { class: 'alert-banner-item' },
      el('span', { class: 'alert-banner-text', text: a.item || '' }),
      ' ',
      el('span', {
        class: 'alert-banner-meta',
        text: `(${a.board || 'Unknown'} · ${a.evidence_source || ''} · ${fmtTimestamp(a.timestamp)})`,
      }),
    )),
  );

  const banner = el('div', { class: 'alert-banner', role: 'alert' },
    el('div', { class: 'alert-banner-header' },
      el('span', { class: 'alert-banner-title', text: '⚠️ Auto-marked Done on Monday' }),
      el('button', {
        class: 'alert-banner-dismiss',
        type: 'button',
        'aria-label': 'Dismiss',
        html: '&#10005;',
        onclick: () => {
          alerts.forEach(a => dismissedAlerts.add(alertKey(a)));
          saveDismissedAlerts(dismissedAlerts);
          renderAlertBanner();
        },
      }),
    ),
    list,
  );
  container.append(banner);
}

// ── full render (called on every state change) ────────────────────────────────

function render() {
  if (!standup) return;
  const app        = document.getElementById('app');
  const priorities = standup.this_week_priorities || [];
  const viewClient = currentClientView();
  app.innerHTML    = '';

  if (viewClient) {
    // ── detail view ──
    app.className = 'client-detail';
    app.append(el('button', {
      class: 'back-link',
      type: 'button',
      html: '&#8592;&nbsp; All clients',
      onclick: backToGrid,
    }));
    const entry = (standup.by_client || []).find(c => c.client === viewClient);
    if (entry) app.append(buildCard(entry, priorities));
    return;
  }

  // ── grid view ──
  app.className = 'client-grid';
  (standup.by_client || []).forEach(entry => {
    if (entry.client === 'Unmapped') return;
    app.append(buildMiniCard(entry));
  });
}

// ── date formatting ───────────────────────────────────────────────────────────

function fmtDate(iso) {
  try {
    return new Date(iso + 'T12:00:00Z')
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function fmtTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso || ''; }
}

// "2026-W28" -> "Jul 7 – Jul 13" (the ISO week's Monday-Sunday range).
// The accumulator carries the compact ISO week code; this is just for display.
function isoWeekToDateRange(isoWeekStr) {
  if (!isoWeekStr) return '';
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeekStr);
  if (!m) return isoWeekStr;
  const year = parseInt(m[1], 10), week = parseInt(m[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

// ── init ──────────────────────────────────────────────────────────────────────

async function init() {
  // 1. Fetch standup JSON
  standup = await (async () => {
    try {
      const res = await fetch('latest.json');
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  })();

  if (!standup) {
    document.getElementById('banner-missing').hidden = false;
    return;
  }

  // 2. Load local mirror first (instant, no flicker)
  loadLocal();

  // 3. Staleness check
  if (standup.week_of) {
    const ageDays = (Date.now() - new Date(standup.week_of + 'T12:00:00Z').getTime()) / 86_400_000;
    if (ageDays > STALE_DAYS) {
      document.getElementById('banner-stale').hidden = false;
    }
  }

  // 4. Header
  const weekEl = document.getElementById('week-of');
  if (weekEl && standup.week_of) {
    weekEl.textContent = `Week of ${fmtDate(standup.week_of)}`;
  }

  // 5. First render with local state
  render();
  renderFooter();
  renderAlertBanner();

  // 6. Fetch remote checks (replaces local if newer; re-renders if different)
  //    Runs async so the page is already interactive
  await loadRemoteChecks();
}

document.addEventListener('DOMContentLoaded', init);
