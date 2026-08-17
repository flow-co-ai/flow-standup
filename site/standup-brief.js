// standup-brief.js — Standup tab v2: white cards + CEO decision surface.
//
// ONLY modifies DOM via MutationObserver — never edits app.js, style.css, index.html.
// Level 1: white mini-card overrides (via standup-brief.css).
// Level 2: v2 detail layout injected after .client-detail-split when a card is opened.

(function () {
  'use strict';

  const PULSE_BASE    = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/pulse';
  const PLAYBOOK_BASE = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/playbooks';

  // ── Slug map ─────────────────────────────────────────────────────────────────

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

  // ── DOM builder ──────────────────────────────────────────────────────────────

  function el(tag, cls, ...children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const c of children.flat()) {
      if (c == null) continue;
      e.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  // ── In-session caches ────────────────────────────────────────────────────────

  const pulseCache    = new Map();
  const playbookCache = new Map();
  let   latestCache   = null;
  let   inboxCache    = null;

  // ── Data fetchers ────────────────────────────────────────────────────────────

  async function fetchPulse(slug) {
    if (pulseCache.has(slug)) return pulseCache.get(slug);
    try {
      const res = await fetch(`${PULSE_BASE}/${slug}.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) { pulseCache.set(slug, null); return null; }
      const data = await res.json();
      pulseCache.set(slug, data);
      return data;
    } catch { pulseCache.set(slug, null); return null; }
  }

  async function fetchPlaybook(slug) {
    if (playbookCache.has(slug)) return playbookCache.get(slug);
    try {
      const res = await fetch(`${PLAYBOOK_BASE}/${slug}.md?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) { playbookCache.set(slug, null); return null; }
      const text = await res.text();
      playbookCache.set(slug, text);
      return text;
    } catch { playbookCache.set(slug, null); return null; }
  }

  async function fetchLatest() {
    if (latestCache) return latestCache;
    try {
      const res = await fetch(`latest.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      latestCache = await res.json();
      return latestCache;
    } catch { return null; }
  }

  async function fetchInbox() {
    if (inboxCache) return inboxCache;
    try {
      const res = await fetch(`inbox.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      inboxCache = await res.json();
      return inboxCache;
    } catch { return null; }
  }

  // ── Unhide hidden clients ────────────────────────────────────────────────────

  let clientsEnsured = false;

  async function ensureClientsVisible() {
    if (clientsEnsured) return;
    clientsEnsured = true;

    const latest = await fetchLatest();
    if (!latest?.by_client?.length) return;

    let overrides = {};
    try {
      const res = await fetch('/.netlify/functions/standup-overrides');
      if (res.ok) overrides = await res.json();
    } catch { return; }

    const toUnhide = latest.by_client
      .map(c => c.client)
      .filter(key => overrides[key]?.hidden);

    if (!toUnhide.length) return;

    await Promise.all(toUnhide.map(key =>
      fetch('/.netlify/functions/standup-overrides', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: key, hidden: false }),
      }).catch(() => {})
    ));

    if (typeof window.loadRemoteStandupOverrides === 'function') {
      await window.loadRemoteStandupOverrides();
    }
  }

  // ── Inbox item lookup for a client ───────────────────────────────────────────

  function clientInboxItems(inbox, clientName) {
    if (!inbox) return [];
    if (Array.isArray(inbox.by_client)) {
      const match = inbox.by_client.find(c => c.client === clientName);
      return match?.items || [];
    }
    if (Array.isArray(inbox)) return inbox.filter(i => i.client === clientName);
    return [];
  }

  // ── Playbook: extract bold header blocks before first `---` ─────────────────

  function parsePlaybookHeader(md) {
    if (!md) return [];
    const text = md.replace(/^<!--[^>]*-->\n?/, '');
    const [preamble = ''] = text.split(/^---$/m);
    const blocks = [];
    for (const line of preamble.split('\n')) {
      const m = line.match(/^\*\*(.+?)\*\*/);
      if (!m) continue;
      const value = line.slice(m[0].length).replace(/^:\s*/, '').trim();
      blocks.push({ label: m[1], value });
    }
    return blocks;
  }

  // ── v2 section builders ──────────────────────────────────────────────────────

  function buildContractHeader(md) {
    const section = el('div', 'sb-v2-section');
    section.append(el('span', 'sb-v2-section-label', 'Contract'));

    const blocks = parsePlaybookHeader(md);
    if (blocks.length) {
      const hdr = el('div', 'sb-contract-header');
      for (const b of blocks) {
        const block  = el('div', 'sb-contract-block');
        const strong = document.createElement('strong');
        strong.textContent = b.label;
        block.append(strong);
        if (b.value) block.append(': ' + b.value);
        hdr.append(block);
      }
      section.append(hdr);
    } else {
      section.append(el('div', 'sb-contract-empty', 'No playbook on file.'));
    }
    return section;
  }

  function buildVerdictBlock(pulse, entry) {
    const section = el('div', 'sb-v2-section');
    section.append(el('span', 'sb-v2-section-label', 'Situation'));

    const v2       = pulse?.brief_v2 || pulse?.brief?.brief_v2;
    const verdict  = v2?.verdict  || entry?.headline  || null;
    const nextMove = v2?.next_move || entry?.upcoming?.[0]?.text || null;

    if (verdict)  section.append(el('div', 'sb-verdict-text', verdict));

    if (nextMove) {
      section.append(el('span', 'sb-next-move-label', 'Next move'));
      section.append(el('div',  'sb-next-move-text',  nextMove));
    }

    if (!verdict && !nextMove) {
      section.append(el('div', 'sb-verdict-fallback', 'No situation data available.'));
    }

    return section;
  }

  function buildDeptLanes(entry, inboxItems) {
    const section = el('div', 'sb-v2-section');
    section.append(el('span', 'sb-v2-section-label', 'By department'));

    const depts = entry?.work_by_department || [];
    if (!depts.length) {
      section.append(el('div', 'sb-verdict-fallback', 'No department data.'));
      return section;
    }

    // Lookup: monday_item_id → inbox item
    const inboxById = new Map();
    for (const ix of inboxItems) {
      if (ix.monday_item_id != null) inboxById.set(String(ix.monday_item_id), ix);
    }

    // Group by department
    const byDept = new Map();
    for (const item of depts) {
      const dept = item.department || 'Other';
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept).push(item);
    }

    // Sort items within each lane stalest first; sort lanes by max days_stalled
    for (const items of byDept.values()) {
      items.sort((a, b) => (b.days_stalled || 0) - (a.days_stalled || 0));
    }
    const sortedDepts = [...byDept.entries()].sort((a, b) => {
      const maxA = Math.max(...a[1].map(i => i.days_stalled || 0));
      const maxB = Math.max(...b[1].map(i => i.days_stalled || 0));
      return maxB - maxA;
    });

    const lanesList = el('div', 'sb-lanes-list');

    for (const [dept, items] of sortedDepts) {
      const lane  = el('div', 'sb-lane');
      const caret = el('span', 'sb-lane-caret', '▶');

      const header = el('div', 'sb-lane-header');
      header.append(caret, el('span', 'sb-lane-dept', dept), el('span', 'sb-lane-count', String(items.length)));

      const itemsWrap = el('div', 'sb-lane-items');
      itemsWrap.style.display = 'none';

      header.addEventListener('click', () => {
        const open = itemsWrap.style.display !== 'none';
        itemsWrap.style.display = open ? 'none' : 'block';
        caret.textContent = open ? '▶' : '▼';
      });

      for (const item of items) {
        const stale    = (item.days_stalled || 0) > 3;
        const isActive = !(item.days_stalled > 0);
        const itemId   = item.monday_item_id != null ? String(item.monday_item_id) : null;
        const inboxItem = itemId ? inboxById.get(itemId) : null;

        const row = el('div', 'sb-lane-item');
        row.append(
          el('span', 'sb-lane-item-name', item.item_name || item.text || '—'),
          el('span', `sb-lane-item-days${stale ? ' stale' : ''}`,
            item.days_stalled != null ? `${item.days_stalled}d` : ''),
          el('span', `sb-lane-item-status ${isActive ? 'active' : 'stalled'}`,
            isActive ? 'active' : 'stalled'),
        );

        const expandKey = itemId || item.text || Math.random().toString(36);

        row.addEventListener('click', () => {
          const existing = lane.querySelector(`[data-expand-id="${CSS.escape(expandKey)}"]`);
          if (existing) { existing.remove(); return; }

          const expand = el('div', 'sb-lane-item-expand');
          expand.dataset.expandId = expandKey;

          // Item name (linked to Monday)
          const nameEl = el('div', 'sb-lane-expand-name');
          if (item.monday_url) {
            const a = document.createElement('a');
            a.href = item.monday_url; a.target = '_blank'; a.rel = 'noopener';
            a.textContent = item.item_name || item.text || '—';
            nameEl.append(a);
          } else {
            nameEl.textContent = item.item_name || item.text || '—';
          }
          expand.append(nameEl);

          // Subitems count
          if (itemId) {
            const subCount = inboxItems.filter(ix => String(ix.parent_item_id) === itemId).length;
            if (subCount > 0) {
              expand.append(el('div', 'sb-lane-expand-sub',
                `${subCount} sub-item${subCount !== 1 ? 's' : ''}`));
            }
          }

          // Latest update snippet
          if (inboxItem?.latest_update) {
            const upd  = inboxItem.latest_update;
            const date = upd.created_at ? upd.created_at.slice(0, 10) : '';
            expand.append(el('div', 'sb-lane-expand-sub',
              `${upd.creator_name || ''}${date ? ' · ' + date : ''}`));
          }
          if (inboxItem?.state_label) {
            expand.append(el('div', 'sb-lane-expand-update', inboxItem.state_label));
          }

          row.after(expand);
        });

        itemsWrap.append(row);
      }

      lane.append(header, itemsWrap);
      lanesList.append(lane);
    }

    section.append(lanesList);
    return section;
  }

  function buildGroundStrip(inboxItems) {
    const section = el('div', 'sb-v2-section');
    section.append(el('span', 'sb-v2-section-label', 'On the ground'));

    const items = inboxItems
      .filter(i => i.latest_update)
      .sort((a, b) => {
        const ta = a.latest_update?.created_at || '';
        const tb = b.latest_update?.created_at || '';
        return tb.localeCompare(ta);
      })
      .slice(0, 5);

    if (!items.length) {
      section.append(el('div', 'sb-verdict-fallback', 'No recent activity.'));
      return section;
    }

    const list = el('div', 'sb-ground-list');
    for (const item of items) {
      const upd  = item.latest_update;
      const date = upd?.created_at ? upd.created_at.slice(0, 10) : '';
      const row  = el('div', 'sb-ground-row');

      const nameEl = el('div', 'sb-ground-item-name');
      if (item.url) {
        const a = document.createElement('a');
        a.href = item.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = item.item_name || '—';
        nameEl.append(a);
      } else {
        nameEl.textContent = item.item_name || '—';
      }
      row.append(nameEl);

      if (upd) {
        row.append(el('div', 'sb-ground-meta',
          `${upd.creator_name || ''}${date ? ' · ' + date : ''}`));
      }
      list.append(row);
    }
    section.append(list);
    return section;
  }

  // ── Detail v2 injection ──────────────────────────────────────────────────────

  let injectedFor = null;

  async function injectDetailV2() {
    const clientName = currentClient();
    if (!clientName) return;

    const split = document.querySelector('.client-detail-split');
    if (!split) return;

    // Synchronous guard — prevents re-entry for same client
    if (split.dataset.sbV2 === clientName) return;
    split.dataset.sbV2 = clientName;
    injectedFor = clientName;

    const slug = slugFor(clientName);
    const [pulse, md, latest, inbox] = await Promise.all([
      fetchPulse(slug),
      fetchPlaybook(slug),
      fetchLatest(),
      fetchInbox(),
    ]);

    // Validate DOM still valid after async
    if (!document.querySelector('.client-detail-split')) return;
    if (injectedFor !== clientName) return;

    const entry      = latest?.by_client?.find(c => c.client === clientName) || null;
    const clientInbox = clientInboxItems(inbox, clientName);

    document.querySelector('.sb-v2-detail')?.remove();

    const detail = el('div', 'sb-v2-detail');
    detail.append(
      buildContractHeader(md),
      buildVerdictBlock(pulse, entry),
      buildDeptLanes(entry, clientInbox),
      buildGroundStrip(clientInbox),
    );

    const app = document.getElementById('app');
    app?.classList.add('sb-v2');

    const freshSplit = document.querySelector('.client-detail-split');
    if (freshSplit) freshSplit.after(detail);
  }

  // ── MutationObserver ─────────────────────────────────────────────────────────

  function observe() {
    const app = document.getElementById('app');
    if (!app) return;

    const obs = new MutationObserver(() => {
      if (document.querySelector('.client-detail-split')) {
        injectDetailV2();
      } else {
        if (app.classList.contains('sb-v2')) {
          app.classList.remove('sb-v2');
          document.querySelector('.sb-v2-detail')?.remove();
          injectedFor = null;
        }
        ensureClientsVisible();
      }
    });

    obs.observe(app, { childList: true, subtree: true });

    if (document.querySelector('.client-detail-split')) {
      injectDetailV2();
    } else {
      ensureClientsVisible();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }
})();
