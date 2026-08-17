// apply_task_matching.js — matches plan tasks to Monday items via Claude tool call.
//
// For each client with playbooks/[slug].md AND timeline/[slug].plan.json:
//   Flattens plan tasks (bars + milestones) and gathers Monday items with subitems
//   from standups/latest.json + site/inbox.json (the same data build_timeline reads).
//   Calls Claude once with forced tool emit_matches. Writes timeline/[slug].matches.json.
//
// build_timeline.js prefers these lens matches over token matches when present.
//
// Idempotency: skip if matches.json is newer than plan.json AND standups/latest.json.
//
// Env: ANTHROPIC_API_KEY     required
//      FORCE_TASK_MATCHING=1 bypass idempotency
//      SLUG_FILTER=<slug>    restrict to one slug
//      DRY_RUN=1             print prompt(s); no API call

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { createRequire } from 'module';

// Match on the substring of a Monday completion note: "Marked Done on Monday: <name>"
const DONE_NOTE_RE = /Marked Done on Monday:\s*(.+?)\s*$/i;
const PULSE_ID_RE  = /\/pulses\/(\d+)/;

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');

const API_KEY     = process.env.ANTHROPIC_API_KEY || '';
const FORCE       = process.env.FORCE_TASK_MATCHING === '1';
const SLUG_FILTER = process.env.SLUG_FILTER || '';
const DRY_RUN     = process.env.DRY_RUN === '1';
const MODEL       = 'claude-sonnet-4-6';

const INACTIVE = new Set(CLIENTS.filter(c => c.active === false).map(c => c.slug));
const STEEL_SUB_SLUGS = new Set(['steel-forte', 'steel-advance', 'steel-ohare']);

const SLUG_STANDUP_NAMES = {
  'steel-round-bars': ['Steel Round Bars', 'Forte Metals', 'Advance Grinding', "O'Hare Precision"],
};
for (const c of CLIENTS) {
  if (!SLUG_STANDUP_NAMES[c.slug]) SLUG_STANDUP_NAMES[c.slug] = [c.name];
}

// ── forced tool ───────────────────────────────────────────────────────────────

const EMIT_MATCHES = {
  name: 'emit_matches',
  description: 'Emit matches from plan tasks to Monday items or subitems (or null when nothing corresponds).',
  input_schema: {
    type: 'object',
    required: ['matches'],
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          required: ['plan_task_id', 'monday_item_id', 'confidence'],
          properties: {
            plan_task_id:   { type: 'string' },
            monday_item_id: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
              description: 'Monday item ID (parent or subitem) or null when nothing corresponds.',
            },
            confidence: { type: 'string', enum: ['high', 'medium'] },
          },
        },
      },
    },
  },
};

// ── helpers ───────────────────────────────────────────────────────────────────

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function mtime(p)    { try { return statSync(p).mtimeMs; } catch { return 0; } }

function clientMatches(clientName, standupNames) {
  const cn = (clientName || '').toLowerCase();
  return standupNames.some(n => {
    const sn = n.toLowerCase();
    return cn.includes(sn) || sn.includes(cn);
  });
}

function extractMondayId(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') return String(raw);
  const m = String(raw).match(/\[id:\s*(\d+)\]/);
  return m ? m[1] : (String(raw).match(/^\d+$/) ? String(raw) : null);
}

// Plan task id keeps the RAW playbook dept + raw label so build_timeline.js
// can rebuild the same key from the plan file (no normalization on either side).
function planTaskId(dept, label) {
  return `${dept}::${label}`;
}

function flattenPlanTasks(plan) {
  const tasks = [];
  const seen  = new Set();
  for (const d of plan.departments || []) {
    for (const bar of d.bars || []) {
      const id = planTaskId(d.dept, bar.label);
      if (seen.has(id)) continue;
      seen.add(id);
      tasks.push({ id, label: bar.label, dept: d.dept, source: 'bar' });
    }
  }
  for (const m of plan.milestones || []) {
    const id = planTaskId(m.dept, m.label);
    if (seen.has(id)) continue;
    seen.add(id);
    tasks.push({ id, label: m.label, dept: m.dept, source: 'milestone', date: m.date });
  }
  return tasks;
}

