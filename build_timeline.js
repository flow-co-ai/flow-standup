// build_timeline.js — compiles plan + actual events into timeline/[slug].json
//
// Runs after apply_performance.js (lens), before the commit step.
// For each timeline/[slug].plan.json:
//   PLAN  track: departments / bars / milestones / engagement from the plan file.
//   ACTUAL track: completed items from standups, approved suggestions, and pulse flags.
//   COMPUTED: actualPct, plannedPct, paceLabel/Color, nextUp, window, insight.
//
// Steel exception: steel-round-bars is the ONE timeline entry; its actual events
// are pulled from all three steel pulse slugs + the "Steel Round Bars" standup name.
// Flag events from sub-slugs are prefixed with the company short-name.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');
const CONFIG  = require('./config.json');

const STATE_BRANCH = process.env.STATE_BRANCH || 'state';

// ── static maps ───────────────────────────────────────────────────────────────

const INACTIVE = new Set(CLIENTS.filter(c => c.active === false).map(c => c.slug));

// Steel sub-slugs whose pulse files feed into the single steel timeline.
const STEEL_SUBS = ['steel-forte', 'steel-advance', 'steel-ohare'];
const STEEL_SHORT = { 'steel-forte': 'Forte', 'steel-advance': 'Advance', 'steel-ohare': "O'Hare" };

// Board ID → department name (from config.json boards).
const BOARD_DEPT = {};
for (const { id, name } of CONFIG.boards || []) BOARD_DEPT[id] = name;

// Slug → list of display names to match in standups.
const SLUG_STANDUP_NAMES = { 'steel-round-bars': ['Steel Round Bars', 'Forte Metals', 'Advance Grinding', "O'Hare Precision"] };
for (const c of CLIENTS) {
  if (!SLUG_STANDUP_NAMES[c.slug]) SLUG_STANDUP_NAMES[c.slug] = [c.name];
}

// Pace colours from design spec.
const PACE = {
  AHEAD:  { label: 'AHEAD OF PLAN', color: '#8CBE6E' },
  ON:     { label: 'ON PACE',       color: '#C6D093' },
  BEHIND: { label: 'BEHIND PLAN',   color: '#DE6E4C' },
};

// ── dept normalization ────────────────────────────────────────────────────────
// Applied to both plan bars and actual events so they share the same lane keys.
const DEPT_CANON = {
  ads:      ['ads', 'meta ads', 'google ads', 'paid', 'paid media'],
  web:      ['web', 'web + seo', 'seo', 'website'],
  crm:      ['crm', 'ghl', 'email'],
  creative: ['creative', 'video', 'content'],
  ops:      ['ops', 'admin', 'reporting'],
};
const DEPT_LOOKUP = {};
for (const [canon, aliases] of Object.entries(DEPT_CANON)) {
  for (const alias of aliases) DEPT_LOOKUP[alias.toLowerCase().trim()] = canon;
}

function normalizeDept(s) {
  return DEPT_LOOKUP[s?.toLowerCase().trim()] ?? 'ops';
}

// Merges plan departments that normalize to the same canonical name.
function normalizeDepts(rawDepts) {
  const merged = new Map();
  for (const d of rawDepts) {
    const canon = normalizeDept(d.dept);
    if (!merged.has(canon)) merged.set(canon, { dept: canon, bars: [] });
    for (const bar of d.bars || []) merged.get(canon).bars.push(bar);
  }
  return [...merged.values()];
}

// ── helpers ───────────────────────────────────────────────────────────────────

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function flagLabel(f) {
  const MAP = {
    'zero_spend_day':      'zero spend today',
    'lead_drought':        'lead drought',
    'channel_dark:meta':   'Meta went dark',
    'channel_dark:google': 'Google went dark',
  };
  return MAP[f] ?? f.replace(/_/g, ' ');
}

function deptFromItem(item) {
  if (item.monday_url) {
    const m = item.monday_url.match(/boards\/(\d+)/);
    if (m && BOARD_DEPT[m[1]]) return BOARD_DEPT[m[1]];
  }
  return 'Ops';
}

