#!/usr/bin/env node
// build_workstreams.js — writes workstreams/[slug].json for every active client.
//
// Primary item source: site/monday-items.json (full board snapshot, all items + statuses)
// Movement dates:      site/inbox.json (latest_update timestamps) + standups/ (completion dates)
// No API calls. No model calls.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const TODAY_ISO     = new Date().toISOString().slice(0, 10);
const TODAY_MS      = Date.parse(TODAY_ISO);
const ROOT          = __dirname;
const WORKSTREAMS_DIR = join(ROOT, 'workstreams');

// ─── Monday client-name → clients.json slug(s) ────────────────────────────────
const MONDAY_TO_SLUGS = {
  'Billy Doe Meats':      ['billy-doe'],
  'Full Smile':           ['full-smile'],
  'Quality HVAC':         ['hvac'],
  'Justice Consumer Law': ['jcl'],
  'Liferun':              ['liferun'],
  'Flow Company':         ['flow-company'],
  'MedStation':           ['medstation'],
  'Maadi Law':            ['maadi-law'],
  'Steel Round Bars':     ['steel-forte', 'steel-advance', 'steel-ohare'],
  'Healing Helps':        ['healing-helps'],
};
const SLUG_TO_MONDAY = {};
for (const [mname, slugs] of Object.entries(MONDAY_TO_SLUGS)) {
  for (const s of slugs) SLUG_TO_MONDAY[s] = mname;
}

// ─── Record filter ─────────────────────────────────────────────────────────────
// Items matching any of these patterns are administrative records, not deliverable
// work, and are excluded from workstream output. One pattern per concern.
const RECORD_FILTER_PATTERNS = [
  /\bmeeting notes?\b/i,
  /\bcheck.?in\b/i,
  /\brecap\b/i,
  /^\s*reports?\s*$/i,     // whole-name match only — "Fake Review Report" survives
  /^\s*updates\s*$/i,      // whole-name match only
  /^\s*\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\s*$/,   // bare date "8/12"
  /^\s*\d{4}-\d{2}-\d{2}\s*$/,                         // bare ISO date
];

function isRecord(name) {
  return RECORD_FILTER_PATTERNS.some(p => p.test(name || ''));
}

// ─── Name normalization for cross-board dedup ─────────────────────────────────
// Lowercase → strip punctuation → strip trailing "ads"/"setup" →
// collapse gerunds (connecting→connect) → collapse plurals (forms→form).
// Used as dedup key only; display name is always the longer original string.
function normalizeName(raw) {
  let n = (raw || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  n = n.replace(/\s+ads$/, '').replace(/\s+setup$/, '').trim();
  n = n.replace(/\b([a-z]{4,})ing\b/g, '$1');   // gerund → base verb
  n = n.replace(/\b([a-z]{4,})s\b/g, '$1');     // plural → singular
  return n;
}

// ─── Board name normalization ──────────────────────────────────────────────────
const BOARD_ORDER = ['Ads', 'CRM', 'Video', 'Web + SEO']; // round-robin order

function canonicalBoard(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s === 'Web+SEO') return 'Web + SEO';
  return s;
}

// ─── Status → state mapping ───────────────────────────────────────────────────
// state is derived from Monday's Status column only, never from dates.
// Values are matched case-insensitively after trimming.
// Any value not in this map → 'unknown'.
// ⛔ in the item name always overrides to 'blocked' (blocked_reason: "name").
const STATUS_STATE_MAP = {
  '':              'queued',
  'start':         'queued',
  'in progress':   'live',
  'working on it': 'live',
  'working':       'live',
  'ongoing':       'live',
  'for review':    'review',
  'in review':     'review',
  'review':        'review',
  'pending':       'review',
  'stuck':         'blocked',
  'waiting':       'blocked',
  'done':          'done',
};

