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

// ── state ─────────────────────────────────────────────────────────────────────

let standup   = null;
let handled   = {};       // { rowId: true }  — only checked rows stored
let copiedId  = null;
let copyTimer = null;
let saveTimer = null;

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
  const done = isHandled(id);
  const tag  = SOURCE_TAG[source] || '';

  const textSpan = el('span', {
    class: 'row-text',
    style: { textDecoration: done ? 'line-through' : 'none' },
    text,
  });

  const metaEls = [];
  if (isStalled && days_stalled != null) {
    metaEls.push(el('span', { class: 'days-badge', text: `${days_stalled}d` }));
  }
  if (tag) metaEls.push(el('span', { class: 'source-chip', text: tag }));

  let rowContent;
  if (url) {
    rowContent = el('a', {
      href: url,
      target: '_blank',
      rel: 'noopener',
      title: item_name || 'Open in Monday.com',
      class: `${isStalled ? 'stalled-row' : 'highlight-row'}${done ? ' handled' : ''}`,
    },
      textSpan,
      el('span', { class: 'row-right' },
        ...metaEls,
        el('span', { class: 'chevron', html: '&#8599;' }),
      ),
    );
  } else {
    rowContent = el('div', {
      class: `row-plain${done ? ' handled' : ''}`,
    }, textSpan, el('span', { class: 'source-chip', text: tag }));
  }

  return el('div', { class: 'row-wrapper' }, buildCheckbox(id, isStalled), rowContent);
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

  const content = el('div', {
    class: `next-content${done ? ' handled' : ''}`,
  }, textEl, buildPill(priority.action, id));

  return el('div', { class: 'row-wrapper' }, buildCheckbox(id, false), content);
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

  card.append(el('p', {
    class: 'headline',
    style: { color: h.accent, textShadow: `0 0 26px ${h.glow}` },
    text: entry.headline || '',
  }));

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

  const items = [];
  commsFlags.forEach(f => items.push(typeof f === 'string' ? f : f.text || ''));
  unmapped.forEach(u => {
    (u.work_by_department || []).forEach(d => {
      (d.highlights    || []).forEach(h => items.push(`[Unmapped] ${h.text || h}`));
      (d.stalled_items || []).forEach(s => items.push(`[Unmapped, stalled] ${s.text || s}`));
    });
  });

  const sectionEl = document.getElementById('footer-unmatched');
  const itemsEl   = document.getElementById('footer-items');
  if (items.length && sectionEl && itemsEl) {
    items.forEach(t => itemsEl.append(el('div', { class: 'footer-item', text: t })));
    sectionEl.hidden = false;
  }

  const ts = document.getElementById('footer-ts');
  if (ts && standup.week_of) {
    ts.textContent =
      `Generated for week of ${standup.week_of} from Monday.com boards, meeting transcripts, and team messages.`;
  }
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

  // 6. Fetch remote checks (replaces local if newer; re-renders if different)
  //    Runs async so the page is already interactive
  await loadRemoteChecks();
}

document.addEventListener('DOMContentLoaded', init);
