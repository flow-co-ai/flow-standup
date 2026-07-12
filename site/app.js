/* app.js — Flow Ops dashboard
 * Reads site/latest.json, renders client cards, persists handled state.
 * Pure JS, no frameworks. Persistence layer: localStorage (easy to swap).
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

const SOURCE_TAG = { monday: 'MON', meeting: 'MTG', whatsapp: 'WA' };
const STORAGE_KEY = 'flowops-v3-handled';
const STALE_DAYS  = 8;

// ── state ─────────────────────────────────────────────────────────────────────

let standup  = null;
let handled  = {};   // { "week_of:rowId": true }
let copiedId = null;
let copyTimer = null;

// ── persistence (swap this block to sync to a server later) ───────────────────

function loadHandled() {
  try { handled = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { handled = {}; }
}

function saveHandled() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(handled)); } catch {}
}

function rowKey(id) {
  return `${standup?.week_of || 'noweek'}:${id}`;
}

function isHandled(id) { return !!handled[rowKey(id)]; }

function toggleHandled(id) {
  const k = rowKey(id);
  if (handled[k]) delete handled[k]; else handled[k] = true;
  saveHandled();
  render();
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
    if      (k === 'class')                    e.className = v;
    else if (k === 'text')                     e.textContent = v;
    else if (k === 'html')                     e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e[k] = v;
    else if (k === 'style' && typeof v === 'object')        Object.assign(e.style, v);
    else                                       e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

// ── checkbox builder ──────────────────────────────────────────────────────────

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
  const handled_ = isHandled(id);
  const tag = SOURCE_TAG[source] || '';

  const textSpan = el('span', {
    class: 'row-text',
    style: { textDecoration: handled_ ? 'line-through' : 'none' },
    text,
  });

  // Right side: days badge (stalled), source chip
  const metaEls = [];
  if (isStalled && days_stalled != null) {
    metaEls.push(el('span', { class: 'days-badge', text: `${days_stalled}d` }));
  }
  if (tag) metaEls.push(el('span', { class: 'source-chip', text: tag }));

  let rowContent;
  if (url) {
    const rightSlot = el('span', { class: 'row-right' },
      ...metaEls,
      el('span', { class: 'chevron', html: '&#8599;' }),
    );
    rowContent = el('a', {
      href: url,
      target: '_blank',
      rel: 'noopener',
      title: item_name || 'Open in Monday.com',
      class: `${isStalled ? 'stalled-row' : 'highlight-row'}${handled_ ? ' handled' : ''}`,
    }, textSpan, rightSlot);
  } else {
    // Plain row — no chevron, slightly dimmer
    const metaWrap = el('span', { class: 'source-chip', text: tag });
    rowContent = el('div', {
      class: `row-plain${handled_ ? ' handled' : ''}`,
    }, textSpan, metaWrap);
  }

  return el('div', { class: 'row-wrapper' },
    buildCheckbox(id, isStalled),
    rowContent,
  );
}

// ── pill builder ──────────────────────────────────────────────────────────────

function buildPill(action, id) {
  if (!action) return null;

  if (action.type === 'email') {
    const params = new URLSearchParams();
    if (action.subject) params.set('subject', action.subject);
    if (action.body)    params.set('body', action.body);
    const to = action.to || '';
    return el('a', {
      class: 'pill',
      href: `mailto:${to}?${params.toString()}`,
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
  const id = priority.id;
  const handled_ = isHandled(id);

  // Strip "ClientName: " prefix for display
  let displayText = priority.text || '';
  const colonIdx = displayText.indexOf(': ');
  if (colonIdx > 0 && colonIdx < 45) displayText = displayText.slice(colonIdx + 2);

  const textEl = el('span', {
    class: 'next-text',
    style: { textDecoration: handled_ ? 'line-through' : 'none' },
    text: displayText,
  });

  const pill = buildPill(priority.action, id);

  const content = el('div', {
    class: `next-content${handled_ ? ' handled' : ''}`,
  }, textEl, pill);

  return el('div', { class: 'row-wrapper' },
    buildCheckbox(id, false),
    content,
  );
}

// ── priority matcher ──────────────────────────────────────────────────────────

function findPriorityForClient(priorities, clientEntry) {
  const clientName = clientEntry.client;

  // 1. Exact client field match (from schema's optional .client property)
  let match = priorities.find(p => p.client && p.client === clientName);
  if (match) return match;

  // 2. Text starts with "ClientName: "
  const prefix = clientName.toLowerCase() + ': ';
  match = priorities.find(p => (p.text || '').toLowerCase().startsWith(prefix));
  if (match) return match;

  // 3. Text contains client name as a substring (loose fallback)
  match = priorities.find(p => (p.text || '').toLowerCase().includes(clientName.toLowerCase()));
  return match || null;
}

// ── card builder ──────────────────────────────────────────────────────────────

function buildCard(entry, priorities) {
  const h = HEALTH[entry.health] || HEALTH.on_track;

  // Flatten highlights and stalled across all departments
  const highlights = (entry.work_by_department || []).flatMap(d => d.highlights   || []);
  const stalled    = (entry.work_by_department || []).flatMap(d => d.stalled_items || []);

  const clientPriority = findPriorityForClient(priorities, entry);

  const card = el('article', { class: 'client-card' });

  // Header: name + health chip
  card.append(el('div', { class: 'card-header' },
    el('span', { class: 'client-name', text: entry.client }),
    el('span', {
      class: 'health-chip',
      style: { color: h.accent, borderColor: h.chipBorder, background: h.chipBg },
      text: h.label,
    }),
  ));

  // Headline
  card.append(el('p', {
    class: 'headline',
    style: { color: h.accent, textShadow: `0 0 26px ${h.glow}` },
    text: entry.headline || '',
  }));

  const sections = el('div', { class: 'card-sections' });

  // What happened
  if (highlights.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label', text: 'What happened' }));
    highlights.forEach(h => { const r = buildRow(h, false); if (r) sec.append(r); });
    sections.append(sec);
  }

  // Stalled
  if (stalled.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label stalled-label', text: 'Stalled' }));
    stalled.forEach(s => { const r = buildRow(s, true); if (r) sec.append(r); });
    sections.append(sec);
  }

  // Next
  if (clientPriority) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label', text: 'Next' }));
    const r = buildNextRow(clientPriority);
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

  const footerItems = [];
  commsFlags.forEach(f => footerItems.push(typeof f === 'string' ? f : f.text || ''));
  unmapped.forEach(u => {
    (u.work_by_department || []).forEach(d => {
      (d.highlights    || []).forEach(h => footerItems.push(`[Unmapped] ${h.text || h}`));
      (d.stalled_items || []).forEach(s => footerItems.push(`[Unmapped, stalled] ${s.text || s}`));
    });
  });

  const sectionEl = document.getElementById('footer-unmatched');
  const itemsEl   = document.getElementById('footer-items');
  if (footerItems.length && sectionEl && itemsEl) {
    footerItems.forEach(t => itemsEl.append(el('div', { class: 'footer-item', text: t })));
    sectionEl.hidden = false;
  }

  const ts = document.getElementById('footer-ts');
  if (ts) {
    const stamp = standup.week_of
      ? `Generated for week of ${standup.week_of} from Monday.com boards, meeting transcripts, and team messages.`
      : '';
    ts.textContent = stamp;
  }
}

// ── full render (called on every state change) ────────────────────────────────

function render() {
  if (!standup) return;

  const app       = document.getElementById('app');
  const priorities = standup.this_week_priorities || [];

  // Clear previous cards (leave banners/header intact via HTML structure)
  app.innerHTML = '';

  (standup.by_client || []).forEach(entry => {
    if (entry.client === 'Unmapped') return; // shown in footer
    app.append(buildCard(entry, priorities));
  });
}

// ── date formatting ───────────────────────────────────────────────────────────

function fmtDate(iso) {
  try {
    const d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

// ── init ──────────────────────────────────────────────────────────────────────

async function init() {
  loadHandled();

  // Fetch data
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

  // Staleness check
  if (standup.week_of) {
    const ageDays = (Date.now() - new Date(standup.week_of + 'T12:00:00Z').getTime()) / 86_400_000;
    if (ageDays > STALE_DAYS) {
      document.getElementById('banner-stale').hidden = false;
    }
  }

  // Header week label
  const weekEl = document.getElementById('week-of');
  if (weekEl && standup.week_of) {
    weekEl.textContent = `Week of ${fmtDate(standup.week_of)}`;
  }

  render();
  renderFooter();
}

document.addEventListener('DOMContentLoaded', init);
