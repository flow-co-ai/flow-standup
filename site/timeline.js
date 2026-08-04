// timeline.js — Timeline tab. Fully self-contained, no imports from app.js.

const TIMELINE_BASE = 'https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/main/timeline';

const TIMELINE_CLIENTS = [
  { name: 'Billy Doe Meats',       slug: 'billy-doe' },
  { name: 'Full Smile',            slug: 'full-smile' },
  { name: 'Healing Helps',         slug: 'healing-helps' },
  { name: 'Quality HVAC',          slug: 'hvac' },
  { name: 'Justice Consumer Law',  slug: 'jcl' },
  { name: 'Liferun',               slug: 'liferun' },
  { name: 'Maadi Law',             slug: 'maadi-law' },
  { name: 'Steel Round Bars',      slug: 'steel-round-bars' },
];

const DOT_COLOR = {
  completed: '#8CBE6E',
  action:    '#A9B478',
  flag:      '#DE6E4C',
  milestone: '#C6D093',
};

// ── DOM builder (self-contained copy) ────────────────────────────────────────
function el(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if      (k === 'class')                                   e.className = v;
    else if (k === 'text')                                    e.textContent = v;
    else if (k === 'html')                                    e.innerHTML = v;
    else if (k === 'id')                                      e.id = v;
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

// ── Date helpers ──────────────────────────────────────────────────────────────
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function datePct(dateStr, startStr, endStr) {
  const s = +new Date(startStr);
  const e = +new Date(endStr);
  const d = +new Date(dateStr);
  if (e <= s) return 0;
  return Math.max(0, Math.min(100, (d - s) / (e - s) * 100));
}

function monthHeaders(startStr, endStr) {
  // Steps month-by-month from floor(start) to end; labels year crossings 'JAN '27'.
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const results = [];

  const s = new Date(startStr + 'T00:00:00Z');
  const e = new Date(endStr   + 'T00:00:00Z');
  const startYear = s.getUTCFullYear();

  let yr  = startYear;
  let mon = s.getUTCMonth();  // floor to start month

  while (true) {
    const d = new Date(Date.UTC(yr, mon, 1));
    if (d > e) break;
    const iso = d.toISOString().slice(0, 10);
    const pct = datePct(iso, startStr, endStr);
    const label = yr !== startYear
      ? `${MONTHS[mon]} '${String(yr).slice(2)}`
      : MONTHS[mon];
    results.push({ label, pct });
    mon++;
    if (mon > 11) { mon = 0; yr++; }
  }

  return results;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ── State ─────────────────────────────────────────────────────────────────────
let activeSlug = null;
let selectedEvt = null;
const dataCache = {};  // slug → timeline JSON

// ── Chip bar ──────────────────────────────────────────────────────────────────
function buildChipBar() {
  const bar = el('div', { class: 'tl-chip-bar' });
  for (const { name, slug } of TIMELINE_CLIENTS) {
    const hasData = !!dataCache[slug];
    const isActive = slug === activeSlug;
    const chip = el('div', {
      class: 'tl-chip' + (isActive ? ' active' : '') + (!hasData ? ' disabled' : ''),
      ...(hasData ? {
        onclick() { if (slug !== activeSlug) activateClient(slug); },
      } : {}),
    });
    chip.append(el('span', { text: name.toUpperCase() }));
    if (!hasData) chip.append(el('span', { class: 'tl-chip-nofeed', text: ' · NO PLAYBOOK' }));
    bar.append(chip);
  }
  return bar;
}

// ── Client header ─────────────────────────────────────────────────────────────
function buildClientHeader(data) {
  const completedCount = (data.events || []).filter(e => e.kind === 'completed').length;
  return el('div', { class: 'tl-client-header' },
    el('div', { class: 'tl-header-left' },
      el('div', { class: 'tl-window-label', text: data.window || 'ENGAGEMENT' }),
      el('p', { class: 'tl-insight', text: data.insight || '' })
    ),
    el('div', { class: 'tl-fact-chips' },
      factChip('MILESTONES', String(data.milestones?.length || 0)),
      factChip('COMPLETED',  String(completedCount)),
      factChip('PACE', data.paceLabel?.split(' ')[0] || '—'),
    )
  );
}

function factChip(label, value) {
  return el('div', { class: 'tl-fact-chip' },
    el('span', { class: 'tl-fact-label', text: label }),
    el('span', { class: 'tl-fact-value', text: value })
  );
}

// ── Progress panel ────────────────────────────────────────────────────────────
function buildProgressPanel(data) {
  const today      = isoToday();
  const notStarted = !!data.engagement?.start && today < data.engagement.start;

  const barTrack = el('div', { class: 'tl-bar-track' });
  const fill = el('div', { class: 'tl-bar-fill' });
  fill.style.width = data.actualPct || '0%';
  barTrack.append(fill);
  if (!notStarted) {
    const tick = el('div', { class: 'tl-planned-tick' });
    tick.style.left = (data.plannedPct || 0) + '%';
    barTrack.append(tick);
  }

  const paceEl = el('div', {
    class: 'tl-pace-label',
    text:  notStarted ? 'NOT STARTED' : (data.paceLabel || ''),
  });
  paceEl.style.color = notStarted
    ? 'rgba(237,233,218,0.35)'
    : (data.paceColor || '#C6D093');

  const left = el('div', { class: 'tl-progress-left' },
    el('div', { class: 'tl-scope-num', text: data.actualPct || '0%' }),
    el('div', { class: 'tl-scope-label', text: 'SCOPE BUILT' }),
    barTrack,
    paceEl
  );

  // UP NEXT pills
  const pills = el('div', { class: 'tl-up-pills' });
  for (const m of data.nextUp || []) {
    const pill = el('div', { class: 'tl-up-pill' },
      el('span', { class: 'tl-up-pill-dot' }),
      el('span', { class: 'tl-up-pill-date', text: fmtShortDate(m.date) }),
      el('span', { class: 'tl-up-pill-name', text: m.label })
    );
    pill.addEventListener('click', () => selectEvt({ ...m, kind: 'milestone' }, DOT_COLOR.milestone));
    pills.append(pill);
  }

  const right = el('div', { class: 'tl-progress-right' },
    el('div', { class: 'tl-next-up-head', text: 'UP NEXT' }),
    pills
  );

  return el('div', { class: 'tl-progress' }, left, right);
}

// ── Bar sub-row stacking ──────────────────────────────────────────────────────
// Assigns overlapping bars to sub-rows so they never paint on top of each other.
function assignSubRows(bars, engStart, engEnd) {
  if (!bars.length) return { placed: [], rowCount: 0 };
  const sorted     = [...bars].sort((a, b) => a.start.localeCompare(b.start));
  const rowEndPcts = [];
  const placed     = [];

  for (const bar of sorted) {
    const l = datePct(bar.start, engStart, engEnd);
    const r = datePct(bar.end,   engStart, engEnd);
    let rowIdx = rowEndPcts.findIndex(endPct => endPct <= l);
    if (rowIdx === -1) { rowIdx = rowEndPcts.length; rowEndPcts.push(r); }
    else               { rowEndPcts[rowIdx] = r; }
    placed.push({ bar, rowIdx, l, r });
  }

  return { placed, rowCount: rowEndPcts.length };
}

// ── Dot clustering ────────────────────────────────────────────────────────────
// Groups events within 1.5% of each other on the x-axis into one dot.
function clusterDots(items) {
  if (!items.length) return [];
  const sorted   = [...items].sort((a, b) => a.pct - b.pct);
  const clusters = [];

  for (const item of sorted) {
    const existing = clusters.find(c => Math.abs(c.pct - item.pct) <= 1.5);
    if (existing) {
      existing.items.push(item);
    } else {
      clusters.push({ pct: item.pct, items: [item] });
    }
  }

  // Recompute position as average of member pcts for stable centering.
  for (const c of clusters) {
    c.pct = c.items.reduce((s, i) => s + i.pct, 0) / c.items.length;
  }

  return clusters;
}

// ── Gantt ─────────────────────────────────────────────────────────────────────
function buildGantt(data) {
  const { departments = [], milestones = [], events = [], engagement = {} } = data;
  const start = engagement.start || isoToday();
  const end   = engagement.end   || (() => {
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 6);
    return d.toISOString().slice(0, 10);
  })();
  const today = isoToday();

  // Collect all unique depts in order: plan first, then event-only depts
  const deptOrder = [...new Set([
    ...departments.map(d => d.dept),
    ...events.map(e => e.dept),
    ...milestones.map(m => m.dept),
  ])];

  const gantt = el('div', { class: 'tl-gantt' });

  // Month header row
  const months = monthHeaders(start, end);
  const todayPct = datePct(today, start, end);

  // Left spacer + month row
  gantt.append(el('div', { class: 'tl-gantt-header-spacer' }));
  const monthRow = el('div', { class: 'tl-gantt-month-row' });
  for (const { label, pct } of months) {
    const lbl = el('span', { class: 'tl-month-label', text: label });
    lbl.style.left = pct + '%';
    monthRow.append(lbl);
  }
  if (today >= start && today <= end) {
    const todayLbl = el('span', { class: 'tl-today-label', text: 'TODAY' });
    todayLbl.style.left = todayPct + '%';
    monthRow.append(todayLbl);
  }
  gantt.append(monthRow);

  // Dept rows — skip entirely if lane has nothing to show
  const PRIORITY = { flag: 0, completed: 1, action: 2, milestone: 3 };
  const BAR_H = 24, DOT_H = 20, ROW_H = 28;

  for (const dept of deptOrder) {
    const deptData   = departments.find(d => d.dept === dept);
    const bars       = deptData?.bars || [];
    const deptEvents = events.filter(e => e.dept === dept);
    const deptMiles  = milestones.filter(m => m.dept === dept);

    if (!bars.length && !deptEvents.length && !deptMiles.length) continue;

    // Left: dept label — microline shows bar count.
    const barCount = bars.length;
    const labelEl  = el('div', { class: 'tl-dept-label' },
      el('span', { text: dept.toUpperCase() }),
      el('span', { class: 'tl-dept-count',
        text: barCount ? `${barCount} bar${barCount !== 1 ? 's' : ''}` : '' })
    );
    gantt.append(labelEl);

    // Right: track — height = BAR_H * subRows + DOT_H dot row.
    const track = el('div', { class: 'tl-track' });
    const { placed, rowCount } = assignSubRows(bars, start, end);
    track.style.height = (BAR_H * rowCount + DOT_H) + 'px';

    // Month gridlines
    for (const { pct } of months) {
      if (pct <= 0 || pct >= 100) continue;
      const gl = el('div', { class: 'tl-gridline' });
      gl.style.left = pct + '%';
      track.append(gl);
    }

    // Planned bars — label hidden when bar is too narrow to fit text
    for (const { bar, rowIdx, l, r } of placed) {
      const w = Math.max(r - l, 0.5);
      const barEl = el('div', { class: 'tl-bar' });
      if (w >= 5) barEl.append(el('span', { class: 'tl-bar-lbl', text: bar.label }));
      barEl.style.left  = l + '%';
      barEl.style.width = w + '%';
      barEl.style.top   = (rowIdx * ROW_H) + 'px';
      if (bar.inferred) barEl.style.opacity = '0.6';
      track.append(barEl);
    }

    // Today line
    if (today >= start && today <= end) {
      const tl = el('div', { class: 'tl-today-line' });
      tl.style.left = todayPct + '%';
      track.append(tl);
    }

    // Collect all dots, cluster by proximity, render with cycle-click
    const allDotItems = [
      ...deptEvents.map(evt => ({
        pct:    datePct(evt.date, start, end),
        evt,
        color:  DOT_COLOR[evt.kind] || '#A9B478',
        isPast: evt.date <= today,
      })),
      ...deptMiles.map(m => ({
        pct:    datePct(m.date, start, end),
        evt:    { ...m, kind: 'milestone' },
        color:  DOT_COLOR.milestone,
        isPast: m.date <= today,
      })),
    ];

    for (const cluster of clusterDots(allDotItems)) {
      const { items } = cluster;
      const top = items.slice().sort((a, b) =>
        (PRIORITY[a.evt.kind] ?? 9) - (PRIORITY[b.evt.kind] ?? 9)
      )[0];
      const isPast = items.every(i => i.isPast);
      const color  = top.color;

      const dot = el('div', { class: 'tl-dot' + (isPast ? '' : ' hollow') });
      dot.style.left = cluster.pct + '%';
      if (isPast) {
        dot.style.background = color;
      } else {
        dot.style.border = '2px solid ' + color;
      }

      if (items.length > 1) {
        dot.append(el('span', { class: 'tl-dot-badge', text: String(items.length) }));
      }

      let cycleIdx = 0;
      dot.addEventListener('click', () => {
        const item = items[cycleIdx % items.length];
        selectEvt(item.evt, item.color);
        cycleIdx++;
        document.querySelectorAll('.tl-dot.selected').forEach(d => d.classList.remove('selected'));
        dot.classList.add('selected');
      });

      track.append(dot);
    }

    gantt.append(track);
  }

  return gantt;
}

// ── Legend ────────────────────────────────────────────────────────────────────
function buildLegend() {
  const items = [
    { color: DOT_COLOR.completed, label: 'COMPLETED' },
    { color: DOT_COLOR.action,    label: 'ACTION TAKEN' },
    { color: DOT_COLOR.flag,      label: 'FLAG' },
    { color: DOT_COLOR.milestone, label: 'MILESTONE' },
  ];
  const legend = el('div', { class: 'tl-legend' });
  for (const { color, label } of items) {
    const dot = el('span', { class: 'tl-leg-dot' });
    dot.style.background = color;
    legend.append(el('span', { class: 'tl-leg-item' }, dot, el('span', { class: 'tl-leg-lbl', text: label })));
  }
  const hollow = el('span', { class: 'tl-leg-item' });
  const hDot = el('span', { class: 'tl-leg-dot' });
  hDot.style.cssText = 'background:#141A14;border:2px solid rgba(237,233,218,0.45);';
  hollow.append(hDot, el('span', { class: 'tl-leg-lbl', text: 'HOLLOW = STILL AHEAD' }));
  legend.append(hollow);
  return legend;
}

// ── Detail panel ──────────────────────────────────────────────────────────────
// The detail panel is a persistent DOM element; selectEvt() populates it.
let detailEl = null;

function buildDetailPanel() {
  detailEl = el('div', { class: 'tl-detail empty' });
  return detailEl;
}

function selectEvt(evt, color) {
  selectedEvt = evt;
  if (!detailEl) return;
  detailEl.className = 'tl-detail';
  detailEl.style.borderColor = color;
  detailEl.innerHTML = '';

  const dateEl = el('div', { class: 'tl-det-date', text: fmtDate(evt.date) });
  dateEl.style.color = color;

  const meta = [evt.dept, evt.kind].filter(Boolean).join(' · ').toUpperCase();
  detailEl.append(
    dateEl,
    el('div', { class: 'tl-det-meta', text: meta }),
    el('div', { class: 'tl-det-label', text: evt.label || '' }),
  );
  if (evt.note) {
    detailEl.append(el('p', { class: 'tl-det-note', text: evt.note }));
  }

  // Update dot selection rings
  document.querySelectorAll('.tl-dot.selected').forEach(d => d.classList.remove('selected'));
}

// ── Client render ─────────────────────────────────────────────────────────────
function activateClient(slug) {
  activeSlug = slug;
  selectedEvt = null;
  detailEl = null;

  const app = document.getElementById('tl-app');
  if (!app) return;

  // Rebuild the full chip bar with updated active state
  let chipBar = app.querySelector('.tl-chip-bar');
  if (chipBar) {
    chipBar.replaceWith(buildChipBar());
  }

  const content = document.getElementById('tl-content');
  if (!content) return;
  content.innerHTML = '';

  const data = dataCache[slug];
  if (!data) {
    content.innerHTML = '<p class="tl-empty">No timeline data for this client yet.</p>';
    return;
  }

  content.append(
    buildClientHeader(data),
    buildProgressPanel(data),
    buildGantt(data),
    buildLegend(),
    buildDetailPanel(),
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const app = document.getElementById('tl-app');
  app.innerHTML = '<div class="tl-loading">Loading timeline data…</div>';

  await Promise.all(TIMELINE_CLIENTS.map(async ({ slug }) => {
    try {
      const res = await fetch(`${TIMELINE_BASE}/${slug}.json?t=${Date.now()}`);
      if (res.ok) dataCache[slug] = await res.json();
    } catch {}
  }));

  app.innerHTML = '';
  app.append(buildChipBar());
  app.append(el('div', { id: 'tl-content' }));

  const first = TIMELINE_CLIENTS.find(c => dataCache[c.slug]);
  if (first) {
    activateClient(first.slug);
  } else {
    document.getElementById('tl-content').innerHTML = '<p class="tl-empty">No timeline data available yet. Add playbooks to the Drive folder.</p>';
  }
}

document.addEventListener('DOMContentLoaded', init);