function daysBetween(a, b) {
  return (new Date(b) - new Date(a)) / 86400000;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function isoToday() { return new Date().toISOString().slice(0, 10); }

// ── standup events ────────────────────────────────────────────────────────────

function loadStandupEvents(standupNames) {
  const events = [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  if (!existsSync('standups')) return events;

  for (const f of readdirSync('standups').filter(n => n.endsWith('.json') && n !== 'latest.json')) {
    let data;
    try { data = JSON.parse(readFileSync(`standups/${f}`, 'utf8')); } catch { continue; }
    const weekOf = data.week_of || f.replace('.json', '');

    for (const c of data.by_client || []) {
      const clientName = c.client || '';
      if (!standupNames.some(n => clientName.toLowerCase().includes(n.toLowerCase()))) continue;

      // completed_this_week
      for (const item of c.completed_this_week || []) {
        const date = item.date || weekOf;
        if (date < cutoffStr) continue;
        events.push({ date, dept: deptFromItem(item), label: item.text || '', kind: 'completed' });
      }

      // completed_history
      for (const block of c.completed_history || []) {
        for (const item of block.items || []) {
          const date = item.date || block.week_of || weekOf;
          if (date < cutoffStr) continue;
          events.push({ date, dept: deptFromItem(item), label: item.text || '', kind: 'completed' });
        }
      }
    }
  }

  // Dedupe by (date, label).
  const seen = new Set();
  return events.filter(e => {
    const k = `${e.date}|${e.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── suggestion decisions ──────────────────────────────────────────────────────

async function fetchDecisions() {
  const url = `https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/${STATE_BRANCH}/checks/suggestion-decisions.json?t=${Date.now()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { items: [] };
    return await res.json();
  } catch { return { items: [] }; }
}

function approvedEvents(decisions, slugs) {
  return (decisions.items || [])
    .filter(d => d.decision === 'approved' && slugs.includes(d.slug))
    .map(d => ({
      date:  d.decidedAt?.slice(0, 10) || isoToday(),
      dept:  'Ads',
      label: d.text || d.suggestionId || '',
      kind:  'action',
    }));
}

// ── flag events ───────────────────────────────────────────────────────────────

function todayFlagEvents(slugs) {
  const today  = isoToday();
  const events = [];
  for (const slug of slugs) {
    const pulse = readJSON(`pulse/${slug}.json`);
    if (!pulse) continue;
    const flags    = pulse.windsor?.flags || [];
    const prefix   = slugs.length > 1 ? (STEEL_SHORT[slug] ?? slug) + ': ' : '';
    for (const f of flags) {
      events.push({ date: today, dept: 'Ads', label: prefix + flagLabel(f), kind: 'flag' });
    }
  }
  return events;
}

// ── merge events (flag accumulation) ─────────────────────────────────────────
// Keep all previous events, replace today's flags entirely with current ones
// (re-running on the same day is idempotent), dedupe by (date, label, kind).

function mergeEvents(prev, completed, actions, newFlags) {
  const today = isoToday();
  // Drop previous flags for today only (they'll be replaced by newFlags).
  const base = (prev || []).filter(e => !(e.kind === 'flag' && e.date === today));
  const all  = [...base, ...completed, ...actions, ...newFlags];
  const seen = new Set();
  return all.filter(e => {
    const k = `${e.date}|${e.kind}|${e.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// ── computed metrics ──────────────────────────────────────────────────────────

function computeActualPct(milestones, events) {
  if (!milestones?.length) return '0%';
  const completedLabels = events
    .filter(e => e.kind === 'completed')
    .map(e => e.label.toLowerCase());
  const matched = milestones.filter(m =>
    completedLabels.some(cl => cl.includes(m.label.toLowerCase()) || m.label.toLowerCase().includes(cl))
  );
  return Math.round(matched.length / milestones.length * 100) + '%';
}

function computePlannedPct(engagement, today) {
  if (!engagement?.start || !engagement?.end) return 0;
  const total   = daysBetween(engagement.start, engagement.end);
  if (total <= 0) return 100;
  const elapsed = daysBetween(engagement.start, today);
  return Math.round(clamp(elapsed / total * 100, 0, 100));
}

function computePace(actualPctStr, plannedPct) {
  const actual = parseInt(actualPctStr, 10) || 0;
  const diff   = actual - plannedPct;
  if (diff > 8)  return PACE.AHEAD;
  if (diff < -8) return PACE.BEHIND;
  return PACE.ON;
}

function nextUpMilestones(milestones, today) {
  return (milestones || [])
    .filter(m => m.date > today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3);
}

// ── insight ───────────────────────────────────────────────────────────────────

function computeInsight(pulseSlugs, paceLabel, milestones, events) {
  // Use performance.verdict from the worst-scoring pulse (lowest score).
  let worstPulse = null;
  for (const slug of pulseSlugs) {
    const p = readJSON(`pulse/${slug}.json`);
    if (!p) continue;
    if (!worstPulse || (p.score ?? 101) < (worstPulse.score ?? 101)) worstPulse = p;
  }
  if (worstPulse?.performance?.verdict) return worstPulse.performance.verdict;

  // Fallback: milestone count + pace.
  const done = parseInt(computeActualPct(milestones, events), 10) || 0;
  const n    = milestones?.length || 0;
  return `${Math.round(done * n / 100)} of ${n} milestones done, pace ${paceLabel.toLowerCase()}.`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Build timeline ===');

  if (!existsSync('timeline')) {
    console.log('  timeline/ does not exist — nothing to build');
    return;
  }

  const planFiles = readdirSync('timeline').filter(f => f.endsWith('.plan.json'));
  if (!planFiles.length) {
    console.log('  No plan files found — skipping');
    return;
  }

  const decisions = await fetchDecisions();
  const today     = isoToday();
  let built = 0, skipped = 0;

  for (const planFile of planFiles) {
    const slug = planFile.replace('.plan.json', '');

    if (INACTIVE.has(slug)) {
      console.log(`  ${slug}: skipped (inactive)`);
      skipped++;
      continue;
    }

    const plan = readJSON(`timeline/${planFile}`);
    if (!plan) { skipped++; continue; }

    // Determine which pulse slugs and standup names feed this timeline entry.
    const isSteel   = slug === 'steel-round-bars';
    const pulseSlugs = isSteel ? STEEL_SUBS : [slug];
    const standupNames = SLUG_STANDUP_NAMES[slug] || [slug];

    // Build actual event streams.
    const completedEvents = loadStandupEvents(standupNames);
    const actionEvents    = approvedEvents(decisions, pulseSlugs);
    const newFlagEvents   = todayFlagEvents(pulseSlugs);

    // Merge with previous.
    const prev       = readJSON(`timeline/${slug}.json`);
    const allEvents  = mergeEvents(prev?.events || [], completedEvents, actionEvents, newFlagEvents);

    // Compute metrics.
    const actualPct  = computeActualPct(plan.milestones, allEvents);
    const plannedPct = computePlannedPct(plan.engagement, today);
    const pace       = computePace(actualPct, plannedPct);
    const nextUp     = nextUpMilestones(plan.milestones, today);
    const insight    = computeInsight(pulseSlugs, pace.label, plan.milestones, allEvents);

    const engStart = plan.engagement?.start || '';
    const engEnd   = plan.engagement?.end   || '';
    const window_  = engStart && engEnd
      ? `ENGAGEMENT · ${engStart} → ${engEnd}`
      : 'ENGAGEMENT · dates unknown';

    const out = {
      generated_at: new Date().toISOString(),
      slug,
      // Plan track (depts and milestones normalized to canonical names)
      departments:  normalizeDepts(plan.departments || []),
      milestones:   (plan.milestones || []).map(m => ({ ...m, dept: normalizeDept(m.dept) })),
      engagement:   plan.engagement   || {},
      // Actual track (event depts normalized)
      events:       allEvents.map(e => ({ ...e, dept: normalizeDept(e.dept) })),
      // Computed
      actualPct,
      plannedPct,
      paceLabel:    pace.label,
      paceColor:    pace.color,
      nextUp,
      window:       window_,
      insight,
    };

    writeFileSync(`timeline/${slug}.json`, JSON.stringify(out, null, 2));
    console.log(`  ${slug}: ✓ ${allEvents.length} events, ${actualPct} actual, planned ${plannedPct}%, ${pace.label}`);
    built++;
  }

  console.log(`\nDone: ${built} built, ${skipped} skipped.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
