// apply_ops_pulse.js — applies the CLIENT BRIEF section of lenses/ops-pulse.md.
//
// Reads standups/latest.json for per-client ops data, calls Claude once per
// client, writes a `brief` key into pulse/[slug].json (creates a minimal stub
// when no pulse file exists yet, e.g. for MedStation).
//
// Runs daily after generate.py.
//
// Env:
//   ANTHROPIC_API_KEY   required to generate; without it, skips all
//   FORCE_OPS_PULSE=1   regenerate every client even if brief is current
//   SLUG_FILTER=<slug>  process only this slug (works with real key or DRY_RUN)
//   DRY_RUN=<slug>      print prompt for that slug only; no API call
//   DRY_RUN=1           print prompts for all clients; no API call

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');

const API_KEY      = process.env.ANTHROPIC_API_KEY || '';
const FORCE        = process.env.FORCE_OPS_PULSE === '1';
const SLUG_FILTER  = process.env.SLUG_FILTER || '';
const DRY_RUN_VAL  = process.env.DRY_RUN || '';
const DRY_RUN      = !!DRY_RUN_VAL;
const DRY_RUN_SLUG = DRY_RUN_VAL !== '1' ? DRY_RUN_VAL : null;
const MODEL        = 'claude-sonnet-4-6';

// ── slug resolution ────────────────────────────────────────────────────────────
// Standup cards use display names; map to slugs used for pulse/[slug].json.

const NAME_SLUG_MAP = new Map([
  ...CLIENTS.map(c => [c.name.toLowerCase(), c.slug]),
  ['quality hvac', 'hvac'],
  ['maadi law', 'maadi-law'],
  ['steel round bars', 'steel-round-bars'],
  ['medstation', 'medstation'],
]);

function findSlug(displayName) {
  const key = displayName.toLowerCase();
  if (NAME_SLUG_MAP.has(key)) return NAME_SLUG_MAP.get(key);
  return key.replace(/[',&.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── forced tool ────────────────────────────────────────────────────────────────

const EMIT_BRIEF = {
  name: 'emit_brief',
  description: 'Emit the structured client brief per ops-pulse.md CLIENT BRIEF rules.',
  input_schema: {
    type: 'object',
    required: ['date', 'headlines', 'workstreams', 'waiting_on_client', 'brief_v2'],
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      headlines: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'tone'],
          properties: {
            text: { type: 'string', description: 'Max 8 words.' },
            tone: { type: 'string', enum: ['win', 'info', 'shift'] },
          },
        },
      },
      workstreams: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'badge', 'items'],
          properties: {
            title: { type: 'string' },
            badge: {
              type: 'object',
              required: ['label', 'tone'],
              properties: {
                label: { type: 'string', description: 'e.g. "P1 - blocked"' },
                tone: { type: 'string', enum: ['red', 'amber', 'green', 'purple'] },
              },
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['state', 'text'],
                properties: {
                  state: { type: 'string', enum: ['blocked', 'done', 'next', 'queued'] },
                  text: { type: 'string' },
                },
              },
            },
            owners: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      waiting_on_client: {
        type: 'array',
        items: {
          type: 'object',
          required: ['item', 'who', 'since'],
          properties: {
            item:  { type: 'string' },
            who:   { type: 'string' },
            since: { type: 'string', description: 'M/D format' },
          },
        },
      },
      launch_gate: {
        anyOf: [
          {
            type: 'object',
            required: ['title', 'items'],
            properties: {
              title: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['text', 'done'],
                  properties: {
                    text: { type: 'string' },
                    done: { type: 'boolean' },
                  },
                },
              },
              note: { type: 'string' },
            },
          },
          { type: 'null' },
        ],
      },
      brief_v2: {
        type: 'object',
        required: ['verdict', 'next_move', 'blocks', 'snapshot', 'history_line'],
        properties: {
          verdict:    { type: 'string', description: 'One sentence ≤20 words. Anchor on what is actually moving or actually awaiting a reply this week. Never mention day counts or "stalled N days".' },
          next_move:  { type: 'string', description: 'One action ≤20 words. Format: "Owner: task — why it unblocks." Reference a live thread or an item with recent activity — never a dormant item.' },
          blocks: {
            type: 'array',
            description: 'Open loops with CURRENT ACTIVITY. Include a loop only if at least one is true: (1) the standup card names it in highlights or stalled_items this week, (2) the Monday item has recent comms in its thread, or (3) it has an active Monday status. Age alone does NOT qualify. Silent items with no recent comms are background noise — omit them. Empty array when nothing is blocked with real activity.',
            items: {
              type: 'object',
              required: ['item', 'side', 'who', 'last_activity'],
              properties: {
                item:          { type: 'string', description: 'Cite the Monday item name or the comms thread. Never invent.' },
                side:          { type: 'string', enum: ['you', 'team', 'client'], description: '"you" = Sohib specifically. "team" = another Flow teammate. "client" = client-side contact.' },
                who:           { type: 'string', description: 'Person name, or role if unnamed.' },
                last_activity: { type: 'string', description: 'What most recently happened on this loop: the latest comms line, the latest Monday update, or the this-week standup card mention. One short line, ≤14 words. Never a bare day count like "8d stalled".' },
              },
            },
          },
          snapshot: {
            type: 'array',
            description: '3–5 header rows. Attempt in order: Open items, Contract, Last client word, Judged on, Month to date. SKIP any row whose source data is missing — never invent contract terms or targets. Honest-gaps rule: absence is stated by omitting the row, never by placeholder text.',
            items: {
              type: 'object',
              required: ['label', 'value', 'tone'],
              properties: {
                label: { type: 'string', description: 'One of: "Open items", "Contract", "Last client word", "Judged on", "Month to date".' },
                value: { type: 'string', description: 'One sentence.' },
                tone:  { type: 'string', enum: ['ok', 'warn', 'bad', 'plain', 'muted'] },
              },
            },
          },
          history_line: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Up to 3 items from completed_this_week joined with " · " (space, middle-dot, space). Null when the week has no completions. Never include anything not in completed_this_week.',
          },
        },
      },
    },
  },
};