// Scans standups/*.json for "Marked Done on Monday: <name>" entries for this
// client. Returns [{monday_item_id?, name, board?}]. Catches done items that
// left the inbox once resolved.
function collectDoneFromStandupHistory(standupNames) {
  const out = [];
  const seen = new Set();
  if (!existsSync('standups')) return out;

  for (const f of readdirSync('standups')) {
    if (!f.endsWith('.json')) continue;
    const data = readJSON(`standups/${f}`);
    if (!data?.by_client) continue;
    for (const c of data.by_client) {
      if (!clientMatches(c.client, standupNames)) continue;
      const pools = [
        ...(c.completed_this_week || []),
        ...(c.completed_history || []).flatMap(b => b.items || []),
      ];
      for (const item of pools) {
        const txt = item.text || '';
        const m   = txt.match(DONE_NOTE_RE);
        if (!m) continue;
        const name = m[1].trim();
        let id     = null;
        const url  = item.monday_url || '';
        const um   = url.match(PULSE_ID_RE);
        if (um) id = um[1];
        const key = id || `n:${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ monday_item_id: id, name, board: null });
      }
    }
  }
  return out;
}

// Assemble Monday items for a slug. Preference order:
//   1) site/monday-items.json — full snapshot (parents + subitems + statuses,
//      including Done items). Written by generate.py.
//   2) Fallback: standups/latest.json parents + site/inbox.json parents/subitems
//      + standups history "Marked Done on Monday" entries (partial done coverage).
function collectMondayItems(slug) {
  const standupNames = SLUG_STANDUP_NAMES[slug] || [slug];

  // Path 1: full snapshot.
  const snapshot = readJSON('site/monday-items.json');
  if (snapshot?.by_client) {
    for (const [clientName, items] of Object.entries(snapshot.by_client)) {
      if (!clientMatches(clientName, standupNames)) continue;
      return items.map(it => ({
        monday_item_id: String(it.monday_item_id || ''),
        name:           it.name || '',
        department:     it.board || 'Ops',
        status:         it.status || '',
        subitems: (it.subitems || []).map(s => ({
          monday_item_id: String(s.monday_item_id || ''),
          name:           s.name || '',
          department:     s.board || it.board || 'Ops',
          status:         s.status || '',
        })),
      }));
    }
  }

  // Path 2: fallback assembly.
  const latest = readJSON('standups/latest.json');
  const inbox  = readJSON('site/inbox.json');

  const byId = new Map();

  function ensureParent(id, fields) {
    if (!byId.has(id)) {
      byId.set(id, {
        monday_item_id: id,
        name:           fields.name || '',
        department:     fields.department || 'Ops',
        status:         fields.status || '',
        subitems:       [],
      });
    } else {
      const p = byId.get(id);
      if (!p.name || p.name === '(unknown parent)') p.name = fields.name || p.name;
      if (!p.status && fields.status) p.status = fields.status;
    }
    return byId.get(id);
  }

  // standup work_by_department parents (only source with days_stalled).
  if (latest?.by_client) {
    for (const c of latest.by_client) {
      if (!clientMatches(c.client, standupNames)) continue;
      for (const d of c.work_by_department || []) {
        for (const item of [...(d.highlights || []), ...(d.stalled_items || [])]) {
          const id = extractMondayId(item.monday_item_id);
          if (!id) continue;
          const status = item.days_stalled > 0 ? `stalled ${item.days_stalled}d` : 'active';
          ensureParent(id, {
            name:       item.item_name || item.text || '',
            department: d.department || 'Ops',
            status,
          });
        }
      }
    }
  }

  // inbox parents + subitems.
  if (inbox?.by_client) {
    const clientItems = [];
    for (const [clientName, items] of Object.entries(inbox.by_client)) {
      if (!clientMatches(clientName, standupNames)) continue;
      if (Array.isArray(items)) clientItems.push(...items);
    }

    for (const ix of clientItems) {
      const id  = String(ix.monday_item_id || '');
      const pid = ix.parent_item_id ? String(ix.parent_item_id) : null;
      if (!id || pid) continue;
      ensureParent(id, {
        name:       ix.item_name || '',
        department: ix.board || 'Ops',
        status:     ix.state_label || ix.state || '',
      });
    }

    for (const ix of clientItems) {
      const id  = String(ix.monday_item_id || '');
      const pid = ix.parent_item_id ? String(ix.parent_item_id) : null;
      if (!id || !pid) continue;
      const parent = ensureParent(pid, { name: '(unknown parent)', department: ix.board || 'Ops' });
      parent.subitems.push({
        monday_item_id: id,
        name:           ix.item_name || '',
        department:     ix.board || 'Ops',
        status:         ix.state_label || ix.state || '',
      });
    }
  }

  // Widen with historically-done items — items that were "Marked Done on Monday"
  // in some standup and have since left the inbox. Matching needs full history.
  // Only include items with a real monday_item_id (parseable from monday_url);
  // name-only completion notes can't be resolved back downstream.
  for (const d of collectDoneFromStandupHistory(standupNames)) {
    if (!d.monday_item_id) continue;
    ensureParent(d.monday_item_id, {
      name: d.name, department: d.board || 'Ops', status: 'Done',
    });
    byId.get(d.monday_item_id).status = 'Done';
  }

  return [...byId.values()];
}

function buildPrompt(slug, planTasks, mondayItems) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are matching plan tasks from a client engagement playbook to Monday.com items and subitems currently on the boards.

Client slug: ${slug}
Today: ${today}

## Rules
- Match on meaning, not exact wording. A plan task about "Retargeting list build" matches a Monday item "Retargeting audiences".
- A plan task may match either a parent item OR one of its subitems — subitems are often the actual delivery unit.
- Never force a match. If no Monday item or subitem clearly corresponds, return monday_item_id: null.
- confidence "high": the semantic overlap is unambiguous. "medium": plausible but the labels leave room for doubt.
- Every plan_task_id from the input list must appear in the output exactly once. Do not repeat or omit any.

## PLAN TASKS
${JSON.stringify(planTasks.map(t => ({ id: t.id, label: t.label, dept: t.dept })), null, 2)}

## MONDAY ITEMS (parents with subitems)
${JSON.stringify(mondayItems, null, 2)}`;
}

async function callMatch(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  4000,
      temperature: 0,
      tools:       [EMIT_MATCHES],
      tool_choice: { type: 'tool', name: 'emit_matches' },
      messages:    [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data    = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('no tool_use block in response');
  return toolUse.input;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Apply task matching ===');

  if (!existsSync('timeline')) {
    console.log('  timeline/ missing — nothing to match');
    return;
  }

  const standupsMtime = mtime('standups/latest.json');
  const planFiles = readdirSync('timeline').filter(f => f.endsWith('.plan.json'));
  if (!planFiles.length) {
    console.log('  no plan files — skipping');
    return;
  }

  let generated = 0, skipped = 0;

  for (const planFile of planFiles) {
    const slug = planFile.replace('.plan.json', '');
    if (INACTIVE.has(slug) || STEEL_SUB_SLUGS.has(slug)) { skipped++; continue; }
    if (SLUG_FILTER && slug !== SLUG_FILTER)              { skipped++; continue; }
    if (!existsSync(`playbooks/${slug}.md`))              { skipped++; continue; }

    const planPath   = `timeline/${planFile}`;
    const matchPath  = `timeline/${slug}.matches.json`;
    const planMtime  = mtime(planPath);
    const matchMtime = mtime(matchPath);

    if (!FORCE && matchMtime > 0 && matchMtime > planMtime && matchMtime > standupsMtime) {
      console.log(`  ${slug}: matches current — skipping`);
      skipped++;
      continue;
    }

    const plan = readJSON(planPath);
    if (!plan) { skipped++; continue; }

    const planTasks   = flattenPlanTasks(plan);
    const mondayItems = collectMondayItems(slug);
    if (!planTasks.length) {
      console.log(`  ${slug}: no plan tasks`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`\n── ${slug} — DRY RUN ──`);
      console.log(buildPrompt(slug, planTasks, mondayItems));
      skipped++;
      continue;
    }

    if (!API_KEY) {
      console.log(`  ${slug}: skipped — ANTHROPIC_API_KEY not set`);
      skipped++;
      continue;
    }

    try {
      const prompt  = buildPrompt(slug, planTasks, mondayItems);
      const result  = await callMatch(prompt);
      const matches = (result.matches || []).filter(m => m && m.plan_task_id);

      const highN = matches.filter(m => m.confidence === 'high'   && m.monday_item_id).length;
      const medN  = matches.filter(m => m.confidence === 'medium' && m.monday_item_id).length;
      const nullN = matches.filter(m => !m.monday_item_id).length;

      writeFileSync(matchPath, JSON.stringify({
        generated_at:     new Date().toISOString(),
        slug,
        plan_source_hash: plan.source_hash || null,
        plan_task_count:  planTasks.length,
        monday_item_count: mondayItems.length,
        matches,
      }, null, 2));
      console.log(`  ${slug}: ✓ ${matches.length} tasks — ${highN} high, ${medN} medium, ${nullN} null`);
      generated++;
    } catch (err) {
      console.error(`  ${slug}: failed — ${err.message}`);
      skipped++;
    }
  }

  console.log(`\nDone: ${generated} generated, ${skipped} skipped.`);
}

main();