function deriveState(itemName, statusRaw) {
  // ⛔ in name takes priority over everything
  if ((itemName || '').includes('⛔')) {
    return { state: 'blocked', blocked_reason: 'name' };
  }
  const key = (statusRaw || '').trim().toLowerCase();
  const state = STATUS_STATE_MAP[key] ?? 'unknown';
  // blocked_reason records the actual Monday status word (e.g. "Stuck", "Waiting"), or "name" for ⛔
  const blocked_reason = (state === 'blocked') ? ((statusRaw || '').trim() || 'status') : null;
  return { state, blocked_reason };
}

// ─── Movement derivation — from dates only ────────────────────────────────────
// moved_7d:       last_movement ≤ 7 days ago
// slow_30d:       8–30 days ago
// stale_30d_plus: > 30 days or no date

function deriveMovement(lastMovIso) {
  if (!lastMovIso) return 'stale_30d_plus';
  const ms = Date.parse(String(lastMovIso).slice(0, 10));
  if (isNaN(ms)) return 'stale_30d_plus';
  const age = Math.round((TODAY_MS - ms) / 86400000);
  if (age <= 7)  return 'moved_7d';
  if (age <= 30) return 'slow_30d';
  return 'stale_30d_plus';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function pulseIdFromUrl(url) {
  const m = String(url || '').match(/\/pulses\/(\d+)/);
  return m ? m[1] : null;
}

function boardIdFromUrl(url) {
  const m = String(url || '').match(/\/boards\/(\d+)/);
  return m ? m[1] : null;
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const ms = Date.parse(String(isoDate).slice(0, 10));
  if (isNaN(ms)) return null;
  return Math.max(0, Math.round((TODAY_MS - ms) / 86400000));
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// ─── Load data ────────────────────────────────────────────────────────────────

const mondaySnap = readJSON(join(ROOT, 'site', 'monday-items.json'));
const inbox      = readJSON(join(ROOT, 'site', 'inbox.json')) || { by_client: {} };
const clients    = readJSON(join(ROOT, 'clients.json')) || [];

if (!mondaySnap) {
  console.warn('WARNING: site/monday-items.json not found — run write_monday_snapshot.py first. Workstreams will be empty.');
}

// Movement dates: item_id → most recent date string (ISO)
// Source: inbox latest_update.created_at (comms timestamps) only.
const movementByItemId = new Map();
for (const items of Object.values(inbox.by_client || {})) {
  for (const it of items) {
    const id = String(it.monday_item_id);
    const ts = it.latest_update?.created_at;
    if (ts) {
      const cur = movementByItemId.get(id);
      movementByItemId.set(id, maxDate(cur, ts));
    }
  }
}

// Owner: item_id → creator_name (only where is_ours = true, i.e. our team replied)
const ownerByItemId = new Map();
for (const items of Object.values(inbox.by_client || {})) {
  for (const it of items) {
    const lu = it.latest_update || {};
    if (lu.is_ours && lu.creator_name) {
      ownerByItemId.set(String(it.monday_item_id), lu.creator_name);
    }
  }
}

// Completed items indexed by pulse ID, for done_count per workstream item.
// Source: standups completed_this_week + completed_history.
const completedByItemId = {};

function ingestCompleted(items) {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (!it.monday_url || !it.date) continue;
    const pid = pulseIdFromUrl(it.monday_url);
    if (!pid) continue;
    (completedByItemId[pid] ??= []).push({ text: it.text || '', date: it.date });
    // Also feed into movement index (completion = movement)
    const cur = movementByItemId.get(pid);
    movementByItemId.set(pid, maxDate(cur, it.date));
  }
}

const standupDir = join(ROOT, 'standups');
for (const f of readdirSync(standupDir).sort()) {
  if (!/\.json$/.test(f)) continue;
  const sd = readJSON(join(standupDir, f));
  for (const entry of sd?.by_client || []) {
    ingestCompleted(entry.completed_this_week);
    for (const hw of entry.completed_history || []) ingestCompleted(hw.items);
  }
}

// Deduplicate completed entries by (date, text)
for (const pid of Object.keys(completedByItemId)) {
  const seen = new Set();
  completedByItemId[pid] = completedByItemId[pid].filter(it => {
    const k = `${it.date}||${it.text}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

// ─── Print distinct status values found in the snapshot ───────────────────────

const statusValuesSeen = new Map(); // raw value → count
if (mondaySnap) {
  for (const items of Object.values(mondaySnap.by_client || {})) {
    for (const it of items) {
      const v = (it.status ?? '(null)');
      statusValuesSeen.set(v, (statusValuesSeen.get(v) || 0) + 1);
      for (const sub of it.subitems || []) {
        const sv = (sub.status ?? '(null)');
        statusValuesSeen.set(sv, (statusValuesSeen.get(sv) || 0) + 1);
      }
    }
  }

  console.log('\nDistinct Monday status values found (items + subitems):\n');
  const sorted = [...statusValuesSeen.entries()].sort((a, b) => b[1] - a[1]);
  for (const [val, count] of sorted) {
    const key   = (val === '(null)') ? '' : val.trim().toLowerCase();
    const state = STATUS_STATE_MAP[key] ?? 'unknown';
    console.log(`  ${String(count).padStart(4)}×  ${String(val).padEnd(20)} → ${state}`);
  }
  console.log('');
}

// ─── Board-balanced cap ───────────────────────────────────────────────────────
// Tier order: blocked → review → live → everything else.
// Within each tier: board-balanced round-robin (BOARD_ORDER first, then others),
// most-recent-movement first per board.
// Returns { visible: workstream[], hiddenByBoard: {board: count} }.

const MOVEMENT_RANK = { moved_7d: 3, slow_30d: 2, stale_30d_plus: 1 };

function movSort(a, b) {
  const md = (MOVEMENT_RANK[b.movement] || 0) - (MOVEMENT_RANK[a.movement] || 0);
  if (md !== 0) return md;
  return (b.last_movement || '').localeCompare(a.last_movement || '');
}

function boardBalancedTier(items, maxSlots) {
  const byBoard = {};
  for (const w of items) {
    const board = (w.boards || [])[0] || 'Unknown';
    (byBoard[board] ??= []).push(w);
  }
  for (const arr of Object.values(byBoard)) arr.sort(movSort);

  const boardKeys = [
    ...BOARD_ORDER.filter(b => byBoard[b]),
    ...Object.keys(byBoard).filter(b => !BOARD_ORDER.includes(b)),
  ];
  const pointers = Object.fromEntries(boardKeys.map(b => [b, 0]));

  const visible = [];
  let slots = maxSlots;
  while (slots > 0) {
    let added = 0;
    for (const board of boardKeys) {
      if (slots <= 0) break;
      const p = pointers[board];
      if (p < byBoard[board].length) {
        visible.push(byBoard[board][p]);
        pointers[board]++;
        slots--;
        added++;
      }
    }
    if (!added) break;
  }
  return visible;
}

function boardBalancedCap(workstreams, maxTotal = 10) {
  const TIER_STATES = ['blocked', 'review', 'live'];
  const tiers = [
    workstreams.filter(w => w.state === 'blocked'),
    workstreams.filter(w => w.state === 'review'),
    workstreams.filter(w => w.state === 'live'),
    workstreams.filter(w => !TIER_STATES.includes(w.state)),
  ];

  const visible = [];
  for (const tier of tiers) {
    if (visible.length >= maxTotal) break;
    visible.push(...boardBalancedTier(tier, maxTotal - visible.length));
  }

  const visibleSet = new Set(visible.map(w => w._key));
  const hiddenByBoard = {};
  for (const w of workstreams) {
    if (!visibleSet.has(w._key)) {
      const b = (w.boards || [])[0] || 'Unknown';
      hiddenByBoard[b] = (hiddenByBoard[b] || 0) + 1;
    }
  }

  return { visible, hiddenByBoard };
}

// ─── Build workstreams for one Monday client name ─────────────────────────────

function buildWorkstreams(mondayName) {
  if (!mondaySnap) return [];

  const clientItems = mondaySnap.by_client[mondayName] || [];
  if (!clientItems.length) return [];

  const candidates = [];

  for (const item of clientItems) {
    if (isRecord(item.name)) continue;

    const idStr = String(item.monday_item_id);
    const board = canonicalBoard(item.board);

    // last_movement from inbox comms + standup completions (not from monday-items)
    let lastMovIso = movementByItemId.get(idStr) || null;
    for (const sub of item.subitems || []) {
      const subDate = movementByItemId.get(String(sub.monday_item_id));
      lastMovIso = maxDate(lastMovIso, subDate || null);
    }

    const doneCount    = (completedByItemId[idStr] || []).length;
    const subitemDone  = (item.subitems || []).filter(
      s => (s.status || '').trim().toLowerCase() === 'done'
    ).length;

    // Subitems that moved within the 7-day pulse window
    const recentSubs = (item.subitems || [])
      .filter(sub => !isRecord(sub.name))
      .map(sub => {
        const subMovIso = movementByItemId.get(String(sub.monday_item_id)) || null;
        const subAge    = daysSince(subMovIso);
        if (subAge == null || subAge > 7) return null;
        const { state: subState } = deriveState(sub.name, sub.status);
        return { name: sub.name, state: subState, age_days: subAge, url: sub.monday_url || null };
      })
      .filter(Boolean);
    recentSubs.sort((a, b) => {
      if (a.state === 'blocked' && b.state !== 'blocked') return -1;
      if (b.state === 'blocked' && a.state !== 'blocked') return 1;
      return (a.age_days ?? 999) - (b.age_days ?? 999);
    });
    if (recentSubs.length > 3) recentSubs.length = 3;

    const { state, blocked_reason } = deriveState(item.name, item.status);
    const movement = deriveMovement(lastMovIso);
    const normKey  = normalizeName(item.name);

    candidates.push({
      _key:          `${board}::${normKey}`,
      _normKey:      normKey,
      _lastMovIso:   lastMovIso,
      name:          item.name,
      boards:        [board],
      state,
      blocked_reason,
      movement,
      owner:         ownerByItemId.get(idStr) || null,
      item_id:       item.monday_item_id || null,
      board_id:      boardIdFromUrl(item.monday_url),
      url:           item.monday_url || null,
      item_count:    1,
      subitem_count: (item.subitems || []).length,
      subitem_done:  subitemDone,
      done_count:    doneCount,
      last_movement: lastMovIso ? String(lastMovIso).slice(0, 10) : null,
      age_days:      daysSince(lastMovIso),
      recent:        recentSubs,
      basis: { type: 'observed', source: 'site/monday-items.json + standups', window: 'current' },
    });
  }

  // Cross-board dedup: normalize names; merge items with same key, keeping longer name
  const byNormKey = new Map();
  for (const c of candidates) {
    const key = c._normKey;
    if (!byNormKey.has(key)) {
      byNormKey.set(key, { ...c });
      continue;
    }
    const ex = byNormKey.get(key);
    if (c.name.length > ex.name.length) {
      ex.name     = c.name;
      ex.item_id  = c.item_id;
      ex.board_id = c.board_id;
      ex.url      = c.url;
    }
    for (const b of c.boards) if (!ex.boards.includes(b)) ex.boards.push(b);
    ex._key = `${ex.boards[0]}::${key}`;  // rekey to first board
    ex.item_count    += c.item_count;
    ex.subitem_count += c.subitem_count;
    ex.subitem_done  += c.subitem_done;
    ex.done_count    += c.done_count;
    const seenSubUrls = new Set((ex.recent || []).map(r => r.url).filter(Boolean));
    for (const r of c.recent || []) {
      if (r.url && seenSubUrls.has(r.url)) continue;
      if (r.url) seenSubUrls.add(r.url);
      (ex.recent ??= []).push(r);
    }
    ex.recent.sort((a, b) => {
      if (a.state === 'blocked' && b.state !== 'blocked') return -1;
      if (b.state === 'blocked' && a.state !== 'blocked') return 1;
      return (a.age_days ?? 999) - (b.age_days ?? 999);
    });
    if (ex.recent.length > 3) ex.recent.length = 3;
    if (c._lastMovIso && c._lastMovIso > (ex._lastMovIso || '')) {
      ex._lastMovIso  = c._lastMovIso;
      ex.last_movement = c.last_movement;
      ex.age_days      = c.age_days;
      ex.movement      = c.movement;
      ex.owner         = c.owner;
    }
    const rank = { blocked: 4, review: 3, live: 2, done: 1, queued: 0, unknown: 0 };
    if ((rank[c.state] || 0) > (rank[ex.state] || 0)) {
      ex.state         = c.state;
      ex.blocked_reason = c.blocked_reason;
    }
  }

  return [...byNormKey.values()];
}

// ─── Manual overrides ─────────────────────────────────────────────────────────
// workstreams/[slug].manual.json:
//   { "overrides": [{ "match": "<name>", "rename": "...", "state": "...", ... }],
//     "add":       [{ "name": "...", "boards": [...], "state": "...", ... }] }
// Manual entries win outright.

function applyManual(workstreams, slug) {
  const manual = readJSON(join(WORKSTREAMS_DIR, `${slug}.manual.json`));
  if (!manual) return workstreams;

  let result = [...workstreams];
  for (const ov of manual.overrides || []) {
    const idx = result.findIndex(w => w.name === ov.match);
    if (idx < 0) continue;
    const { match: _, rename, ...rest } = ov;
    result[idx] = { ...result[idx], ...rest };
    if (rename) result[idx].name = rename;
  }
  for (const add of manual.add || []) {
    const ei = result.findIndex(w => w.name === add.name);
    if (ei >= 0) result.splice(ei, 1);
    result.unshift({ _key: `manual::${add.name}`, ...add });
  }
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!existsSync(WORKSTREAMS_DIR)) mkdirSync(WORKSTREAMS_DIR, { recursive: true });

const activeClients = clients.filter(c => c.active !== false);
const tableRows     = [];

for (const client of activeClients) {
  const mondayName = SLUG_TO_MONDAY[client.slug];
  const raw        = mondayName ? buildWorkstreams(mondayName) : [];
  const withManual = applyManual(raw, client.slug);

  const { visible, hiddenByBoard } = boardBalancedCap(withManual, 10);

  // Strip internal keys before writing
  const cleanWorkstreams = visible.map(({ _key, _normKey, _lastMovIso, ...w }) => w);
  const totalHidden = Object.values(hiddenByBoard).reduce((s, n) => s + n, 0);

  writeFileSync(
    join(WORKSTREAMS_DIR, `${client.slug}.json`),
    JSON.stringify({
      slug:             client.slug,
      generated_at:     new Date().toISOString(),
      workstream_count: visible.length,
      hidden_count:     totalHidden,
      hidden_by_board:  hiddenByBoard,
      workstreams:      cleanWorkstreams,
    }, null, 2)
  );

  tableRows.push({ name: client.name, workstreams: visible, hiddenByBoard });
}

// ─── Print table ──────────────────────────────────────────────────────────────

for (const row of tableRows) {
  const totalHidden = Object.values(row.hiddenByBoard).reduce((s, n) => s + n, 0);
  const hiddenStr   = totalHidden
    ? '  hidden: ' + Object.entries(row.hiddenByBoard).map(([b, n]) => `${b}=${n}`).join(', ')
    : '';
  console.log(`${row.name}  —  ${row.workstreams.length} workstream${row.workstreams.length !== 1 ? 's' : ''}${hiddenStr}`);
  if (!row.workstreams.length) {
    console.log('  (none)');
  } else {
    for (const w of row.workstreams) {
      const { _key, _normKey, _lastMovIso, ...clean } = w;
      const boards = (clean.boards || []).join(', ');
      const br     = clean.blocked_reason ? ` blocked_reason=${clean.blocked_reason}` : '';
      console.log(
        `  · ${clean.name.padEnd(44)} ${clean.state.padEnd(10)} ${clean.movement}${br}  [${boards}]`
      );
    }
  }
  console.log('');
}
