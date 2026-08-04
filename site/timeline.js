// timeline.js — Timeline tab v2. Pace-first renderer. Vanilla DOM only.

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

// ── DOM builder ───────────────────────────────────────────────────────────────
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

// ── Constants ─────────────────────────────────────────────────────────────────
const DAY        = 864e5;
const LANE_ORDER = ['crm', 'ops', 'ads', 'creative', 'web'];
const MON        = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Bead colors — hex required for inline styles (CSS vars don't work there)
const C = {
  shipped:  '#929B69',
  active:   '#C6D093',
  planned:  'transparent',
  logged:   '#A9B478',
  ms:       '#8CBE6E',
  msFuture: 'transparent',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const clamp  = (v, a, b) => Math.max(a, Math.min(b, v));
const D      = s => new Date(s + 'T12:00:00');
const dLabel = d => MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
const dShort = d => MON[d.getMonth()].charAt(0) + MON[d.getMonth()].slice(1,3).toLowerCase() + ' ' + d.getDate();
const yy     = d => "'" + String(d.getFullYear()).slice(2);

// ── State ─────────────────────────────────────────────────────────────────────
let activeSlug = null;
const dataCache = {};
let tlState = { detail: null, collapse: true };

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

// ── Core computations — ported from design's renderVals() ─────────────────────
function computeVals(data, recentDays) {
  recentDays = recentDays || 30;
  const TODAY = data.generated_at ? D(data.generated_at.slice(0, 10)) : new Date();
  TODAY.setHours(12, 0, 0, 0);

  const cs         = D(data.engagement.start);
  const ce         = D(data.engagement.end);
  const totalDays  = Math.max(1, Math.round((ce - cs) / DAY));
  const elapsed    = clamp(Math.round((TODAY - cs) / DAY), 0, totalDays);
  const promisedPct  = Math.round(elapsed / totalDays * 100);
  const dRaw         = parseFloat(String(data.actualPct || '0').replace(/[^0-9.]/g, ''));
  const deliveredPct = isFinite(dRaw) ? clamp(Math.round(dRaw), 0, 100) : 0;
  const gapRaw       = promisedPct - deliveredPct;
  const gapPct       = Math.abs(gapRaw);
  const daysLeft     = totalDays - elapsed;
  const contractMonths = Math.round(totalDays / 30.44);

  // ── Build flat items list ──────────────────────────────────────────────────
  const allItems = [];
  (data.departments || []).forEach(d => (d.bars || []).forEach(b => {
    const s = D(b.start), e = D(b.end);
    allItems.push({ lane: d.dept, name: b.label, s, e: e < s ? s : e, type: 'plan' });
  }));
  (data.milestones || []).forEach(m =>
    allItems.push({ lane: m.dept, name: m.label, s: D(m.date), e: D(m.date), type: 'ms' }));
  (data.events || []).forEach(ev =>
    allItems.push({ lane: ev.dept, name: ev.label, s: D(ev.date), e: D(ev.date), type: 'event' }));

  allItems.forEach(it => {
    if (it.type === 'event')      it.kind = 'logged';
    else if (it.type === 'ms')    it.kind = it.s <= TODAY ? 'ms' : 'msFuture';
    else if (it.e < TODAY)        it.kind = 'shipped';
    else if (it.s <= TODAY)       it.kind = 'active';
    else                          it.kind = 'planned';
  });

  // ── Lane order ────────────────────────────────────────────────────────────
  const laneSet = new Set();
  LANE_ORDER.forEach(l => { if (allItems.some(i => i.lane === l)) laneSet.add(l); });
  allItems.forEach(i => { if (i.lane && !laneSet.has(i.lane)) laneSet.add(i.lane); });
  const lanes = [...laneSet];

  // ── Month buckets ─────────────────────────────────────────────────────────
  let lo = allItems.reduce((a, i) => i.s < a ? i.s : a, cs);
  let hi = allItems.reduce((a, i) => i.e > a ? i.e : a, ce);
  if (TODAY > hi) hi = TODAY;
  const months = [];
  let y = lo.getFullYear(), m = lo.getMonth();
  while (y < hi.getFullYear() || (y === hi.getFullYear() && m <= hi.getMonth())) {
    months.push({ y, m, s: new Date(y, m, 1, 12), e: new Date(y, m + 1, 0, 12) });
    m++; if (m > 11) { m = 0; y++; }
  }
  const counts = months.map(mo => allItems.filter(i => i.e >= mo.s && i.s <= mo.e).length);

  // ── Chapter builder (collapse or linear) ─────────────────────────────────
  function buildChapters(collapse) {
    let groups = [];
    if (!collapse) {
      groups = months.map((_, i) => ({ idx: [i] }));
    } else {
      const runs = [];
      months.forEach((_, i) => {
        const act = counts[i] > 0, last = runs[runs.length - 1];
        if (last && last.act === act) last.idx.push(i); else runs.push({ act, idx: [i] });
      });
      runs.forEach(run => {
        if (!run.act) { groups.push({ idx: run.idx, quiet: true }); return; }
        const sorted = run.idx.map(i => counts[i]).sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)] || 1;
        let buf = [];
        const flush = () => { while (buf.length) groups.push({ idx: buf.splice(0, 3) }); };
        run.idx.forEach(i => {
          if (run.idx.length > 1 && counts[i] >= 2 * med) { flush(); groups.push({ idx: [i], peak: true }); }
          else buf.push(i);
        });
        flush();
      });
    }

    return groups.map(g => {
      const a = months[g.idx[0]], b = months[g.idx[g.idx.length - 1]];
      const span = Math.max(1, b.e - a.s);
      const list = allItems.filter(i => i.e >= a.s && i.s <= b.e);
      const hasToday   = TODAY >= a.s && TODAY <= b.e;
      const preContract = b.e < cs;
      let label;
      if (g.idx.length === 1)    label = MON[a.m] + ' ' + yy(a.s);
      else if (a.y === b.y)      label = MON[a.m] + '–' + MON[b.m] + ' ' + yy(b.e);
      else                       label = MON[a.m] + ' ' + yy(a.s) + '–' + MON[b.m] + ' ' + yy(b.e);
      let sub;
      if (g.quiet)          sub = g.idx.length + ' MO · ' + (hasToday ? 'RUNWAY' : 'NO ACTIVITY');
      else if (preContract) sub = list.length + ' · PRE-CONTRACT';
      else                  sub = list.length + ' ITEMS';
      let flex = g.quiet ? 0.55 : 1 + list.length * 0.045;
      if (hasToday) flex = Math.max(flex, 1.55);
      if (!collapse) flex = 1;

      const marks = [];
      if (g.quiet && !hasToday) {
        marks.push({ l: 50, text: '· · ·', color: 'rgba(237,233,218,0.18)' });
      } else if (g.idx.length <= 3) {
        g.idx.forEach(i => {
          const mo = months[i];
          marks.push({ l: clamp(((mo.s - a.s) + (mo.e - mo.s) / 2) / span * 100, 6, 94), text: MON[mo.m], color: 'rgba(237,233,218,0.25)' });
        });
      }
      if (cs >= a.s && cs <= b.e) marks.push({ l: clamp((cs - a.s) / span * 100, 8, 92),  text: '▏ START', color: 'rgba(169,180,120,0.65)' });
      if (ce >= a.s && ce <= b.e) marks.push({ l: clamp((ce - a.s) / span * 100, 8, 88),  text: 'END ▕', color: 'rgba(169,180,120,0.65)' });
      if (hasToday)                marks.push({ l: clamp((TODAY - a.s) / span * 100, 8, 92), text: 'TODAY', color: 'rgba(237,233,218,0.85)' });

      return { g, a, b, span, list, label, sub, hasToday, preContract, quiet: !!g.quiet, flex, nMonths: g.idx.length, s: a.s, e: b.e, marks };
    });
  }

  // ── Recent / today / next ─────────────────────────────────────────────────
  const eventItems = allItems.filter(i => i.type === 'event').sort((a, b) => b.s - a.s);
  const lastLog    = eventItems[0];
  const cutoff     = new Date(TODAY - recentDays * DAY);
  const recent     = eventItems.filter(e => e.s >= cutoff);
  const seen = {}; const recentUnique = [];
  recent.forEach(ev => {
    const k = ev.lane + '|' + ev.name;
    if (seen[k]) { seen[k].n++; return; }
    seen[k] = { day: dShort(ev.s).toUpperCase(), name: ev.name, lane: ev.lane, n: 1, s: ev.s };
    recentUnique.push(seen[k]);
  });

  const activeItems = allItems.filter(i => i.type === 'plan' && i.s <= TODAY && i.e >= TODAY);
  const future      = allItems.filter(i => i.s > TODAY).sort((a, b) => a.s - b.s);
  const lastPlanned = allItems.filter(i => i.type !== 'event').reduce((a, i) => i.e > a ? i.e : a, cs);

  const msTotal  = (data.milestones || []).length;
  const msPassed = Math.min(msTotal, (data.milestones || []).filter(x => D(x.date) <= TODAY).length);

  const preCount  = allItems.filter(i => i.type === 'plan' && i.s < cs).length;
  const planCount = allItems.filter(i => i.type === 'plan').length;

  const checks = [];
  if (!future.length) checks.push(daysLeft + ' days of runway left; nothing is scheduled after ' + dLabel(lastPlanned) + '.');
  if (preCount)       checks.push(preCount + ' of ' + planCount + ' plan items pre-date the contract window (' + dLabel(cs) + ').');
  if (recent.length !== recentUnique.length) checks.push(recent.length + ' logged events in ' + recentDays + 'd resolve to ' + recentUnique.length + ' unique labels.');

  return {
    TODAY, cs, ce, totalDays, elapsed, daysLeft, contractMonths,
    promisedPct, deliveredPct, gapRaw, gapPct,
    gapLabel:     gapPct + (gapRaw >= 0 ? ' PTS BEHIND' : ' PTS AHEAD'),
    gapLabelLeft: clamp(deliveredPct + gapPct / 2, 14, 86),
    paceColor:    gapRaw >= 0 ? (data.paceColor || '#DE6E4C') : '#8CBE6E',
    paceLabel:    data.paceLabel || '—',
    msPassed, msTotal, recentDays, recentTotal: recent.length,
    allItems, lanes, months, counts, buildChapters,
    eventItems, lastLog, recent, recentUnique,
    activeItems, future, lastPlanned,
    checks,
  };
}

