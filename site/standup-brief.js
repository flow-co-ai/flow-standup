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
    if (v3State.mounted) return;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // V3 — full-surface Standup rebuild (grid + rail).
  //
  // v3 owns the Standup home grid; v2 continues to own per-client drill-in
  // (.client-detail-split). Everything below is namespaced sb3-.
  // ═══════════════════════════════════════════════════════════════════════════

  const SUMMARY_URL = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/standups/standup-summary.json';

  // Monday board id → stream lane, mirrors config.json boards.
  const BOARD_LANE = {
    '18418241405': 'CRM',
    '18405754310': 'ADS',
    '18100257069': 'VIDEO',
    '18099807701': 'WEB-SEO',
  };

  // Lane definitions with the dept-name aliases used in latest.json.
  const STREAM_LANES = [
    { key: 'CRM',     aliases: ['crm', 'ghl', 'email', 'attribution'] },
    { key: 'ADS',     aliases: ['ads', 'meta ads', 'google ads', 'paid', 'paid media'] },
    { key: 'VIDEO',   aliases: ['video', 'creative', 'content'] },
    { key: 'WEB-SEO', aliases: ['web + seo', 'web', 'seo', 'website'] },
  ];

  const STATUS_MAP = {
    green:  { label: 'ON TRACK',        color: '#7da05c' },
    amber:  { label: 'NEEDS ATTENTION', color: '#c9a13b' },
    orange: { label: 'AT RISK',         color: '#a8563f' },
    red:    { label: 'AT RISK',         color: '#a8563f' },
  };
  const STATUS_UNKNOWN = { label: 'NO DATA', color: '#9ea295' };

  // Card sort rank: at-risk < needs-attention < on-track < unknown.
  const STATUS_RANK = { orange: 0, red: 0, amber: 1, green: 2 };

  // ── v3 state ─────────────────────────────────────────────────────────────────

  const v3State = {
    mounted:  false,
    filter:   null,   // slug or null
    openCard: null,   // slug or null
  };

  const v3Data = {
    loaded:  false,
    entries: [],      // [{ slug, name, pulse, timeline, latestEntry }]
    summary: null,
  };

  let summaryCache = null;

  // ── v3 helpers ───────────────────────────────────────────────────────────────

  function statusFor(pulse) {
    if (!pulse) return STATUS_UNKNOWN;
    return STATUS_MAP[pulse.status] || STATUS_UNKNOWN;
  }

  function briefV2Of(pulse) {
    return pulse?.brief_v2 || pulse?.brief?.brief_v2 || null;
  }

  function blocksFor(pulse) {
    return briefV2Of(pulse)?.blocks || [];
  }

  function moveLine(blocks) {
    const c = { you: 0, team: 0, client: 0 };
    for (const b of blocks) if (c[b.side] !== undefined) c[b.side]++;
    const total = c.you + c.team + c.client;
    if (!total) return 'Nothing open';
    const parts = [];
    if (c.you)    parts.push(`You ${c.you}`);
    if (c.team)   parts.push(`Team ${c.team}`);
    if (c.client) parts.push(`Client ${c.client}`);
    return parts.join(' · ');
  }

  function sortEntries(entries) {
    return [...entries].sort((a, b) => {
      const ra = STATUS_RANK[a.pulse?.status] ?? 3;
      const rb = STATUS_RANK[b.pulse?.status] ?? 3;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }

  function laneFromUrl(url) {
    const m = (url || '').match(/boards\/(\d+)/);
    return m ? BOARD_LANE[m[1]] : null;
  }

  function findLaneDept(latestEntry, aliases) {
    const depts = latestEntry?.work_by_department || [];
    return depts.find(d => {
      const n = (d.department || '').toLowerCase().trim();
      return aliases.some(a => n === a || n.includes(a) || a.includes(n));
    });
  }

  function todayDateLine(clientCount, blocksCount) {
    const opts = { weekday: 'long', month: 'long', day: 'numeric' };
    const s = new Date().toLocaleDateString('en-US', opts).toUpperCase();
    return `${s} · ${clientCount} CLIENTS · ${blocksCount} BLOCKS OPEN`;
  }

  // ── v3 fetchers ──────────────────────────────────────────────────────────────

  async function fetchSummary() {
    if (summaryCache) return summaryCache;
    try {
      const res = await fetch(`${SUMMARY_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      summaryCache = await res.json();
      return summaryCache;
    } catch { return null; }
  }

  async function loadV3Data() {
    const latest = await fetchLatest();
    v3Data.summary = await fetchSummary();

    const clients = (latest?.by_client || []).filter(c => c.client && c.client !== 'Unmapped');

    const entries = await Promise.all(clients.map(async (c) => {
      const slug = slugFor(c.client);
      const [pulse, timeline] = await Promise.all([
        fetchPulse(slug),
        fetchTimeline(slug),
      ]);
      return { slug, name: c.client, pulse, timeline, latestEntry: c };
    }));

    v3Data.entries = entries;
    v3Data.loaded  = true;
  }

  // ── v3 renderers: header + pills + grid ─────────────────────────────────────

  function renderHeader(summary, entries) {
    const header = el('div', 'sb3-header');
    const totalBlocks = entries.reduce((s, e) => s + blocksFor(e.pulse).length, 0);
    header.append(el('div', 'sb3-date-line', todayDateLine(entries.length, totalBlocks)));
    if (summary?.hero) {
      header.append(el('div', 'sb3-hero', summary.hero));
      if (summary.subline) header.append(el('div', 'sb3-subline', summary.subline));
    }
    return header;
  }

  function renderPills(entries) {
    const pills = el('div', 'sb3-pills');

    const allPill = el('button',
      `sb3-pill${!v3State.filter ? ' active' : ''}`,
      `All ${entries.length} clients`);
    allPill.addEventListener('click', () => {
      v3State.filter = null;
      v3State.openCard = null;
      renderRoot();
    });
    pills.append(allPill);

    for (const e of entries) {
      const status = statusFor(e.pulse);
      const pill = el('button', `sb3-pill${v3State.filter === e.slug ? ' active' : ''}`);
      const dot = el('span', 'sb3-pill-dot');
      dot.style.background = status.color;
      pill.append(dot, document.createTextNode(e.name));
      pill.addEventListener('click', () => {
        v3State.filter = v3State.filter === e.slug ? null : e.slug;
        v3State.openCard = null;
        renderRoot();
      });
      pills.append(pill);
    }
    return pills;
  }

  function renderGrid(entries) {
    const visible = v3State.filter
      ? entries.filter(e => e.slug === v3State.filter)
      : entries;
    const sorted = sortEntries(visible);
    const grid = el('div', 'sb3-grid');
    for (const e of sorted) grid.append(renderCardV3(e));
    return grid;
  }

  // ── v3 renderers: card ───────────────────────────────────────────────────────

  function renderCardV3(entry) {
    const { name, slug, pulse } = entry;
    const status = statusFor(pulse);
    const v2  = briefV2Of(pulse);
    const isOpen = v3State.openCard === slug;

    const card = el('div', `sb3-card${isOpen ? ' open' : ''}`);

    // Top row: dot + state label / ops score
    const top = el('div', 'sb3-card-top');
    const statusWrap = el('span', 'sb3-card-status');
    const dot = el('span', 'sb3-dot');
    dot.style.background = status.color;
    statusWrap.append(dot, el('span', 'sb3-state-label', status.label));

    const scoreEl = el('span', 'sb3-card-score', pulse?.score != null ? String(pulse.score) : '—');
    if (pulse?.score != null) scoreEl.style.color = status.color;

    top.append(statusWrap, scoreEl);
    card.append(top);

    // Name + sub
    card.append(el('div', 'sb3-card-name', name));
    if (pulse?.type) card.append(el('div', 'sb3-card-sub', pulse.type));

    // Verdict
    const verdict = v2?.verdict;
    card.append(el('div', verdict ? 'sb3-card-verdict' : 'sb3-card-verdict muted',
      verdict || 'No brief generated yet'));

    // Footer: move line + toggle
    const footer = el('div', 'sb3-card-footer');
    footer.append(el('span', 'sb3-move-line', moveLine(blocksFor(pulse))));
    const toggle = el('button', 'sb3-toggle', isOpen ? 'Close' : 'Open');
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      v3State.openCard = isOpen ? null : slug;
      renderRoot();
    });
    footer.append(toggle);
    card.append(footer);

    // Detail
    if (isOpen) card.append(renderCardDetailV3(entry));

    return card;
  }

  // ── v3 renderers: card detail (snapshot / streams / contract / history) ─────

  function renderCardDetailV3(entry) {
    const { pulse, latestEntry, timeline } = entry;
    const v2 = briefV2Of(pulse);

    const detail = el('div', 'sb3-detail');

    // SNAPSHOT — render only if source array has rows
    const snap = v2?.snapshot || [];
    if (snap.length) detail.append(renderSnapshotSection(snap));

    // STREAMS — always render section; individual lanes fall back to "Not in scope."
    detail.append(renderStreamsSection(latestEntry));

    // AGAINST THE CONTRACT
    detail.append(renderContractSection(timeline));

    // history_line footer (spans full detail row)
    const hl = v2?.history_line;
    if (hl) detail.append(el('div', 'sb3-detail-history', hl));

    return detail;
  }

  function renderSnapshotSection(rows) {
    const sec = el('div', 'sb3-section');
    sec.append(el('div', 'sb3-section-label', 'SNAPSHOT'));
    const body = el('div', 'sb3-section-body');
    for (const r of rows) {
      const row = el('div', 'sb3-snap-row');
      row.append(el('div', 'sb3-snap-label', r.label || ''));
      row.append(el('div', `sb3-snap-value tone-${r.tone || 'plain'}`, r.value || ''));
      body.append(row);
    }
    sec.append(body);
    return sec;
  }

  function renderStreamsSection(latestEntry) {
    const sec = el('div', 'sb3-section');
    sec.append(el('div', 'sb3-section-label', 'STREAMS'));
    const body = el('div', 'sb3-section-body');

    const completed = latestEntry?.completed_this_week || [];

    for (const lane of STREAM_LANES) {
      const dept       = findLaneDept(latestEntry, lane.aliases);
      const highlights = dept?.highlights || [];
      const stalled    = dept?.stalled_items || [];
      const active     = (highlights.length + stalled.length) > 0;
      const shipped    = completed.some(c => laneFromUrl(c.monday_url) === lane.key);
      const clean      = active && stalled.length === 0;

      const laneRow = el('div', 'sb3-lane');
      laneRow.append(el('span', 'sb3-lane-name', lane.key));

      const dots = el('span', 'sb3-lane-dots');
      const dotStates = [
        { on: active,  stalled: !!(stalled.length && !highlights.length) },
        { on: highlights.length > 0 },
        { on: shipped },
        { on: clean },
      ];
      for (const s of dotStates) {
        const d = el('span', `sb3-lane-dot${s.on ? ' on' : ''}${s.stalled ? ' stalled' : ''}`);
        dots.append(d);
      }
      laneRow.append(dots);

      // Note: stalest stalled item + days, else first highlight, else Not in scope.
      let note = '', muted = false;
      if (stalled.length) {
        const s = [...stalled].sort((a, b) => (b.days_stalled || 0) - (a.days_stalled || 0))[0];
        note = `${s.item_name || s.text || ''} · ${s.days_stalled || 0}d`;
      } else if (highlights.length) {
        const h = highlights[0];
        note = h.item_name || h.text || '';
      } else if (!dept) {
        note = 'Not in scope.';
        muted = true;
      }
      laneRow.append(el('span', `sb3-lane-note${muted ? ' muted' : ''}`, note));
      body.append(laneRow);
    }
    sec.append(body);
    return sec;
  }

  function renderContractSection(timeline) {
    const sec = el('div', 'sb3-section');
    sec.append(el('div', 'sb3-section-label', 'AGAINST THE CONTRACT'));
    const body = el('div', 'sb3-section-body');

    if (!timeline) {
      body.append(el('div', 'sb3-contract-empty',
        'No playbook on file for this client, so there is nothing to measure delivery against.'));
      sec.append(body);
      return sec;
    }

    const tasks = timeline.matched_tasks || [];
    if (!tasks.length) {
      body.append(el('div', 'sb3-contract-empty', 'No tasks found.'));
      sec.append(body);
      return sec;
    }

    // Rank order: stalled → in-progress → done → gap
    const rank = (t) => {
      if (t.not_on_monday) return 3;
      if (t.state === 'stalled')     return 0;
      if (t.state === 'in-progress') return 1;
      if (t.state === 'done')        return 2;
      return 4;
    };
    const sorted = [...tasks].sort((a, b) => rank(a) - rank(b));
    const CAP = 12;
    const visible = sorted.slice(0, CAP);

    for (const t of visible) {
      const row = el('div', 'sb3-contract-row');
      if (t.not_on_monday) {
        row.append(el('span', 'sb3-contract-dot gap'));
        row.append(el('span', 'sb3-contract-label', t.label));
        row.append(el('span', 'sb3-contract-tag', 'no task exists'));
      } else if (t.state === 'done') {
        row.append(el('span', 'sb3-contract-dot done', ''));
        row.append(el('span', 'sb3-contract-label done', t.label));
      } else if (t.state === 'stalled') {
        row.append(el('span', 'sb3-contract-dot stalled'));
        row.append(el('span', 'sb3-contract-label', t.label));
        row.append(el('span', 'sb3-contract-days', `${t.days_stalled || 0}d stalled`));
      } else {
        row.append(el('span', 'sb3-contract-dot live'));
        row.append(el('span', 'sb3-contract-label', t.label));
      }
      body.append(row);
    }
    if (sorted.length > CAP) {
      body.append(el('div', 'sb3-contract-more', `${sorted.length - CAP} more`));
    }
    sec.append(body);
    return sec;
  }

  // ── v3 renderers: rail + footnotes ──────────────────────────────────────────

  function railScope() {
    // openCard wins over filter (last user click owns the scope).
    return v3State.openCard || v3State.filter || null;
  }

  function renderRail(entries) {
    const rail = el('div', 'sb3-rail');

    const scopedSlug = railScope();
    const scoped = scopedSlug ? entries.find(e => e.slug === scopedSlug) : null;
    const source = scoped ? [scoped] : entries;

    const allBlocks = [];
    for (const e of source) {
      for (const b of blocksFor(e.pulse)) allBlocks.push({ ...b, client: e.name });
    }

    const header = el('div', 'sb3-rail-header');
    header.append(
      el('span', 'sb3-rail-title', scoped ? `BLOCKS · ${scoped.name.toUpperCase()}` : 'BLOCKS'),
      el('span', 'sb3-rail-count', `${allBlocks.length} OPEN`),
    );
    rail.append(header);

    const groups = [
      { key: 'you',    label: 'Yours to clear',       accent: '#c9a13b' },
      { key: 'team',   label: 'Your team',            accent: '#a8563f' },
      { key: 'client', label: 'Sitting with clients', accent: '#c3cbb4' },
    ];

    for (const g of groups) {
      const rows = allBlocks
        .filter(b => b.side === g.key)
        .sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (b.age_days || 0) - (a.age_days || 0));
      if (!rows.length) continue;

      const group = el('div', 'sb3-block-group');
      group.style.setProperty('--sb3-group-accent', g.accent);
      group.append(el('div', 'sb3-group-label', g.label));

      for (const r of rows) {
        const row = el('div', 'sb3-block-row');
        row.append(el('div', 'sb3-block-client', r.client));
        row.append(el('div', 'sb3-block-item', r.item || ''));
        const meta = el('div', 'sb3-block-meta');
        meta.append(
          el('span', 'sb3-block-who', r.who || ''),
          el('span', `sb3-block-age${r.hot ? ' hot' : ''}`, `${r.age_days || 0}d`),
        );
        row.append(meta);
        group.append(row);
      }
      rail.append(group);
    }

    rail.append(renderFootnote(entries));
    return rail;
  }

  function renderFootnote(entries) {
    const foot = el('div', 'sb3-footnote');
    foot.append(el('div', null, 'Ops score = task movement, reply latency and playbook coverage.'));
    const missing = entries.filter(e => !e.timeline).length;
    if (missing > 0) {
      const word = missing === 1 ? 'client has' : 'clients have';
      foot.append(el('div', null, `${missing} ${word} no playbook on file.`));
    }
    return foot;
  }

  // ── v3 mount + root render ──────────────────────────────────────────────────

  function renderRoot() {
    const root = document.querySelector('.sb3-root');
    if (!root) return;
    root.innerHTML = '';

    const layout = el('div', 'sb3-layout');
    const main   = el('div', 'sb3-main');

    main.append(renderHeader(v3Data.summary, v3Data.entries));
    main.append(renderPills(v3Data.entries));
    main.append(renderGrid(v3Data.entries));

    layout.append(main, renderRail(v3Data.entries));
    root.append(layout);
  }

  async function mountV3() {
    const app = document.getElementById('app');
    if (!app) return;

    document.body.classList.add('sb3-active');

    let root = app.querySelector('.sb3-root');
    if (!root) {
      root = document.createElement('div');
      root.className = 'sb3-root';
      app.append(root);
    }
    v3State.mounted = true;

    if (!v3Data.loaded) {
      await loadV3Data();
      // Guard: user may have navigated away while we were fetching.
      if (!v3State.mounted) return;
      if (!document.querySelector('.sb3-root')) return;
    }
    renderRoot();
  }

  function unmountV3() {
    if (!v3State.mounted) return;
    document.body.classList.remove('sb3-active');
    document.querySelector('.sb3-root')?.remove();
    v3State.mounted = false;
  }

  // ── MutationObserver ─────────────────────────────────────────────────────────

  function observe() {
    const app = document.getElementById('app');
    if (!app) return;

    const tick = () => {
      // Per-client drill-in: v2 owns this.
      if (document.querySelector('.client-detail-split')) {
        unmountV3();
        injectDetailV2();
        return;
      }
      // Grid home: v3 owns this.
      if (app.classList.contains('client-grid-page')) {
        if (app.classList.contains('sb-v2')) {
          app.classList.remove('sb-v2');
          document.querySelector('.sb-v2-detail')?.remove();
          injectedFor = null;
        }
        mountV3();
        return;
      }
      // Any other view (single-column detail, prospect, etc): neither v2 nor v3.
      unmountV3();
      if (app.classList.contains('sb-v2')) {
        app.classList.remove('sb-v2');
        document.querySelector('.sb-v2-detail')?.remove();
        injectedFor = null;
      }
      ensureClientsVisible();
    };

    const obs = new MutationObserver(tick);
    obs.observe(app, { childList: true, subtree: true });
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }
})();
