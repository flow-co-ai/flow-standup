// standup-brief.js — Standup tab v2 + v3: white cards, CEO decision surface,
// pace bar vs playbook, workstream drill-in.
//
// ONLY modifies DOM via MutationObserver — never edits app.js, style.css, index.html.

(function () {
  'use strict';

  const PULSE_BASE    = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/pulse';
  const PLAYBOOK_BASE = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/playbooks';
  const TIMELINE_BASE = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/timeline';

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

  // ── Dept normalization (mirrors build_timeline.js) ────────────────────────────

  const DEPT_LOOKUP = {};
  for (const [canon, aliases] of Object.entries({
    ads:      ['ads', 'meta ads', 'google ads', 'paid', 'paid media'],
    web:      ['web', 'web + seo', 'seo', 'website'],
    crm:      ['crm', 'ghl', 'email', 'attribution'],
    creative: ['creative', 'video', 'content'],
    ops:      ['ops', 'admin', 'reporting', 'account'],
  })) {
    for (const alias of aliases) DEPT_LOOKUP[alias.toLowerCase().trim()] = canon;
  }

  function normalizeDept(s) {
    return DEPT_LOOKUP[s?.toLowerCase().trim()] ?? 'ops';
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
  const timelineCache = new Map();
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

  async function fetchTimeline(slug) {
    if (timelineCache.has(slug)) return timelineCache.get(slug);
    try {
      const res = await fetch(`${TIMELINE_BASE}/${slug}.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) { timelineCache.set(slug, null); return null; }
      const data = await res.json();
      timelineCache.set(slug, data);
      return data;
    } catch { timelineCache.set(slug, null); return null; }
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
    // inbox.by_client is a dict keyed by client display name
    if (inbox.by_client && typeof inbox.by_client === 'object' && !Array.isArray(inbox.by_client)) {
      return inbox.by_client[clientName] || [];
    }
    if (Array.isArray(inbox.by_client)) {
      const match = inbox.by_client.find(c => c.client === clientName);
      return match?.items || [];
    }
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

  // ── Pace bar ─────────────────────────────────────────────────────────────────
  // Returns null if no timeline data — omitted entirely, no placeholder.

  function buildPaceBar(timeline) {
    if (!timeline) return null;

    const section = el('div', 'sb-v2-section');
    section.append(el('span', 'sb-v2-section-label', 'Pace'));

    const matchRatio = timeline.match_ratio ?? 0;
    if (matchRatio < 0.3) {
      section.append(el('div', 'sb-pace-low-match', 'playbook match too low to score pace'));
      return section;
    }

    const actualNum  = parseInt(timeline.actualPct, 10) || 0;
    const plannedNum = timeline.plannedPct || 0;
    const paceColor  = timeline.paceColor  || '#DCA746';
    const paceLabel  = timeline.paceLabel  || '';

    const track  = el('div', 'sb-pace-track');
    const fill   = el('div', 'sb-pace-fill');
    fill.style.width      = `${actualNum}%`;
    fill.style.background = paceColor;

    const marker = el('div', 'sb-pace-marker');
    marker.style.left = `${plannedNum}%`;

    track.append(fill, marker);

    // Pace badge color from paceLabel
    const badgeCls = paceLabel.includes('BEHIND') ? 'sb-pace-badge pace-behind'
                   : paceLabel.includes('AHEAD')  ? 'sb-pace-badge pace-ahead'
                   :                                 'sb-pace-badge pace-on';

    const labels = el('div', 'sb-pace-labels');
    labels.append(
      el('span', 'sb-pace-delivered', `${actualNum}% delivered`),
      el('span', badgeCls, paceLabel),
      el('span', 'sb-pace-planned',   `${plannedNum}% planned`),
    );

    const wrap = el('div', 'sb-pace-bar-wrap');
    wrap.append(track, labels);
    section.append(wrap);
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

  // ── Dept lanes (v3 drill-in) ──────────────────────────────────────────────────

  // Build the playbook task list for an expanded lane (when timeline data exists).
  function buildTaskDrillIn(canonDept, timeline, deptWorkItems) {
    const deptTasks  = (timeline.matched_tasks  || []).filter(t => t.dept === canonDept);
    const mondayOnly = (timeline.monday_only    || []).filter(t => t.dept === canonDept);

    if (!deptTasks.length && !mondayOnly.length) return null;

    const wrap = el('div', 'sb-task-list');

    const STATE_ICON = {
      'done':        { char: '✓', cls: 'done' },
      'in-progress': { char: '→', cls: 'in-progress' },
      'stalled':     { char: '⚠', cls: 'stalled' },
    };

    // Playbook tasks
    for (const task of deptTasks) {
      const row = el('div', task.not_on_monday ? 'sb-task-row not-on-monday' : `sb-task-row ${STATE_ICON[task.state]?.cls || 'in-progress'}`);

      const icon = el('span', 'sb-task-icon',
        task.not_on_monday ? '–' : (STATE_ICON[task.state]?.char || '→'));

      const labelEl = el('span', 'sb-task-label');
      if (!task.not_on_monday && task.monday_url) {
        const a = document.createElement('a');
        a.href = task.monday_url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = task.label;
        labelEl.append(a);
      } else {
        labelEl.textContent = task.label;
        if (task.not_on_monday) {
          const hint = el('span', 'sb-task-not-on-monday-hint', ' not found on Monday');
          labelEl.append(hint);
        }
      }

      row.append(icon, labelEl);

      if (!task.not_on_monday) {
        if (task.days_since_update != null) {
          row.append(el('span', 'sb-task-meta', `${task.days_since_update}d ago`));
        }
        if (task.subitem_count > 0) {
          row.append(el('span', 'sb-task-sub-count', `${task.subitem_count} sub`));
        }
      }

      wrap.append(row);
    }

    // Monday-only divider + items
    if (mondayOnly.length) {
      wrap.append(el('div', 'sb-monday-divider', 'on Monday, not in playbook'));

      for (const mi of mondayOnly) {
        const stale  = (mi.days_stalled || 0) > 0;
        const isCls  = stale ? 'stalled' : 'in-progress';
        const row    = el('div', `sb-task-row monday-only ${isCls}`);

        const icon   = el('span', 'sb-task-icon', stale ? '⚠' : '→');
        const nameEl = el('span', 'sb-task-label');

        if (mi.monday_url) {
          const a = document.createElement('a');
          a.href = mi.monday_url; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = mi.item_name || '—';
          nameEl.append(a);
        } else {
          nameEl.textContent = mi.item_name || '—';
        }

        row.append(icon, nameEl);

        if (mi.days_since_update != null) {
          row.append(el('span', 'sb-task-meta', `${mi.days_since_update}d ago`));
        }
        if (mi.subitem_count > 0) {
          row.append(el('span', 'sb-task-sub-count', `${mi.subitem_count} sub`));
        }

        wrap.append(row);
      }
    }

    return wrap;
  }

  function buildDeptLanes(entry, inboxItems, timeline) {
    const section = el('div', 'sb-v2-section');
    section.append(el('span', 'sb-v2-section-label', 'By department'));

    const depts = entry?.work_by_department || [];
    if (!depts.length) {
      section.append(el('div', 'sb-verdict-fallback', 'No department data.'));
      return section;
    }

    // Build inbox lookup: monday_item_id → item
    const inboxById = new Map();
    for (const ix of inboxItems) {
      if (ix.monday_item_id != null) inboxById.set(String(ix.monday_item_id), ix);
    }
    const subCounts = new Map();
    for (const ix of inboxItems) {
      const pid = String(ix.parent_item_id || '');
      if (pid) subCounts.set(pid, (subCounts.get(pid) || 0) + 1);
    }

    // Group by department
    const byDept = new Map();
    for (const item of depts) {
      const dept = item.department || 'Other';
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept).push(item);
    }

    // Flatten items from each dept object (highlights + stalled_items)
    const deptMap = new Map(); // dept name → flat item list
    for (const d of depts) {
      const dept = d.department || 'Other';
      if (!deptMap.has(dept)) deptMap.set(dept, []);
      deptMap.get(dept).push(...(d.highlights || []), ...(d.stalled_items || []));
    }

    // Sort items within each lane stalest first; sort lanes by max days_stalled
    for (const items of deptMap.values()) {
      items.sort((a, b) => (b.days_stalled || 0) - (a.days_stalled || 0));
    }
    const sortedDepts = [...deptMap.entries()].sort((a, b) => {
      const maxA = Math.max(...a[1].map(i => i.days_stalled || 0), 0);
      const maxB = Math.max(...b[1].map(i => i.days_stalled || 0), 0);
      return maxB - maxA;
    });

    const lanesList = el('div', 'sb-lanes-list');
    const hasTimeline = !!(timeline?.matched_tasks);

    for (const [dept, items] of sortedDepts) {
      const lane  = el('div', 'sb-lane');
      const caret = el('span', 'sb-lane-caret', '▶');

      // Count: playbook tasks if timeline, else raw items
      const canonDept  = normalizeDept(dept);
      const taskCount  = hasTimeline
        ? (timeline.matched_tasks.filter(t => t.dept === canonDept).length +
           (timeline.monday_only || []).filter(t => t.dept === canonDept).length)
        : items.length;

      const header = el('div', 'sb-lane-header');
      header.append(
        caret,
        el('span', 'sb-lane-dept', dept),
        el('span', 'sb-lane-count', String(taskCount || items.length)),
      );

      const itemsWrap = el('div', 'sb-lane-items');
      itemsWrap.style.display = 'none';

      header.addEventListener('click', () => {
        const open = itemsWrap.style.display !== 'none';
        itemsWrap.style.display = open ? 'none' : 'block';
        caret.textContent = open ? '▶' : '▼';
      });

      if (hasTimeline) {
        // Stage 2: playbook task drill-in
        const drillIn = buildTaskDrillIn(canonDept, timeline, items);
        if (drillIn) itemsWrap.append(drillIn);

        // Next-move line: stalest stalled item for this dept
        const stalledItem = items.find(i => (i.days_stalled || 0) > 0);
        if (stalledItem) {
          const nm = el('div', 'sb-lane-next-move',
            `▸ ${stalledItem.item_name || stalledItem.text || ''}`);
          itemsWrap.append(nm);
        }
      } else {
        // Fallback: raw work item rows (existing behavior)
        for (const item of items) {
          const stale    = (item.days_stalled || 0) > 3;
          const isActive = !(item.days_stalled > 0);
          const itemId   = item.monday_item_id != null
            ? String(item.monday_item_id).replace(/\[id:\s*(\d+)\]/, '$1')
            : null;
          const inboxItem = itemId ? inboxById.get(itemId) : null;

          const row = el('div', 'sb-lane-item');
          row.append(
            el('span', 'sb-lane-item-name', item.item_name || item.text || '—'),
            el('span', `sb-lane-item-days${stale ? ' stale' : ''}`,
              item.days_stalled != null ? `${item.days_stalled}d` : ''),
            el('span', `sb-lane-item-status ${isActive ? 'active' : 'stalled'}`,
              isActive ? 'active' : 'stalled'),
          );

          const expandKey = itemId || item.text || String(Math.random());
          row.addEventListener('click', () => {
            const existing = lane.querySelector(`[data-expand-id="${CSS.escape(expandKey)}"]`);
            if (existing) { existing.remove(); return; }

            const expand = el('div', 'sb-lane-item-expand');
            expand.dataset.expandId = expandKey;

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

            if (itemId) {
              const subCount = subCounts.get(itemId) || 0;
              if (subCount > 0) {
                expand.append(el('div', 'sb-lane-expand-sub',
                  `${subCount} sub-item${subCount !== 1 ? 's' : ''}`));
              }
            }

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

    if (split.dataset.sbV2 === clientName) return;
    split.dataset.sbV2 = clientName;
    injectedFor = clientName;

    const slug = slugFor(clientName);

    const [pulse, md, latest, inbox, timeline] = await Promise.all([
      fetchPulse(slug),
      fetchPlaybook(slug),
      fetchLatest(),
      fetchInbox(),
      fetchTimeline(slug),
    ]);

    if (!document.querySelector('.client-detail-split')) return;
    if (injectedFor !== clientName) return;

    const entry       = latest?.by_client?.find(c => c.client === clientName) || null;
    const clientInbox = clientInboxItems(inbox, clientName);

    document.querySelector('.sb-v2-detail')?.remove();

    const detail   = el('div', 'sb-v2-detail');
    const paceBar  = buildPaceBar(timeline);

    detail.append(buildContractHeader(md));
    if (paceBar) detail.append(paceBar);
    detail.append(
      buildVerdictBlock(pulse, entry),
      buildDeptLanes(entry, clientInbox, timeline),
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
