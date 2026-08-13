// standup-brief.js — injects the `brief` block from pulse JSON into the
// client detail view of the Standup tab (index.html).
//
// Observes #app for re-renders via MutationObserver; never touches
// app.js / index.html / style.css.
//
// If pulse/{slug}.json has no `brief` key, falls through silently and the
// existing expand behavior is unchanged.

(function () {
  'use strict';

  const PULSE_BASE = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/pulse';

  // Display name → slug. Mirrors apply_ops_pulse.js + extends performance.js's
  // PULSE_SLUG map (same source of truth philosophy).
  const SLUG_MAP = {
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
    'Steel Round Bars':      'steel-round-bars',
    'MedStation':            'medstation',
    'Flow Company':          'flow-company',
    'Cotton Collections':    'cotton-collections',
  };

  function slugFor(name) {
    return SLUG_MAP[name] ||
      name.toLowerCase().replace(/[',&.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function currentClient() {
    const m = location.hash.match(/^#c=(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ── Minimal DOM builder ──────────────────────────────────────────────────────

  function el(tag, cls, ...children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const c of children.flat()) {
      if (c == null) continue;
      e.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  // ── Color tokens ─────────────────────────────────────────────────────────────

  const HEADLINE_TONE = {
    win:   { bg: 'rgba(140,190,110,0.18)', color: '#8CBE6E', border: 'rgba(140,190,110,0.35)' },
    info:  { bg: 'rgba(155,137,212,0.18)', color: '#A998E0', border: 'rgba(155,137,212,0.35)' },
    shift: { bg: 'rgba(220,167,70,0.18)',  color: '#DCA746', border: 'rgba(220,167,70,0.35)' },
  };

  const BADGE_TONE = {
    red:    { bg: 'rgba(222,110,76,0.18)',  color: '#DE6E4C', border: 'rgba(222,110,76,0.35)' },
    amber:  { bg: 'rgba(220,167,70,0.18)',  color: '#DCA746', border: 'rgba(220,167,70,0.35)' },
    green:  { bg: 'rgba(140,190,110,0.18)', color: '#8CBE6E', border: 'rgba(140,190,110,0.35)' },
    purple: { bg: 'rgba(155,137,212,0.18)', color: '#A998E0', border: 'rgba(155,137,212,0.35)' },
  };

  const STATE_ICON = {
    blocked: { char: '⚠', color: '#DE6E4C' },
    done:    { char: '✓', color: '#8CBE6E' },
    next:    { char: '→', color: '#DCA746' },
    queued:  { char: '⏱', color: 'rgba(237,233,220,0.35)' },
  };

  function trackIcon(title) {
    const t = title.toLowerCase();
    if (t.includes('crm') || t.includes('ghl'))    return '🔗';
    if (t.includes('ads') || t.includes('meta'))   return '📣';
    if (t.includes('web') || t.includes('seo'))    return '🌐';
    if (t.includes('video'))                        return '🎬';
    if (t.includes('email'))                        return '📧';
    return '◆';
  }

  // ── Brief DOM builders ───────────────────────────────────────────────────────

  function buildHeadlines(headlines) {
    const row = el('div', 'sb-headlines');
    for (const h of headlines) {
      const t = HEADLINE_TONE[h.tone] || HEADLINE_TONE.info;
      const chip = el('span', 'sb-chip');
      chip.textContent = h.text;
      chip.style.cssText = `background:${t.bg};color:${t.color};border-color:${t.border}`;
      row.append(chip);
    }
    return row;
  }

  function buildWorkstreamCard(ws) {
    const bt   = BADGE_TONE[ws.badge?.tone] || BADGE_TONE.amber;
    const card = el('div', 'sb-card');

    // Header: icon + title + badge (right-aligned via flex)
    const hdr   = el('div', 'sb-card-hdr');
    const icon  = el('span', 'sb-track-icon');
    icon.textContent = trackIcon(ws.title);
    const title = el('span', 'sb-card-title');
    title.textContent = ws.title;
    const badge = el('span', 'sb-badge');
    badge.textContent = ws.badge?.label || '';
    badge.style.cssText = `background:${bt.bg};color:${bt.color};border-color:${bt.border}`;
    hdr.append(icon, title, badge);
    card.append(hdr);

    // Items
    if (ws.items?.length) {
      const list = el('ul', 'sb-items');
      for (const item of ws.items) {
        const si = STATE_ICON[item.state] || STATE_ICON.queued;
        const li = el('li', 'sb-item');
        const ico = el('span', 'sb-item-icon');
        ico.textContent = si.char;
        ico.style.color = si.color;
        const txt = el('span', 'sb-item-text');
        txt.textContent = item.text;
        li.append(ico, txt);
        list.append(li);
      }
      card.append(list);
    }

    // Owners footer
    if (ws.owners?.length) {
      const owners = el('div', 'sb-owners');
      owners.textContent = ws.owners.join(', ');
      card.append(owners);
    }

    return card;
  }

  function buildWaitingCard(items) {
    if (!items?.length) return null;
    const card = el('div', 'sb-card sb-card--woc');

    const hdr = el('div', 'sb-card-hdr');
    const ico = el('span', 'sb-track-icon');
    ico.textContent = '⏳';
    const title = el('span', 'sb-card-title');
    title.textContent = 'Waiting on client';
    hdr.append(ico, title);
    card.append(hdr);

    const list = el('ul', 'sb-items');
    for (const w of items) {
      const li   = el('li', 'sb-item sb-item--woc');
      const bold = el('strong', 'sb-woc-item');
      bold.textContent = w.item;
      const meta = el('span', 'sb-woc-meta');
      meta.textContent = ` (${w.who}, since ${w.since})`;
      li.append(bold, meta);
      list.append(li);
    }
    card.append(list);
    return card;
  }

  function buildGateCard(gate) {
    if (!gate) return null;
    const card = el('div', 'sb-card sb-card--gate sb-card--full');

    const hdr = el('div', 'sb-card-hdr');
    const ico = el('span', 'sb-track-icon');
    ico.textContent = '🚦';
    const title = el('span', 'sb-card-title');
    title.textContent = gate.title;
    hdr.append(ico, title);
    card.append(hdr);

    if (gate.items?.length) {
      const grid = el('div', 'sb-gate-grid');
      for (const item of gate.items) {
        const label = el('label', 'sb-gate-item');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!item.done;
        cb.disabled = true;
        const txt = el('span', null);
        txt.textContent = item.text;
        label.append(cb, txt);
        grid.append(label);
      }
      card.append(grid);
    }

    if (gate.note) {
      const note = el('div', 'sb-gate-note');
      note.textContent = gate.note;
      card.append(note);
    }
    return card;
  }

  function buildBrief(brief) {
    const section = el('section', 'sb-brief');

    if (brief.headlines?.length) {
      section.append(buildHeadlines(brief.headlines));
    }

    const grid = el('div', 'sb-grid');

    for (const ws of (brief.workstreams || [])) {
      grid.append(buildWorkstreamCard(ws));
    }

    const woc = buildWaitingCard(brief.waiting_on_client);
    if (woc) grid.append(woc);

    const gate = buildGateCard(brief.launch_gate);
    if (gate) grid.append(gate);

    if (grid.children.length) section.append(grid);

    return section;
  }

  // ── Injection ─────────────────────────────────────────────────────────────────

  // In-session cache: slug → pulse JSON (avoids re-fetching on render() calls)
  const pulseCache = new Map();

  async function injectBrief() {
    const clientName = currentClient();
    if (!clientName) return;

    const summary = document.querySelector('.client-detail-pane-summary');
    if (!summary) return;

    // Guard against double-injection on the same render cycle.
    // Mark early (before the async fetch) so concurrent observer firings bail out.
    if (summary.dataset.sbInjected === clientName) return;
    summary.dataset.sbInjected = clientName;

    const slug = slugFor(clientName);
    let pulse;

    if (pulseCache.has(slug)) {
      pulse = pulseCache.get(slug);
    } else {
      try {
        const res = await fetch(`${PULSE_BASE}/${slug}.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;            // no pulse file → leave existing UI unchanged
        pulse = await res.json();
        pulseCache.set(slug, pulse);
      } catch {
        return;                         // network error → leave existing UI unchanged
      }
    }

    if (!pulse?.brief) return;          // pulse exists but no brief → leave unchanged

    // Re-check the summary is still in the DOM (app.js may have re-rendered)
    const card = summary.querySelector('.client-card');
    if (!card) return;

    card.after(buildBrief(pulse.brief));
  }

  // ── MutationObserver ──────────────────────────────────────────────────────────

  function observe() {
    const app = document.getElementById('app');
    if (!app) return;

    const obs = new MutationObserver(() => {
      if (document.querySelector('.client-detail-pane-summary')) {
        injectBrief();
      }
    });
    obs.observe(app, { childList: true, subtree: true });

    // Catch the case where we load directly onto a detail-view URL
    if (document.querySelector('.client-detail-pane-summary')) injectBrief();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }
})();
