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

// ── Monday data loading ───────────────────────────────────────────────────────

function extractMondayId(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') return String(raw);
  const m = String(raw).match(/\[id:\s*(\d+)\]/);
  return m ? m[1] : (String(raw).match(/^\d+$/) ? String(raw) : null);
}

// Bidirectional partial name match: "Quality HVAC" ↔ "Quality HVAC by Fibid".
function clientMatches(clientName, standupNames) {
  const cn = clientName.toLowerCase();
  return standupNames.some(n => {
    const sn = n.toLowerCase();
    return cn.includes(sn) || sn.includes(cn);
  });
}

function loadMondayItems(standupNames) {
  const latest = readJSON('standups/latest.json');
  if (!latest) return [];

  const items = [];
  for (const c of latest.by_client || []) {
    if (!clientMatches(c.client || '', standupNames)) continue;
    for (const d of c.work_by_department || []) {
      const deptName = d.department || 'Ops';
      for (const item of [...(d.highlights || []), ...(d.stalled_items || [])]) {
        items.push({
          item_name:      item.item_name || item.text || '',
          department:     deptName,
          days_stalled:   item.days_stalled || 0,
          monday_item_id: extractMondayId(item.monday_item_id),
          monday_url:     item.monday_url || null,
          is_subitem:     false,
        });
      }
    }
  }

  const seen = new Set();
  return items.filter(item => {
    const k = item.monday_item_id || (item.item_name.toLowerCase() + '|' + item.department);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Loads ALL inbox items for the client (parents + subitems).
function loadInboxItems(standupNames) {
  const inbox = readJSON('site/inbox.json');
  if (!inbox?.by_client) return [];

  const items = [];
  for (const [clientName, clientItems] of Object.entries(inbox.by_client)) {
    if (!clientMatches(clientName, standupNames)) continue;
    if (Array.isArray(clientItems)) items.push(...clientItems);
  }
  return items;
}

// ── Token-overlap matching ────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a','an','the','is','in','of','to','for','with','and','or','on','at','by',
  'from','as','it','its','be','was','are','this','that','has','have','had',
  'all','new','one','no','so','up','out','via','vs','per','pre','each','both',
  'end','off','day','days','month','months','week','go','back','open','full',
  'live','fix','get','set','keep','take','run',
]);

function meaningfulTokens(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Tokens match if identical OR share a 5-char prefix (handles retarget/retargetting, keyword/keywords).
function tokensSimilar(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  return a.slice(0, 5) === b.slice(0, 5);
}

function sharedTokenCount(tokensA, tokensB) {
  return tokensA.filter(a => tokensB.some(b => tokensSimilar(a, b))).length;
}

// Lens matches from apply_task_matching.js. plan_task_id format = `${rawDept}::${label}`.
function loadLensMatches(slug) {
  const p = `timeline/${slug}.matches.json`;
  if (!existsSync(p)) return null;
  const data = readJSON(p);
  if (!data?.matches) return null;
  const byId = new Map();
  for (const m of data.matches) {
    if (m.plan_task_id && m.monday_item_id) {
      byId.set(m.plan_task_id, { monday_item_id: String(m.monday_item_id), confidence: m.confidence });
    }
  }
  return byId;
}

const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'closed', 'shipped', 'live', 'approved']);

function isDoneStatus(s) {
  if (!s) return false;
  return DONE_STATUSES.has(String(s).toLowerCase().trim());
}

// Full monday snapshot (from generate.py) → { itemId: {status, subitems: [{id, status}]} }
function loadMondaySnapshot(standupNames) {
  const snap = readJSON('site/monday-items.json');
  if (!snap?.by_client) return new Map();
  const byId = new Map();
  for (const [clientName, items] of Object.entries(snap.by_client)) {
    if (!standupNames.some(n => clientName.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(clientName.toLowerCase()))) continue;
    for (const it of items) {
      byId.set(String(it.monday_item_id), {
        status:   it.status || null,
        subitems: (it.subitems || []).map(s => ({
          monday_item_id: String(s.monday_item_id),
          status:         s.status || null,
        })),
      });
      for (const s of it.subitems || []) {
        byId.set(String(s.monday_item_id), { status: s.status || null, subitems: [] });
      }
    }
  }
  return byId;
}

