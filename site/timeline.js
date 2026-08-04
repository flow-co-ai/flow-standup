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

function dateOffset(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function datePct(dateStr, startStr, endStr) {
  const s = +new Date(startStr);
  const e = +new Date(endStr);
  const d = +new Date(dateStr);
  if (e <= s) return 0;
  return Math.max(0, Math.min(100, (d - s) / (e - s) * 100));
}

function monthHeaders(startStr, endStr) {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const results = [];
  const s = new Date(startStr + 'T00:00:00Z');
  const e = new Date(endStr   + 'T00:00:00Z');
  const startYear = s.getUTCFullYear();
  let yr  = startYear;
  let mon = s.getUTCMonth();
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
const dataCache = {};

// ── Chip bar ──────────────────────────────────────────────────────────────────
function buildChipBar() {
  const bar = el('div', { class: 'tl-chip-bar' });
  for (const { name, slug } of TIMELINE_CLIENTS) {
    const hasData  = !!dataCache[slug];
    const isActive = slug === activeSlug;
    const chip = el('div', {
      class: 'fui-chip' + (isActive ? ' active' : '') + (!hasData ? ' disabled' : ''),
      ...(hasData ? { onclick() { if (slug !== activeSlug) activateClient(slug); } } : {}),
    });
    chip.append(el('span', { text: name.toUpperCase() }));
    if (!hasData) chip.append(el('span', { class: 'tl-chip-nofeed', text: ' · NO PLAYBOOK' }));
    bar.append(chip);
  }
  return bar;
}

// ── Client header ─────────────────────────────────────────────────────────────
function buildClientHeader(data) {
  const completedCount = data.completedCount ?? (data.events || []).filter(e => e.kind === 'completed').length;
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
  const total      = data.milestones?.length || 0;
  const completed  = data.completedCount ?? (data.events || []).filter(e => e.kind === 'completed').length;

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
    el('div', { class: 'tl-scope-label', text: `${completed} OF ${total} MILESTONES` }),
    barTrack,
    paceEl
  );

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
function assignSubRows(bars, winStart, winEnd) {
  if (!bars.length) return { placed: [], rowCount: 0 };
  const sorted     = [...bars].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const rowEndPcts = [];
  const placed     = [];

  for (const bar of sorted) {
    const l = datePct(bar.start, winStart, winEnd);
    const r = datePct(bar.end,   winStart, winEnd);
    let rowIdx = rowEndPcts.findIndex(endPct => endPct <= l);
    if (rowIdx === -1) { rowIdx = rowEndPcts.length; rowEndPcts.push(r); }
    else               { rowEndPcts[rowIdx] = r; }
    placed.push({ bar, rowIdx, l, r });
  }

  return { placed, rowCount: rowEndPcts.length };
}

// ── Dot clustering ────────────────────────────────────────────────────────────
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

  for (const c of clusters) {
    c.pct = c.items.reduce((s, i) => s + i.pct, 0) / c.items.length;
  }

  return clusters;
}

// ── Gantt — data-driven axis, department lanes, no overlap ───────────────────
function buildGantt(data) {
  const { departments = [], milestones = [], events = [], engagement = {} } = data;
  const today = isoToday();

  // Axis bounds from actual data, ±14 days — no empty leading months
  const allDates = [
    ...departments.flatMap(d => (d.bars || []).flatMap(b => [b.start, b.end].filter(Boolean))),
    ...milestones.map(m => m.date).filter(Boolean),
    ...events.map(e => e.date).filter(Boolean),
    today,
  ];
  const dataMin  = allDates.reduce((a, b) => (a < b ? a : b));
  const dataMax  = allDates.reduce((a, b) => (a > b ? a : b));
  const winStart = dateOffset(dataMin, -14);
  const winEnd   = dateOffset(dataMax,  14);
  const todayPct = datePct(today, winStart, winEnd);
  const months   = monthHeaders(winStart, winEnd);

  const LABEL_W = 72; // px — left column for lane labels
  const BAR_H   = 24;
  const ROW_GAP = 4;
  const PAD_T   = 5;
  const PAD_B   = 5;
  const M_ROW_H = 16; // height reserved at bottom of lane for milestone diamonds

  // Shared helper: populate gridlines + today line into any relative container
  function addGrid(container) {
    for (const { pct } of months) {
      if (pct <= 0 || pct >= 100) continue;
      const gl = el('div', { class: 'tl-gridline' });
      gl.style.left = pct + '%';
      container.append(gl);
    }
    const tl = el('div', { class: 'tl-today-line' });
    tl.style.left = todayPct + '%';
    container.append(tl);
  }

  // Infer bar status from dates
  function barStatus(bar) {
    if (bar.end   && bar.end   <  today) return 'completed';
    if (bar.start && bar.start <= today) return 'in-progress';
    return 'future';
  }

  const gantt = el('div', { class: 'tl-gantt' });

  // ── Header: today label + month row, offset by LABEL_W ──────────────────────
  const headerEl     = el('div', { class: 'tl-gantt-header' });
  const headerSpacer = el('div', { class: 'tl-header-spacer' });
  headerSpacer.style.width = LABEL_W + 'px';
  headerEl.append(headerSpacer);

  const axisCol  = el('div', { class: 'tl-axis-col' });
  const todayRow = el('div', { class: 'tl-today-row' });
  const todayLbl = el('span', { class: 'tl-today-label', text: 'TODAY' });
  todayLbl.style.left = todayPct + '%';
  todayRow.append(todayLbl);
  axisCol.append(todayRow);

  const monthRow = el('div', { class: 'tl-gantt-month-row' });
  for (const { label, pct } of months) {
    const lbl = el('span', { class: 'tl-month-label', text: label });
    lbl.style.left = pct + '%';
    monthRow.append(lbl);
  }
  axisCol.append(monthRow);
  headerEl.append(axisCol);
  gantt.append(headerEl);

  // ── One lane per department ──────────────────────────────────────────────────
  for (const dept of departments) {
    const bars    = dept.bars || [];
    const deptKey = (dept.dept || '').toLowerCase();
    const deptMs  = milestones.filter(m => (m.dept || '').toLowerCase() === deptKey);

    const { placed, rowCount } = assignSubRows(bars, winStart, winEnd);
    const barAreaH   = rowCount > 0 ? (BAR_H + ROW_GAP) * rowCount - ROW_GAP : BAR_H;
    const hasMsRows  = deptMs.length > 0;
    const laneBodyH  = PAD_T + barAreaH + PAD_B + (hasMsRows ? M_ROW_H : 0);

    const lane      = el('div', { class: 'tl-lane' });
    const laneLabel = el('div', { class: 'tl-lane-label' });
    laneLabel.style.width    = LABEL_W + 'px';
    laneLabel.textContent    = (dept.dept || '').toUpperCase();
    lane.append(laneLabel);

    const laneBody = el('div', { class: 'tl-lane-body' });
    laneBody.style.height = laneBodyH + 'px';
    addGrid(laneBody);

    // Bars — colored by status
    for (const { bar, rowIdx, l, r } of placed) {
      const w     = Math.max(r - l, 0.5);
      const barEl = el('div', { class: 'tl-bar ' + barStatus(bar) });
      if (w >= 4) barEl.append(el('span', { class: 'tl-bar-lbl', text: bar.label }));
      barEl.style.left  = l + '%';
      barEl.style.width = w + '%';
      barEl.style.top   = PAD_T + rowIdx * (BAR_H + ROW_GAP) + 'px';
      barEl.title = bar.label;
      laneBody.append(barEl);
    }

    // Milestones — diamonds at bottom of lane
    for (const m of deptMs) {
      const pct = datePct(m.date, winStart, winEnd);
      if (pct < 0 || pct > 100) continue;
      const isDone   = !!m.completedAt || m.date < today;
      const diamond  = el('div', {
        class: 'tl-milestone' + (isDone ? ' completed' : ''),
        title: fmtShortDate(m.date) + ' · ' + m.label,
      });
      diamond.style.left = pct + '%';
      diamond.addEventListener('click', () =>
        selectEvt({ ...m, kind: 'milestone' }, isDone ? DOT_COLOR.completed : DOT_COLOR.milestone)
      );
      laneBody.append(diamond);
    }

    lane.append(laneBody);
    gantt.append(lane);
  }

  // ── Flag event track ─────────────────────────────────────────────────────────
  const flagEvents = events.filter(e => e.kind === 'flag');
  if (flagEvents.length) {
    const evtWrapper = el('div', { class: 'tl-event-wrapper' });
    const evtSpacer  = el('div', {});
    evtSpacer.style.width     = LABEL_W + 'px';
    evtSpacer.style.flexShrink = '0';
    evtWrapper.append(evtSpacer);

    const eventTrack = el('div', { class: 'tl-event-track' });
    addGrid(eventTrack);

    for (const evt of flagEvents) {
      const l = datePct(evt.date,               winStart, winEnd);
      const r = datePct(evt.endDate || evt.date, winStart, winEnd);
      if (r < 0 || l > 100) continue;
      const w    = Math.max(r - l, 0.5);
      const band = el('div', { class: 'tl-flag-band' });
      band.style.left  = l + '%';
      band.style.width = w + '%';
      if (w >= 5 && evt.label) band.append(el('span', { class: 'tl-bar-lbl', text: evt.label }));
      band.addEventListener('click', () => selectEvt(evt, DOT_COLOR.flag));
      eventTrack.append(band);
    }

    evtWrapper.append(eventTrack);
    gantt.append(evtWrapper);
  }

  return gantt;
}

// ── Legend ────────────────────────────────────────────────────────────────────
function buildLegend() {
  const legend = el('div', { class: 'tl-legend' });

  const barItems = [
    { color: DOT_COLOR.completed, label: 'COMPLETED' },
    { color: DOT_COLOR.action,    label: 'IN PROGRESS' },
    { color: DOT_COLOR.flag,      label: 'FLAG' },
  ];
  for (const { color, label } of barItems) {
    const dot = el('span', { class: 'tl-leg-dot' });
    dot.style.background = color;
    legend.append(el('span', { class: 'tl-leg-item' }, dot, el('span', { class: 'tl-leg-lbl', text: label })));
  }

  // Diamond for milestone
  const mItem    = el('span', { class: 'tl-leg-item' });
  const mDiamond = el('span', { class: 'tl-leg-diamond' });
  mDiamond.style.background   = '#8CBE6E';
  mDiamond.style.borderColor  = '#8CBE6E';
  mItem.append(mDiamond, el('span', { class: 'tl-leg-lbl', text: 'MILESTONE' }));
  legend.append(mItem);

  // Hollow = future
  const hollow = el('span', { class: 'tl-leg-item' });
  const hDot   = el('span', { class: 'tl-leg-dot' });
  hDot.style.cssText = 'background:#141A14;border:2px solid rgba(237,233,218,0.45);';
  hollow.append(hDot, el('span', { class: 'tl-leg-lbl', text: 'HOLLOW = STILL AHEAD' }));
  legend.append(hollow);

  return legend;
}

// ── Detail panel ──────────────────────────────────────────────────────────────
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

  if (evt.completedAt) {
    detailEl.append(el('div', { class: 'tl-det-meta', text: `COMPLETED · ${fmtDate(evt.completedAt)}` }));
    if (evt.completedNote) {
      detailEl.append(el('p', { class: 'tl-det-note', text: evt.completedNote }));
    }
  } else if (evt.note) {
    detailEl.append(el('p', { class: 'tl-det-note', text: evt.note }));
  }

  if (evt.days && evt.days > 1) {
    detailEl.append(el('div', { class: 'tl-det-meta', text: `${evt.days} DAYS` }));
  }

  document.querySelectorAll('.tl-dot.selected').forEach(d => d.classList.remove('selected'));
}

// ── Client render ─────────────────────────────────────────────────────────────
function activateClient(slug) {
  activeSlug  = slug;
  selectedEvt = null;
  detailEl    = null;

  const app = document.getElementById('tl-app');
  if (!app) return;

  const chipBar = app.querySelector('.tl-chip-bar');
  if (chipBar) chipBar.replaceWith(buildChipBar());

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