// ── Build beads for one cell ──────────────────────────────────────────────────
function buildBeads(list, ch) {
  const packed = [], rowEnds = [];
  list.slice().sort((x, z) => x.s - z.s).forEach(it => {
    const l = clamp((it.s - ch.s) / ch.span * 100, 0, 100);
    const w = clamp((Math.min(it.e, ch.e) - Math.max(it.s, ch.s)) / ch.span * 100, 0.6, 100 - l);
    let r = 0;
    while (r < 3 && rowEnds[r] != null && rowEnds[r] > l - 1.5) r++;
    if (r > 2) r = 2;
    rowEnds[r] = l + w;
    const isMs = it.type === 'ms';
    const hollow = it.kind === 'planned' || it.kind === 'msFuture';
    packed.push({
      l, w: isMs ? 0 : w, top: 8 + r * 11, h: 7, min: isMs ? 7 : 4,
      bg:     hollow ? 'transparent' : (C[it.kind] || C.shipped),
      border: hollow ? '1px solid rgba(198,208,147,0.42)' : 'none',
      radius: isMs ? '1px' : '2px',
      xform:  isMs ? 'rotate(45deg)' : 'none',
    });
  });
  return packed;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function buildSidebar(v, reopen) {
  const sidebar = el('div', { class: 'tl-sidebar' });

  // ── Detail mode ──────────────────────────────────────────────────────────
  if (tlState.detail) {
    const d   = tlState.detail;
    const box = el('div', { class: 'tl-panel tl-detail-panel' });
    const hd  = el('div', { class: 'tl-panel-head' });
    const hdL = el('div', { class: 'tl-det-head-left' });
    hdL.append(
      el('div', { class: 'tl-det-kicker', text: d.kicker }),
      el('div', { class: 'tl-det-title',  text: d.title  }),
    );
    const closeBtn = el('div', { class: 'tl-close-btn', text: 'CLOSE',
      onclick() { tlState.detail = null; reopen(); },
    });
    hd.append(hdL, closeBtn);
    box.append(hd);

    const scroll = el('div', { class: 'tl-det-scroll' });
    (d.items || []).forEach(it => {
      const row = el('div', { class: 'tl-det-item' });
      row.style.borderLeftColor = it.accent;
      row.append(
        el('div', { class: 'tl-det-name', text: it.name }),
        el('div', { class: 'tl-det-meta', text: it.meta }),
      );
      scroll.append(row);
    });
    box.append(scroll);
    sidebar.append(box);
    return sidebar;
  }

  // ── Today panel ──────────────────────────────────────────────────────────
  const todayPanel = el('div', { class: 'tl-panel tl-today-panel' });
  todayPanel.append(el('div', { class: 'tl-panel-kicker', text: 'TODAY · ' + dLabel(v.TODAY) }));

  const activeRow = el('div', { class: 'tl-today-active' });
  const activeNum = el('span', { class: 'tl-active-num', text: String(v.activeItems.length) });
  activeNum.style.color = v.activeItems.length ? 'var(--olive-bright)' : 'var(--olive-deep)';
  activeRow.append(activeNum, el('span', { class: 'tl-active-note', text: v.activeItems.length ? 'RUNNING NOW' : 'ITEMS SPAN TODAY' }));
  todayPanel.append(activeRow);

  const llRow = el('div', { class: 'tl-today-subrow tl-divider' });
  llRow.append(
    el('span', { class: 'tl-subrow-lbl', text: 'LAST LOG' }),
    el('span', { class: 'tl-subrow-val', text: v.lastLog ? dLabel(v.lastLog.s) + ' · ' + Math.round((v.TODAY - v.lastLog.s) / DAY) + 'D AGO' : '—' }),
  );
  todayPanel.append(llRow);

  const nextRow = el('div', { class: 'tl-today-subrow' });
  nextRow.append(el('span', { class: 'tl-subrow-lbl', text: 'NEXT' }));
  const nextR = el('div', { class: 'tl-next-right' });
  nextR.append(
    el('div', { class: 'tl-next-name', text: v.future.length ? v.future[0].name : 'Nothing scheduled after ' + dLabel(v.lastPlanned) + '.' }),
    el('div', { class: 'tl-subrow-meta', text: v.future.length ? v.future[0].lane.toUpperCase() + ' · ' + dLabel(v.future[0].s) : v.daysLeft + ' DAYS REMAIN IN CONTRACT' }),
  );
  nextRow.append(nextR);
  todayPanel.append(nextRow);
  sidebar.append(todayPanel);

  // ── Recent log panel ──────────────────────────────────────────────────────
  if (v.recentUnique.length) {
    const recentPanel = el('div', { class: 'tl-panel tl-recent-panel' });
    const rHead = el('div', { class: 'tl-panel-head' });
    rHead.append(
      el('span', { class: 'tl-panel-kicker', text: 'LAST ' + v.recentDays + ' DAYS' }),
      el('span', { class: 'tl-all-btn', text: v.recentTotal + ' LOGGED · ALL',
        onclick() {
          tlState.detail = {
            kicker: 'LOGGED · LAST ' + v.recentDays + ' DAYS',
            title:  v.recent.length + ' EVENTS · ' + v.recentUnique.length + ' UNIQUE',
            items: v.recentUnique.map(r => ({
              name: r.name, accent: C.logged,
              meta: r.lane.toUpperCase() + ' · ' + dShort(r.s).toUpperCase() + (r.n > 1 ? ' · ×' + r.n : ''),
            })),
          };
          reopen();
        },
      }),
    );
    const rList = el('div', { class: 'tl-recent-list' });
    v.recentUnique.slice(0, 5).forEach(r => {
      const row = el('div', { class: 'tl-recent-row' });
      row.append(
        el('span', { class: 'tl-recent-day', text: r.day }),
        el('div', { class: 'tl-recent-right' },
          el('div', { class: 'tl-recent-name', text: r.name }),
          el('div', { class: 'tl-recent-meta', text: r.lane.toUpperCase() + (r.n > 1 ? ' · ×' + r.n : '') }),
        ),
      );
      rList.append(row);
    });
    recentPanel.append(rHead, rList);
    sidebar.append(recentPanel);
  }

  // ── Checks panel ─────────────────────────────────────────────────────────
  if (v.checks.length) {
    const chkPanel = el('div', { class: 'tl-panel tl-checks-panel' });
    const chkHead  = el('div', { class: 'tl-checks-head' });
    const dot = el('span', { class: 'tl-checks-dot' });
    dot.style.background = v.paceColor;
    chkHead.append(dot, el('span', { class: 'tl-panel-kicker', text: 'NEEDS A LOOK · ' + v.checks.length }));
    chkPanel.append(chkHead);
    v.checks.forEach(txt => chkPanel.append(el('div', { class: 'tl-check-item', text: txt })));
    sidebar.append(chkPanel);
  }

  return sidebar;
}

// ── Lane matrix ───────────────────────────────────────────────────────────────
function buildMatrix(v, chapters, cols, reopen) {
  const matrix = el('div', { class: 'tl-matrix' });

  // Column header row
  const hRow  = el('div', { class: 'tl-mrow tl-mrow-header' });
  const hLane = el('div', { class: 'tl-lane-cell tl-lane-hdr', text: 'LANE' });
  hRow.append(hLane);
  const hGrid = el('div', { class: 'tl-cgrid' });
  hGrid.style.gridTemplateColumns = cols;
  chapters.forEach(ch => {
    const cell = el('div', { class: 'tl-col-hdr' + (ch.quiet ? ' quiet' : '') + (ch.hasToday ? ' is-today' : '') });
    cell.append(
      el('div', { class: 'tl-col-label', text: ch.label }),
      el('div', { class: 'tl-col-sub',   text: ch.sub   }),
    );
    hGrid.append(cell);
  });
  hRow.append(hGrid);
  matrix.append(hRow);

  // Lane rows
  const body = el('div', { class: 'tl-matrix-body' });
  v.lanes.forEach(lane => {
    const laneItems = v.allItems.filter(i => i.lane === lane);
    const row = el('div', { class: 'tl-mrow tl-mrow-lane' });

    const lCell = el('div', { class: 'tl-lane-cell' });
    lCell.append(
      el('span', { class: 'tl-lane-name',  text: lane.toUpperCase()        }),
      el('span', { class: 'tl-lane-total', text: String(laneItems.length)  }),
    );
    row.append(lCell);

    const cGrid = el('div', { class: 'tl-cgrid' });
    cGrid.style.gridTemplateColumns = cols;

    chapters.forEach(ch => {
      const list  = laneItems.filter(i => i.e >= ch.s && i.s <= ch.e);
      const beads = buildBeads(list, ch);
      const tdPct = clamp((v.TODAY - ch.s) / ch.span * 100, 0, 100).toFixed(2);

      const cell = el('div', { class: 'tl-cell' + (ch.quiet ? ' quiet' : '') + (list.length ? ' clickable' : '') });

      if (list.length) {
        cell.onclick = () => {
          tlState.detail = {
            kicker: lane.toUpperCase() + ' · ' + ch.label,
            title:  list.length + (list.length === 1 ? ' ITEM' : ' ITEMS'),
            items: list.slice().sort((x, z) => x.s - z.s).map(it => ({
              name: it.name,
              accent: C[it.kind] || C.shipped,
              meta: (it.type === 'ms' ? 'MILESTONE · ' : it.type === 'event' ? 'LOGGED · ' : 'PLAN · ')
                + (it.s - it.e === 0
                  ? dShort(it.s) + ', ' + it.s.getFullYear()
                  : dShort(it.s) + ' → ' + dShort(it.e) + ', ' + it.e.getFullYear()),
            })),
          };
          reopen();
        };
      }

      beads.forEach(b => {
        const bead = el('div', { class: 'tl-bead' });
        bead.style.left        = b.l + '%';
        bead.style.width       = b.w ? b.w + '%' : '0';
        bead.style.top         = b.top + 'px';
        bead.style.height      = b.h + 'px';
        bead.style.minWidth    = b.min + 'px';
        bead.style.background  = b.bg;
        bead.style.border      = b.border;
        bead.style.borderRadius = b.radius;
        bead.style.transform   = b.xform;
        cell.append(bead);
      });

      if (list.length) {
        const cnt = el('div', { class: 'tl-cell-count', text: String(list.length) });
        cnt.style.color = ch.hasToday ? 'rgba(169,180,120,0.75)' : 'rgba(237,233,218,0.2)';
        cell.append(cnt);
      }

      if (ch.hasToday) {
        const tl = el('div', { class: 'tl-cell-today' });
        tl.style.left = tdPct + '%';
        cell.append(tl);
      }

      cGrid.append(cell);
    });

    row.append(cGrid);
    body.append(row);
  });
  matrix.append(body);

  // Axis marks row
  const axRow  = el('div', { class: 'tl-mrow tl-mrow-axis' });
  axRow.append(el('div', { class: 'tl-lane-cell' }));
  const axGrid = el('div', { class: 'tl-cgrid' });
  axGrid.style.gridTemplateColumns = cols;
  chapters.forEach(ch => {
    const axCell = el('div', { class: 'tl-axis-cell' });
    ch.marks.forEach(m => {
      const lbl = el('div', { class: 'tl-axis-mark', text: m.text });
      lbl.style.left  = m.l + '%';
      lbl.style.color = m.color;
      axCell.append(lbl);
    });
    axGrid.append(axCell);
  });
  axRow.append(axGrid);
  matrix.append(axRow);

  // Legend + axis note row
  const lgRow   = el('div', { class: 'tl-mrow tl-mrow-legend' });
  lgRow.append(el('div', { class: 'tl-lane-cell' }));
  const lgInner = el('div', { class: 'tl-legend-inner' });

  [
    { text: 'SHIPPED',   bg: C.shipped,  border: 'none',                            radius: '2px', xform: 'none' },
    { text: 'ACTIVE',    bg: C.active,   border: 'none',                            radius: '2px', xform: 'none' },
    { text: 'PLANNED',   bg: 'transparent', border: '1px solid rgba(198,208,147,.42)', radius: '2px', xform: 'none' },
    { text: 'LOGGED',    bg: C.logged,   border: 'none',                            radius: '2px', xform: 'none' },
    { text: 'MILESTONE', bg: C.ms,       border: 'none',                            radius: '1px', xform: 'rotate(45deg)' },
  ].forEach(lg => {
    const sw = el('span', { class: 'tl-legend-swatch' });
    Object.assign(sw.style, { background: lg.bg, border: lg.border, borderRadius: lg.radius, transform: lg.xform });
    lgInner.append(el('div', { class: 'tl-legend-item' }, sw, el('span', { class: 'tl-legend-text', text: lg.text })));
  });

  const axNote = el('div', { class: 'tl-axis-note' });
  lgInner.append(axNote);
  lgRow.append(lgInner);
  matrix.append(lgRow);

  return { matrix, axNote };
}

// ── Full client render ─────────────────────────────────────────────────────────
function renderContent(slug) {
  const content = document.getElementById('tl-content');
  if (!content) return;
  content.innerHTML = '';

  const data = dataCache[slug];
  if (!data) {
    content.append(el('p', { class: 'tl-empty', text: 'No timeline data for this client yet.' }));
    return;
  }

  const v      = computeVals(data);
  const reopen = () => renderContent(slug);

  // ── Header ────────────────────────────────────────────────────────────────
  const header = el('div', { class: 'tl-header' });
  const hLeft  = el('div', { class: 'tl-header-left' });
  hLeft.append(
    el('div', { class: 'tl-eng-label', text: 'ENGAGEMENT · ' + data.engagement.start + ' → ' + data.engagement.end + ' · ' + v.contractMonths + ' MONTHS' }),
    el('p',   { class: 'tl-insight',   text: data.insight || '' }),
  );

  const factRail = el('div', { class: 'tl-fact-rail' });
  [
    { label: 'MILESTONES',              value: v.msPassed + '/' + v.msTotal },
    { label: 'LOGGED ' + v.recentDays + 'D', value: String(v.recentTotal) },
    { label: 'PACE',                    value: v.paceLabel, color: v.paceColor },
  ].forEach(f => {
    const lbl = el('div', { class: 'tl-fact-lbl', text: f.label });
    const val = el('div', { class: 'tl-fact-val', text: f.value });
    if (f.color) val.style.color = f.color;
    factRail.append(el('div', { class: 'tl-fact' }, lbl, val));
  });
  header.append(hLeft, factRail);

  // ── Pace bar ──────────────────────────────────────────────────────────────
  const paceBox = el('div', { class: 'tl-pace-box' });

  // DELIVERED
  const delTrack = el('div', { class: 'tl-pace-track' });
  const delFill  = el('div', { class: 'tl-pace-fill tl-del-fill' });
  delFill.style.width = v.deliveredPct + '%';
  delTrack.append(delFill);
  paceBox.append(
    el('div', { class: 'tl-pace-row' },
      el('div', { class: 'tl-pace-lbl', text: 'DELIVERED' }),
      delTrack,
      el('div', { class: 'tl-pace-num tl-del-num', text: v.deliveredPct + '%' }),
    )
  );

  // Gap bridge
  if (v.gapPct > 0) {
    const gapTrack  = el('div', { class: 'tl-gap-track' });
    const bridge    = el('div', { class: 'tl-gap-bridge' });
    bridge.style.left        = Math.min(v.deliveredPct, v.promisedPct) + '%';
    bridge.style.width       = v.gapPct + '%';
    bridge.style.borderColor = v.paceColor;
    const gapLbl = el('div', { class: 'tl-gap-label', text: v.gapLabel });
    gapLbl.style.left  = v.gapLabelLeft + '%';
    gapLbl.style.color = v.paceColor;
    gapTrack.append(bridge, gapLbl);
    paceBox.append(el('div', { class: 'tl-pace-row tl-gap-row' },
      el('div', { class: 'tl-pace-lbl' }), gapTrack, el('div', { class: 'tl-pace-lbl' })));
  }

  // PROMISED
  const promTrack = el('div', { class: 'tl-pace-track' });
  const promFill  = el('div', { class: 'tl-pace-fill tl-prom-fill' });
  promFill.style.width = v.promisedPct + '%';
  const promTick  = el('div', { class: 'tl-prom-tick' });
  promTick.style.left  = v.promisedPct + '%';
  promTrack.append(promFill, promTick);
  paceBox.append(
    el('div', { class: 'tl-pace-row' },
      el('div', { class: 'tl-pace-lbl', text: 'PROMISED' }),
      promTrack,
      el('div', { class: 'tl-pace-num tl-prom-num', text: v.promisedPct + '%' }),
    )
  );

  // Anchors
  const anchorTrack = el('div', { class: 'tl-anchor-track' });
  anchorTrack.append(
    el('span', { class: 'tl-anchor', text: 'START ' + data.engagement.start }),
    el('span', { class: 'tl-anchor tl-anchor-today', text: 'TODAY ' + dLabel(v.TODAY) + ' · ' + v.daysLeft + ' DAYS LEFT' }),
    el('span', { class: 'tl-anchor', text: 'END ' + data.engagement.end }),
  );
  paceBox.append(el('div', { class: 'tl-pace-row tl-anchors-row' },
    el('div', { class: 'tl-pace-lbl' }), anchorTrack, el('div', { class: 'tl-pace-lbl' })));

  // ── Main column ───────────────────────────────────────────────────────────
  const mainCol = el('div', { class: 'tl-main' });
  mainCol.append(header, paceBox);

  // Collapse toggle
  const colBar    = el('div', { class: 'tl-collapse-bar' });
  const colToggle = el('div', { class: 'tl-collapse-toggle',
    text: tlState.collapse ? 'LINEAR MONTHS' : 'COLLAPSE QUIET',
    onclick() { tlState.collapse = !tlState.collapse; reopen(); },
  });
  colBar.append(colToggle);
  mainCol.append(colBar);

  const chapters = v.buildChapters(tlState.collapse);
  const cols     = chapters.map(c => c.flex.toFixed(3) + 'fr').join(' ');
  const { matrix, axNote } = buildMatrix(v, chapters, cols, reopen);
  axNote.textContent = tlState.collapse
    ? 'COLUMN WIDTH ∝ ACTIVITY · QUIET MONTHS COLLAPSED'
    : 'LINEAR MONTHS';
  mainCol.append(matrix);

  // ── Assemble body grid ────────────────────────────────────────────────────
  const body    = el('div', { class: 'tl-body' });
  const sidebar = buildSidebar(v, reopen);
  body.append(mainCol, sidebar);
  content.append(body);
}

// ── Activate client ───────────────────────────────────────────────────────────
function activateClient(slug) {
  activeSlug = slug;
  tlState    = { detail: null, collapse: true };

  const app = document.getElementById('tl-app');
  if (!app) return;
  const chipBar = app.querySelector('.tl-chip-bar');
  if (chipBar) chipBar.replaceWith(buildChipBar());

  renderContent(slug);
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
  if (first) activateClient(first.slug);
  else document.getElementById('tl-content').innerHTML = '<p class="tl-empty">No timeline data available yet. Add playbooks to the Drive folder.</p>';
}

document.addEventListener('DOMContentLoaded', init);