// ── helpers ────────────────────────────────────────────────────────────────────

function loadStandup() {
  const p = 'standups/latest.json';
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadPlaybook(slug) {
  const p = `playbooks/${slug}.md`;
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').slice(0, 2000);
}

function buildPrompt(lens, card, playbook, today) {
  const filled = lens
    .replaceAll('{today}', today)
    .replaceAll('{client}', card.client);

  const parts = [filled];

  if (playbook) {
    parts.push('\n## CLIENT PLAYBOOK (context only)\n' + playbook);
  }

  parts.push('\n## STANDUP CARD\n');
  parts.push(JSON.stringify({
    date:                today,
    headline:            card.headline,
    health:              card.health,
    work_by_department:  card.work_by_department,
    completed_this_week: card.completed_this_week,
    upcoming:            card.upcoming,
    stats:               card.stats,
  }, null, 2));

  return parts.join('\n');
}

async function callLens(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  1500,
      tools:       [EMIT_BRIEF],
      tool_choice: { type: 'tool', name: 'emit_brief' },
      messages:    [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data    = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('no tool_use block in response');
  return toolUse.input;
}

function isBriefFresh(pulse, today) {
  return !FORCE && pulse.brief?.date === today;
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Apply ops-pulse brief ===');

  const lensPath = 'lenses/ops-pulse.md';
  if (!existsSync(lensPath)) { console.error('lenses/ops-pulse.md missing'); process.exit(1); }
  const lens = readFileSync(lensPath, 'utf8');

  const standup = loadStandup();
  if (!standup) { console.error('standups/latest.json missing'); process.exit(1); }

  const today = new Date().toISOString().slice(0, 10);
  const cards = standup.by_client || [];

  let generated = 0, skipped = 0;

  for (const card of cards) {
    const slug = findSlug(card.client);

    if (SLUG_FILTER && slug !== SLUG_FILTER) { skipped++; continue; }

    // DRY_RUN: build and print the prompt, no API call.
    if (DRY_RUN) {
      if (DRY_RUN_SLUG && slug !== DRY_RUN_SLUG) { skipped++; continue; }
      const playbook = loadPlaybook(slug);
      const prompt   = buildPrompt(lens, card, playbook, today);
      console.log(`\n${'═'.repeat(64)}`);
      console.log(`DRY RUN — ${slug} (${card.client})`);
      console.log(`${'═'.repeat(64)}\n`);
      console.log(prompt);
      console.log(`\n${'═'.repeat(64)}\nEND — ${slug}\n`);
      skipped++;
      continue;
    }

    if (!API_KEY) { console.log(`  ${slug}: skipped — ANTHROPIC_API_KEY not set`); skipped++; continue; }

    const pulsePath = `pulse/${slug}.json`;
    let pulse = existsSync(pulsePath)
      ? JSON.parse(readFileSync(pulsePath, 'utf8'))
      : { generated_at: new Date().toISOString(), date: today, slug, name: card.client };

    if (isBriefFresh(pulse, today)) {
      console.log(`  ${slug}: brief already current — skipping`);
      skipped++;
      continue;
    }

    const playbook = loadPlaybook(slug);

    try {
      const prompt = buildPrompt(lens, card, playbook, today);
      const brief      = await callLens(prompt);
      pulse.brief      = brief;
      pulse.brief_v2   = brief.brief_v2 || null;
      writeFileSync(pulsePath, JSON.stringify(pulse, null, 2));
      console.log(`  ${slug}: ✓ brief written`);
      generated++;
    } catch (err) {
      console.error(`  ${slug}: failed — ${err.message}`);
      skipped++;
    }
  }

  console.log(`\nDone: ${generated} generated, ${skipped} skipped.`);
}

main();