// Items marked "Done" via standups' completed_history + completed_this_week text.
// Returns Set<monday_item_id>. Only IDs parseable from monday_url are included.
function loadDoneFromStandupHistory(standupNames) {
  const DONE_RE  = /Marked Done on Monday:/i;
  const PULSE_RE = /\/pulses\/(\d+)/;
  const doneIds  = new Set();
  if (!existsSync('standups')) return doneIds;

  for (const f of readdirSync('standups')) {
    if (!f.endsWith('.json')) continue;
    const data = readJSON(`standups/${f}`);
    if (!data?.by_client) continue;
    for (const c of data.by_client) {
      const cn = (c.client || '').toLowerCase();
      if (!standupNames.some(n => cn.includes(n.toLowerCase()) || n.toLowerCase().includes(cn))) continue;
      const pools = [
        ...(c.completed_this_week || []),
        ...(c.completed_history || []).flatMap(b => b.items || []),
      ];
      for (const item of pools) {
        if (!DONE_RE.test(item.text || '')) continue;
        const m = (item.monday_url || '').match(PULSE_RE);
        if (m) doneIds.add(m[1]);
      }
    }
  }
  return doneIds;
}

// ── Match plan tasks → Monday items + subitems ────────────────────────────────
// Lens matches (from apply_task_matching.js) take precedence.
// Token fallback requires 2+ shared meaningful tokens (or 1 if task has only 1).

function matchPlanTasks(planDepts, milestones, mondayItems, inboxItems, lensMatches, doneIds, snapshotById) {
  // Flatten plan tasks, dedupe by canonical dept + label. Keep RAW dept in id so
  // it matches the plan_task_id emitted by apply_task_matching.js.
  const planTasks = [];
  const taskSeen  = new Set();

  for (const d of planDepts) {
    for (const bar of d.bars || []) {
      const dept = normalizeDept(d.dept);
      const key  = dept + '|' + bar.label.toLowerCase();
      if (!taskSeen.has(key)) {
        taskSeen.add(key);
        planTasks.push({ id: `${d.dept}::${bar.label}`, label: bar.label, dept, source: 'bar' });
      }
    }
  }
  for (const m of milestones) {
    const dept = normalizeDept(m.dept);
    const key  = dept + '|' + m.label.toLowerCase();
    if (!taskSeen.has(key)) {
      taskSeen.add(key);
      planTasks.push({ id: `${m.dept}::${m.label}`, label: m.label, dept, source: 'milestone', date: m.date });
    }
  }

  // Inbox lookup: monday_item_id → full inbox item.
  const inboxById = new Map();
  for (const ix of inboxItems) {
    const id = String(ix.monday_item_id || '');
    if (id) inboxById.set(id, ix);
  }

  // Subitem counts (for the parent's display).
  const subCounts = new Map();
  for (const ix of inboxItems) {
    const pid = String(ix.parent_item_id || '');
    if (pid) subCounts.set(pid, (subCounts.get(pid) || 0) + 1);
  }

  // Build ALL candidates: standup work items + all inbox items (parents + subitems).
  // Subitems use their `board` field as department; parents already have board.
  const inboxCandidates = inboxItems.map(ix => ({
    item_name:      ix.item_name || '',
    department:     ix.board || 'Ops',
    days_stalled:   0,
    monday_item_id: String(ix.monday_item_id || ''),
    monday_url:     ix.url || null,
    is_subitem:     !!(ix.parent_item_id),
    parent_id:      ix.parent_item_id ? String(ix.parent_item_id) : null,
  }));

  // Merge: standup items first (they carry days_stalled), then inbox items not already present.
  const seenCandidateIds = new Set(mondayItems.map(m => m.monday_item_id).filter(Boolean));
  const extraCandidates  = inboxCandidates.filter(c => !seenCandidateIds.has(c.monday_item_id));

  const allCandidates = [...mondayItems, ...extraCandidates];

  const matchedIds    = new Set();
  const matched_tasks = [];

  for (const task of planTasks) {
    const taskTokens = meaningfulTokens(task.label);
    const minShared  = taskTokens.length >= 2 ? 2 : 1;

    let best = null, bestShared = 0, matchedVia = null;

    // Lens match first — model has already validated meaning, so no dept filter.
    const lens = lensMatches?.get(task.id);
    if (lens) {
      best = allCandidates.find(c => c.monday_item_id === lens.monday_item_id);
      if (best) matchedVia = best.is_subitem ? 'lens-subitem' : 'lens';
    }

    // Token fallback within same canonical dept.
    if (!best) {
      const deptCandidates = allCandidates.filter(c =>
        normalizeDept(c.department) === task.dept
      );
      for (const c of deptCandidates) {
        const cTokens = meaningfulTokens(c.item_name);
        const shared  = sharedTokenCount(taskTokens, cTokens);
        if (shared >= minShared && shared > bestShared) {
          bestShared = shared;
          best = c;
        }
      }
      if (best) matchedVia = best.is_subitem ? 'subitem' : 'item';
    }

    const result = { label: task.label, dept: task.dept, source: task.source };
    if (task.date) result.date = task.date;

    if (best) {
      const id = best.monday_item_id;
      if (id) matchedIds.add(id);
      if (best.is_subitem && best.parent_id) matchedIds.add(best.parent_id);

      const ix       = id ? inboxById.get(id) : null;
      const subCount = id ? (subCounts.get(id) || 0) : 0;

      let daysSinceUpdate = null;
      if (ix?.latest_update?.created_at) {
        daysSinceUpdate = Math.floor((Date.now() - new Date(ix.latest_update.created_at)) / 86400000);
      }

      let state = 'in-progress';
      if (best.days_stalled > 0) state = 'stalled';
      if (ix?.state === 'done' || ix?.state_label?.toLowerCase() === 'done') state = 'done';

      // Widen done detection: known-done ids from standups history / snapshot,
      // explicit Done status from monday snapshot, or a parent whose ALL subitems
      // (per snapshot) are Done.
      if (id) {
        if (doneIds?.has(id)) state = 'done';
        const snap = snapshotById?.get(id);
        if (snap) {
          if (isDoneStatus(snap.status)) state = 'done';
          if (snap.subitems?.length > 0 && snap.subitems.every(s => isDoneStatus(s.status))) {
            state = 'done';
          }
        }
      }

      const matchScore = matchedVia?.startsWith('lens')
        ? 100
        : Math.round(bestShared * 100 / Math.max(taskTokens.length, meaningfulTokens(best.item_name).length));

      Object.assign(result, {
        not_on_monday:     false,
        monday_item_id:    id,
        monday_item_name:  best.item_name,
        monday_url:        ix?.url || best.monday_url || null,
        days_stalled:      best.days_stalled || 0,
        days_since_update: daysSinceUpdate,
        subitem_count:     subCount,
        state,
        state_label:       ix?.state_label || null,
        match_score:       matchScore,
        matched_via:       matchedVia,
      });
    } else {
      result.not_on_monday = true;
    }

    matched_tasks.push(result);
  }

  // Monday-only: standup work items not matched to any plan task.
  const monday_only = mondayItems
    .filter(mi => mi.monday_item_id && !matchedIds.has(mi.monday_item_id))
    .map(mi => {
      const id  = mi.monday_item_id;
      const ix  = id ? inboxById.get(id) : null;
      let daysSinceUpdate = null;
      if (ix?.latest_update?.created_at) {
        daysSinceUpdate = Math.floor((Date.now() - new Date(ix.latest_update.created_at)) / 86400000);
      }
      return {
        monday_item_id:    id,
        item_name:         mi.item_name,
        dept:              normalizeDept(mi.department),
        days_stalled:      mi.days_stalled || 0,
        days_since_update: daysSinceUpdate,
        subitem_count:     id ? (subCounts.get(id) || 0) : 0,
        state:             ix?.state || (mi.days_stalled > 0 ? 'stalled' : 'in-progress'),
        state_label:       ix?.state_label || null,
        monday_url:        ix?.url || mi.monday_url || null,
      };
    });

  return { matched_tasks, monday_only, planTaskCount: planTasks.length };
}

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

