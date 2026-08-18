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

  // Four clients keep their playbooks under playbooks/_unmatched/ with a
  // different filename convention. Try the canonical path first, fall back to
  // the alias. Only both 404 counts as "No playbook on file."
  const PLAYBOOK_ALIASES = {
    'medstation':        '_unmatched/medstation-department-playbooks',
    'jcl':               '_unmatched/jcl-department-playbooks',
    'maadi-law':         '_unmatched/maadi-law-department-playbooks',
    'steel-round-bars':  '_unmatched/steel-group-department-playbooks',
  };

  async function fetchPlaybook(slug) {
    if (playbookCache.has(slug)) return playbookCache.get(slug);
    const paths = [`${slug}.md`];
    if (PLAYBOOK_ALIASES[slug]) paths.push(`${PLAYBOOK_ALIASES[slug]}.md`);
    for (const rel of paths) {
      try {
        const res = await fetch(`${PLAYBOOK_BASE}/${rel}?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          playbookCache.set(slug, text);
          return text;
        }
      } catch { /* try next path */ }
    }
    playbookCache.set(slug, null);
    return null;
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
    // Unified single-slug selection: card click and pill click both set this.
    // null = all-clients grid view, slug = solo view (that client, expanded).
    selected: null,
  };

  const v3Data = {
    loaded:  false,
    entries: [],      // [{ slug, name, pulse, timeline, playbook, latestEntry }]
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
      const [pulse, timeline, playbook] = await Promise.all([
        fetchPulse(slug),
        fetchTimeline(slug),
        fetchPlaybook(slug),
      ]);
      return { slug, name: c.client, pulse, timeline, playbook, latestEntry: c };
    }));

    v3Data.entries = entries;
    v3Data.loaded  = true;
  }

  // ── v3 renderers: header + pills + grid ─────────────────────────────────────

  // Header:
  //   All-clients view: date line + subline (block counts). NO hero — headlines
  //   are per-client and live on the selected card.
  //   Solo view: date line + the client's own brief_v2.verdict as the hero.
  function renderHeader(summary, entries, selectedEntry) {
    const header = el('div', 'sb3-header');
    const totalBlocks = entries.reduce((s, e) => s + blocksFor(e.pulse).length, 0);
    header.append(el('div', 'sb3-date-line', todayDateLine(entries.length, totalBlocks)));

    if (selectedEntry) {
      const verdict = briefV2Of(selectedEntry.pulse)?.verdict;
      if (verdict) header.append(el('div', 'sb3-hero', verdict));
      // No verdict: skip. Do not fabricate.
    } else if (summary?.subline) {
      header.append(el('div', 'sb3-subline', summary.subline));
    }
    return header;
  }

  // Pills in all-view; "← All clients" back control in solo view. Same
  // `v3State.selected` state — pill click and card click are the same action.
  function renderPillsOrBack(entries) {
    if (v3State.selected) {
      const back = el('button', 'sb3-back', '← All clients');
      back.addEventListener('click', () => {
        v3State.selected = null;
        renderRoot();
      });
      return back;
    }

    const pills = el('div', 'sb3-pills');
    const allPill = el('button', 'sb3-pill active', `All ${entries.length} clients`);
    allPill.addEventListener('click', () => { /* no-op; already all */ });
    pills.append(allPill);

    for (const e of entries) {
      const status = statusFor(e.pulse);
      const pill = el('button', 'sb3-pill');
      const dot = el('span', 'sb3-pill-dot');
      dot.style.background = status.color;
      pill.append(dot, document.createTextNode(e.name));
      pill.addEventListener('click', () => {
        v3State.selected = e.slug;
        renderRoot();
      });
      pills.append(pill);
    }
    return pills;
  }

  function renderGrid(entries) {
    const visible = v3State.selected
      ? entries.filter(e => e.slug === v3State.selected)
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
    const isOpen = v3State.selected === slug;

    const card = el('div', `sb3-card${isOpen ? ' open' : ' clickable'}`);
    if (!isOpen) {
      card.addEventListener('click', () => {
        v3State.selected = slug;
        renderRoot();
      });
    }

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

    // Verdict — hidden on open (the hero shows it) to avoid duplication.
    if (!isOpen) {
      const verdict = v2?.verdict;
      card.append(el('div', verdict ? 'sb3-card-verdict' : 'sb3-card-verdict muted',
        verdict || 'No brief generated yet'));
    }

    // Footer: move line only. Card click drives selection; no toggle button.
    const footer = el('div', 'sb3-card-footer');
    footer.append(el('span', 'sb3-move-line', moveLine(blocksFor(pulse))));
    card.append(footer);

    // Detail
    if (isOpen) card.append(renderCardDetailV3(entry));

    return card;
  }

  // ── v3 renderers: card detail (snapshot / streams / contract / history) ─────

  function renderCardDetailV3(entry) {
    const { pulse, latestEntry, timeline, playbook } = entry;
    const v2 = briefV2Of(pulse);

    const detail = el('div', 'sb3-detail');

    // CONTRACT — deterministic, from the playbook header. Anchor section.
    detail.append(renderContractFromPlaybook(playbook));

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

  // ── Playbook extractor (v3 CONTRACT section — deterministic, no LLM) ────────
  // parsePlaybookHeader() is v2 territory; it dumps whole paragraphs. The v3
  // path builds at most four short rows, everything markdown-stripped and
  // word-capped. Anything not confidently findable is omitted.

  const MD_MONTHS_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const MD_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MD_MONTH_INDEX = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };

  function stripMarkdown(s) {
    return String(s || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/[*_`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function capWords(s, n) {
    const clean = stripMarkdown(s);
    if (!clean) return '';
    const words = clean.split(/\s+/);
    if (words.length <= n) return words.join(' ');
    return words.slice(0, n).join(' ') + '…';
  }

  function monthIdxFromName(name) {
    const key = name.toLowerCase().slice(0, 4).replace(/[^a-z]/g, '');
    if (key.length >= 3 && MD_MONTH_INDEX[key.slice(0,3)] != null) return MD_MONTH_INDEX[key.slice(0,3)];
    if (MD_MONTH_INDEX[key]) return MD_MONTH_INDEX[key];
    return null;
  }

  // Bare month-day (no year) never resolves to a future date — most recent
  // past occurrence only. "Oct 1" on 2026-08-18 → Oct 1 2025.
  function parseHumanDate(str) {
    const s = str.trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-\d{1,2}/);
    if (m) return { month: parseInt(m[2],10) - 1, year: parseInt(m[1],10) };
    m = s.match(new RegExp(`^(${MD_MONTHS_RE})\\.?\\s+\\d{1,2}(?:,)?\\s+(\\d{4})`, 'i'));
    if (m) { const mi = monthIdxFromName(m[1]); if (mi != null) return { month: mi, year: parseInt(m[2],10) }; }
    m = s.match(new RegExp(`^(${MD_MONTHS_RE})\\.?\\s+(\\d{4})`, 'i'));
    if (m) { const mi = monthIdxFromName(m[1]); if (mi != null) return { month: mi, year: parseInt(m[2],10) }; }
    m = s.match(new RegExp(`^(${MD_MONTHS_RE})\\.?\\s+(\\d{1,2})\\b`, 'i'));
    if (m) {
      const mi = monthIdxFromName(m[1]);
      if (mi == null) return null;
      const now = new Date();
      let year = now.getUTCFullYear();
      const day = parseInt(m[2],10);
      const candidate = new Date(Date.UTC(year, mi, day));
      if (candidate > now) year -= 1;
      return { month: mi, year };
    }
    return null;
  }

  function formatStartedText(parsed) {
    return `${MD_MONTH_NAMES[parsed.month]} ${parsed.year}`;
  }

  const START_KEY_RE = /(original agreement|renewal(?:\s+start(?:s|ed)?)?|onboard(?:ed|ing)?|kick[-\s]?off|kickoff|commenced|retainer|start(?:s|ed)?\b)/i;

  // Split a stripped line on `. ` followed by a capital letter — sentence
  // boundaries only, not abbreviations ("Sept. 1") or emoji-led fragments.
  function splitClauses(line) {
    return line.split(/(?<=\.)\s+(?=[A-Z])/);
  }

  // Returns { parsed, clause } — clause is the sentence carrying the start
  // keyword, so length lookup can be scoped to it and won't stray to
  // unrelated "3 months" text elsewhere in the same paragraph.
  function extractStartedInfo(md) {
    for (const raw of md.split('\n')) {
      const line = stripMarkdown(raw);
      if (!START_KEY_RE.test(line)) continue;
      for (const clause of splitClauses(line)) {
        if (!START_KEY_RE.test(clause)) continue;
        const patterns = [
          new RegExp(`(${MD_MONTHS_RE})\\.?\\s+\\d{1,2}(?:,)?\\s+\\d{4}`, 'i'),
          /\d{4}-\d{2}-\d{2}/,
          new RegExp(`(${MD_MONTHS_RE})\\.?\\s+\\d{4}`, 'i'),
          new RegExp(`(${MD_MONTHS_RE})\\.?\\s+\\d{1,2}\\b`, 'i'),
        ];
        for (const re of patterns) {
          const m = clause.match(re);
          if (m) {
            const parsed = parseHumanDate(m[0]);
            if (parsed) return { parsed, clause };
          }
        }
      }
    }
    return null;
  }

  function extractLengthFromClause(clause) {
    const m = clause.match(/\b(\d{1,2})[-\s]months?\b/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function computeCurrentMonthNumber(started) {
    const now = new Date();
    return Math.max(1,
      (now.getUTCFullYear() - started.year) * 12 +
      (now.getUTCMonth() - started.month) + 1
    );
  }

  // Playbook can state the current month explicitly ("Month 10 now") — that
  // beats the computed value.
  function extractStatedMonth(md) {
    const m = stripMarkdown(md).match(/\bmonth\s+(\d{1,2})\s+now\b/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function detectMonthToMonth(md) {
    return /month[-\s]to[-\s]month/i.test(md);
  }

  // Scope selection — item-count capped (max 5), joined with " · ", never
  // truncated mid-word. Preference:
  //   (1) engagement "Scope: A + B + …" line with 4+ items,
  //   (2) h1 (excl title) when h1 >= 3 and h1 >= h2 (billy-doe shape),
  //   (3) 2+ filtered h2 (most files),
  //   (4) any h1 fallback,
  //   (5) "Scope:" line with any items as last resort.
  // Structural containers (ADMIN & COORDINATION, EXECUTION DEPARTMENTS,
  // Launch Gate, Access, Account, Ops, …) are treated as scaffolding.
  const SCOPE_BAD = /^(where|what|out\s+of\s+scope|compliance|scope\s+cuts?|about|architecture|the\s+dashboard|if\s+renewed|sequence\s+at\s+a\s+glance|client\s+to-?do|account\b|ops\b|access\b|launch\s+gate|admin\s*(?:&|and)\s*coordination|execution\s+departments|needs\b|done\b)/i;

  function scopeLineItems(md) {
    for (const raw of md.split('\n')) {
      const clean = stripMarkdown(raw);
      const m = clean.match(/scope:\s*(.+)/i);
      if (!m) continue;
      const listRaw = m[1].split(/\s+—\s+|\.\s+|;\s+/)[0];
      const items = listRaw
        .split(/\s+·\s+|\s+\+\s+|,\s+/)
        .map(s => s.trim())
        .filter(Boolean);
      if (items.length) return items;
    }
    return null;
  }

  function extractScopeItems(md) {
    const lines = md.split('\n');

    const scopeItems = scopeLineItems(md);
    if (scopeItems && scopeItems.length >= 4) return scopeItems.slice(0, 5);

    const h1s = [];
    let sawTitle = false;
    for (const raw of lines) {
      if (!/^#\s+/.test(raw)) continue;
      if (!sawTitle) { sawTitle = true; continue; }
      h1s.push(stripMarkdown(raw).replace(/^#+\s*/, ''));
    }
    const h1sFiltered = h1s.filter(h => !SCOPE_BAD.test(h));
    const h2s = lines
      .filter(l => /^##\s+/.test(l))
      .map(l => stripMarkdown(l).replace(/^#+\s*/, ''))
      .filter(h => !SCOPE_BAD.test(h));

    let picked = null;
    if (h1sFiltered.length >= 3 && h1sFiltered.length >= h2s.length) picked = h1sFiltered;
    else if (h2s.length >= 2)                                        picked = h2s;
    else if (h1sFiltered.length >= 1)                                picked = h1sFiltered;

    if (picked && picked.length) {
      const cleaned = picked
        .map(h => h.split(/\s*—\s*/)[0].trim())
        .filter(Boolean);
      return [...new Set(cleaned)].slice(0, 5);
    }

    if (scopeItems && scopeItems.length) return scopeItems.slice(0, 5);
    return [];
  }

  // Strip the metric-intro prefix ("Measured on", "Internally benchmarked
  // on", "Judged on"), cut at em dash, cap at 12 words. 3-word minimum with
  // hyphens counted as word breaks so hyphenated metrics
  // ("cost-per-signed-case") aren't rejected as "one word".
  function extractJudgedOn(md) {
    const KW = /\b(measured|judged|scoreboard|scorecard|success|prove-?it|kpi|internally\s+benchmarked)\b/i;
    const INTRO_RE = /\b(?:measured\s+on|internally\s+benchmarked\s+on|judged\s+on|scored\s+on)\s+/i;
    const clean = stripMarkdown(md.replace(/```[\s\S]*?```/g, ''));
    const sentences = clean.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (!KW.test(s)) continue;
      const letters = s.replace(/[^A-Za-z]/g, '');
      if (letters.length > 0 && letters === letters.toUpperCase()) continue;
      if (s.split(/\s+/).length < 6) continue;
      const introMatch = s.match(INTRO_RE);
      const remainder  = introMatch
        ? s.slice(introMatch.index + introMatch[0].length)
        : s;
      const beforeDash = remainder.split(/\s*—\s*|\s+--\s+/)[0];
      const capped     = capWords(beforeDash, 12);
      if (!capped) continue;
      const wordCount = capped.replace(/-/g, ' ').split(/\s+/).filter(Boolean).length;
      if (wordCount < 3) continue;
      return capped;
    }
    return null;
  }

  // Returns at most 4 rows: Started / Month / Scope / Judged on. Omits any
  // row whose source isn't findable — never invents.
  function extractContractRows(md) {
    if (!md) return [];
    const rows = [];
    const startedInfo = extractStartedInfo(md);
    if (startedInfo) {
      rows.push({ label: 'Started', value: formatStartedText(startedInfo.parsed) });

      const len      = extractLengthFromClause(startedInfo.clause);
      const computed = computeCurrentMonthNumber(startedInfo.parsed);
      const stated   = extractStatedMonth(md);
      const cur      = stated ?? computed;
      const m2m      = detectMonthToMonth(md);

      let monthValue;
      if (m2m)                   monthValue = `Month ${cur}, month-to-month`;
      else if (len && cur > len) monthValue = `Month ${cur}, past initial ${len}-month term`;
      else if (len)              monthValue = `Month ${cur} of ${len}`;
      else                       monthValue = `Month ${cur}`;
      rows.push({ label: 'Month', value: monthValue });
    }
    const scopeItems = extractScopeItems(md);
    if (scopeItems.length) rows.push({ label: 'Scope', value: scopeItems.join(' · ') });
    const judged = extractJudgedOn(md);
    if (judged) rows.push({ label: 'Judged on', value: judged });
    return rows;
  }

  function renderContractFromPlaybook(playbook) {
    const sec = el('div', 'sb3-section');
    sec.append(el('div', 'sb3-section-label', 'CONTRACT'));
    const body = el('div', 'sb3-section-body');

    if (!playbook) {
      body.append(el('div', 'sb3-contract-empty', 'No playbook on file.'));
      sec.append(body);
      return sec;
    }

    const rows = extractContractRows(playbook);
    if (!rows.length) {
      body.append(el('div', 'sb3-contract-empty', 'No contract data in playbook.'));
      sec.append(body);
      return sec;
    }

    for (const r of rows) {
      const row = el('div', 'sb3-playbook-row');
      row.append(el('div', 'sb3-playbook-label', r.label));
      row.append(el('div', 'sb3-playbook-value', r.value));
      body.append(row);
    }
    sec.append(body);
    return sec;
  }

  function renderSnapshotSection(rows) {
    const sec = el('div', 'sb3-section');
    sec.append(el('div', 'sb3-section-label', 'SNAPSHOT'));
    const body = el('div', 'sb3-section-body');
    for (const r of rows) {
      const row = el('div', 'sb3-snap-row');
      row.append(el('div', 'sb3-snap-label', r.label || ''));
      // Every snapshot value gets the same treatment as CONTRACT: markdown
      // stripped, hard-capped at 12 words.
      row.append(el('div', `sb3-snap-value tone-${r.tone || 'plain'}`, capWords(r.value, 12)));
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

      // Note: first stalled item name, else first highlight, else Not in scope.
      // No day counts — activity is the signal, not age.
      let note = '', muted = false;
      if (stalled.length) {
        const s = stalled[0];
        note = s.item_name || s.text || '';
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
    return v3State.selected || null;
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
      const rows = allBlocks.filter(b => b.side === g.key);
      if (!rows.length) continue;

      const group = el('div', 'sb3-block-group');
      group.style.setProperty('--sb3-group-accent', g.accent);
      group.append(el('div', 'sb3-group-label', g.label));

      for (const r of rows) {
        const row = el('div', 'sb3-block-row');
        row.append(el('div', 'sb3-block-client', r.client));
        row.append(el('div', 'sb3-block-item', r.item || ''));
        if (r.who) row.append(el('div', 'sb3-block-who', r.who));
        if (r.last_activity) row.append(el('div', 'sb3-block-activity', r.last_activity));
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

    const selectedEntry = v3State.selected
      ? v3Data.entries.find(e => e.slug === v3State.selected) || null
      : null;

    main.append(renderHeader(v3Data.summary, v3Data.entries, selectedEntry));
    main.append(renderPillsOrBack(v3Data.entries));
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

    const tick = (mutations) => {
      // Break the observer loop: our own renderRoot() writes fire mutations
      // whose targets are all inside .sb3-root. Ignore those or we recurse
      // forever (mount → render → mutation → tick → render → …).
      if (mutations && mutations.length && mutations.every(m => {
        const t  = m.target;
        const el = t && (t.nodeType === 1 ? t : t.parentElement);
        return el && el.closest('.sb3-root');
      })) return;

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
        // Already mounted and root is still in the DOM: leave it. User-driven
        // re-renders (pill clicks, card toggles) call renderRoot() directly.
        if (v3State.mounted && document.querySelector('.sb3-root')) return;
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