function computeActualPct(milestones, completedEvents) {
  if (!milestones?.length) return '0%';
  const completedLabels = completedEvents.map(e => e.label.toLowerCase());
  const matched = milestones.filter(m =>
    completedLabels.some(cl => cl.includes(m.label.toLowerCase()) || m.label.toLowerCase().includes(cl))
  );
  return Math.round(matched.length / milestones.length * 100) + '%';
}

// Annotate milestones with completion info when a standup item fuzzy-matches.
function annotateMilestones(milestones, completedEvents) {
  return milestones.map(m => {
    const match = completedEvents.find(c =>
      c.label.toLowerCase().includes(m.label.toLowerCase()) ||
      m.label.toLowerCase().includes(c.label.toLowerCase())
    );
    const base = { ...m, dept: normalizeDept(m.dept) };
    return match ? { ...base, completedAt: match.date, completedNote: match.label } : base;
  });
}

// Collapse consecutive same-label/dept flags (gap < 3 days) into one band.
function dedupeFlags(events) {
  const flags  = events.filter(e => e.kind === 'flag');
  const others = events.filter(e => e.kind !== 'flag');

  const normalized = flags.map(f => ({ ...f, endDate: f.endDate || f.date }));
  normalized.sort((a, b) => {
    const keyDiff = (a.label + '|' + a.dept).localeCompare(b.label + '|' + b.dept);
    return keyDiff || a.date.localeCompare(b.date);
  });

  const bands = [];
  for (const f of normalized) {
    const last = bands[bands.length - 1];
    if (last && last.label === f.label && last.dept === f.dept &&
        daysBetween(last.endDate, f.date) < 3) {
      if (f.endDate > last.endDate) last.endDate = f.endDate;
      last.days = Math.round(daysBetween(last.date, last.endDate)) + 1;
    } else {
      bands.push({ ...f, days: Math.round(daysBetween(f.date, f.endDate)) + 1 });
    }
  }

  return [...others, ...bands].sort((a, b) => a.date.localeCompare(b.date));
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
    const mondayItems     = loadMondayItems(standupNames);
    const inboxItems      = loadInboxItems(standupNames);
    const newFlagEvents   = todayFlagEvents(pulseSlugs);

    // Merge with previous — strip legacy completed events (completions annotate milestones, not dots).
    const prev       = readJSON(`timeline/${slug}.json`);
    const prevEvents = (prev?.events || []).filter(e => e.kind !== 'completed');
    const allEvents  = mergeEvents(prevEvents, [], actionEvents, newFlagEvents);

    // Apply flag deduplication.
    const dedupedEvents = dedupeFlags(allEvents);

    // Compute metrics (actualPct uses standup completions to match milestones).
    const completedCount = (plan.milestones || []).filter(m => {
      const labels = completedEvents.map(e => e.label.toLowerCase());
      return labels.some(l => l.includes(m.label.toLowerCase()) || m.label.toLowerCase().includes(l));
    }).length;
    const actualPct  = computeActualPct(plan.milestones, completedEvents);
    const plannedPct = computePlannedPct(plan.engagement, today);
    const pace       = computePace(actualPct, plannedPct);
    const nextUp     = nextUpMilestones(plan.milestones, today);
    const insight    = computeInsight(pulseSlugs, pace.label, plan.milestones, completedEvents);

    const engStart = plan.engagement?.start || '';
    const engEnd   = plan.engagement?.end   || '';
    const window_  = engStart && engEnd
      ? `ENGAGEMENT · ${engStart} → ${engEnd}`
      : 'ENGAGEMENT · dates unknown';

    // Match plan tasks to current Monday items (lens matches first, then token).
    const lensMatches   = loadLensMatches(slug);
    const doneIds       = loadDoneFromStandupHistory(standupNames);
    const snapshotById  = loadMondaySnapshot(standupNames);
    const { matched_tasks, monday_only, planTaskCount } = matchPlanTasks(
      plan.departments || [], plan.milestones || [], mondayItems, inboxItems,
      lensMatches, doneIds, snapshotById
    );
    const matchedCount   = matched_tasks.filter(t => !t.not_on_monday).length;
    const unmatchedCount = matched_tasks.filter(t =>  t.not_on_monday).length;
    const doneMatched    = matched_tasks.filter(t => !t.not_on_monday && t.state === 'done').length;
    const matchRatio     = planTaskCount > 0 ? Math.round(matchedCount / planTaskCount * 100) / 100 : 0;

    // When a matches.json exists, prefer a match-based actualPct: % of plan tasks
    // whose matched Monday item is done. Falls back to the milestone-fuzzy metric
    // when there is no lens file yet.
    const actualPctFinal = lensMatches
      ? (planTaskCount > 0 ? Math.round(doneMatched / planTaskCount * 100) + '%' : '0%')
      : actualPct;
    const paceFinal = lensMatches ? computePace(actualPctFinal, plannedPct) : pace;

    const out = {
      generated_at: new Date().toISOString(),
      slug,
      // Plan track (depts and milestones normalized to canonical names)
      departments:  normalizeDepts(plan.departments || []),
      milestones:   annotateMilestones(plan.milestones || [], completedEvents),
      engagement:   plan.engagement   || {},
      // Actual track — flags + actions only (completions live in milestone annotations).
      events:       dedupedEvents.map(e => ({ ...e, dept: normalizeDept(e.dept) })),
      // Computed
      completedCount,
      actualPct:    actualPctFinal,
      plannedPct,
      paceLabel:    paceFinal.label,
      paceColor:    paceFinal.color,
      nextUp,
      window:       window_,
      insight,
      // Monday matching
      match_ratio:  matchRatio,
      matched_tasks,
      monday_only,
    };

    writeFileSync(`timeline/${slug}.json`, JSON.stringify(out, null, 2));
    const lensTag = lensMatches ? ' (lens)' : '';
    console.log(`  ${slug}: ✓ ${planTaskCount} plan tasks — ${matchedCount} matched${lensTag}, ${unmatchedCount} unmatched | ${dedupedEvents.length} events, ${paceFinal.label}`);
    built++;
  }

  console.log(`\nDone: ${built} built, ${skipped} skipped.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
