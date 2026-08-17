// extract_timeline.js — converts playbooks/[slug].md into timeline/[slug].plan.json
//
// For each playbooks/[slug].md whose sha256 differs from source_hash in
// timeline/[slug].plan.json, calls the Anthropic API (forced tool emit_plan)
// to extract a structured engagement plan. Skips inactive clients.
// Zero changed playbooks = zero API calls.
//
// Runs after sync_playbooks.py, before build_timeline.js in daily-pulse.yml.
// Env: ANTHROPIC_API_KEY (required for extraction; without it, skips gracefully)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL   = 'claude-sonnet-4-6';

// slugs to skip (inactive clients and the three steel sub-slugs — timeline
// lives at steel-round-bars, not the per-pulse slugs)
const INACTIVE = new Set(
  CLIENTS.filter(c => c.active === false).map(c => c.slug)
);
const STEEL_SUB_SLUGS = new Set(['steel-forte', 'steel-advance', 'steel-ohare']);

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// ── emit_plan tool ────────────────────────────────────────────────────────────

const EMIT_PLAN = {
  name: 'emit_plan',
  description: 'Emit the structured engagement plan extracted from the playbook.',
  input_schema: {
    type: 'object',
    required: ['departments', 'milestones', 'engagement'],
    properties: {
      departments: {
        type: 'array',
        description: 'One entry per department section in the playbook.',
        items: {
          type: 'object',
          required: ['dept', 'bars'],
          properties: {
            dept: { type: 'string' },
            bars: {
              type: 'array',
              items: {
                type: 'object',
                required: ['label', 'start', 'end'],
                properties: {
                  label:     { type: 'string' },
                  start:     { type: 'string', description: 'ISO date YYYY-MM-DD' },
                  end:       { type: 'string', description: 'ISO date YYYY-MM-DD' },
                  inferred:  { type: 'boolean', description: 'true when dates were inferred, not stated' },
                },
              },
            },
          },
        },
      },
      milestones: {
        type: 'array',
        items: {
          type: 'object',
          required: ['date', 'label', 'dept'],
          properties: {
            date:  { type: 'string', description: 'ISO date YYYY-MM-DD' },
            label: { type: 'string' },
            dept:  { type: 'string' },
          },
        },
      },
      engagement: {
        type: 'object',
        required: ['start', 'end'],
        properties: {
          start: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          end:   { type: 'string', description: 'ISO date YYYY-MM-DD' },
        },
      },
    },
  },
};

// ── prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(slug, playbook) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are extracting a structured project plan from a client playbook for use in a Gantt-style timeline.

Client slug: ${slug}
Today: ${today}

## Notation guide (used in these playbooks)
- ✓  = completed. STILL extract as a plan bar — it shows when that work phase happened.
- ●  = in flight / open. Extract as a current or upcoming plan bar.
- ⛔ = blocker. Extract as a plan bar; note it is blocked in the label if space allows.
- "▸ Name · Month N–M" or "▸ Name · Months N–M (MonAbbr)" are work tracks = bars.
  Convert month numbers to ISO dates using the engagement window at the top of the playbook.
  E.g. engagement May–Oct 2026 → Month 5 = 2026-08-01, Month 7 = 2026-10-31.
- "## Department" or bold "**Department**" lines define dept names.
- A "Sequence at a glance" table at the bottom is authoritative for milestone dates.

Rules:
- Extract EVERY named ▸ work track as a bar, whether marked ✓, ●, or ⛔. Do not skip completed tracks — they belong on the timeline.
- Derive bar start/end from the month range in the track header line. Use inferred: true when the dates are derived rather than explicitly stated.
- Never invent items not in the document.
- engagement.start and engagement.end are the overall engagement dates stated at the top of the playbook.
- Milestones are named deliverables with a specific due date (launch, go-live, approval). Pull from the "Sequence at a glance" table or explicit deadline text.
- Keep labels concise (≤8 words).
- If the playbook contains no usable date information at all, return empty arrays and set engagement to today ± 90 days.

PLAYBOOK:
${playbook}`;
}

// ── API call ──────────────────────────────────────────────────────────────────

async function callExtract(slug, playbook) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  2000,
      tools:       [EMIT_PLAN],
      tool_choice: { type: 'tool', name: 'emit_plan' },
      messages:    [{ role: 'user', content: buildPrompt(slug, playbook) }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data    = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('no tool_use block in response');
  return toolUse.input;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Extract timeline plans ===');

  if (!existsSync('playbooks')) {
    console.log('  playbooks/ does not exist — nothing to extract');
    return;
  }
  if (!existsSync('timeline')) mkdirSync('timeline');

  const playbooks = readdirSync('playbooks')
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''));

  if (!playbooks.length) {
    console.log('  No playbooks found — skipping');
    return;
  }

  let extracted = 0, skipped = 0, unchanged = 0;

  for (const slug of playbooks) {
    // Skip inactive and steel sub-slugs.
    if (INACTIVE.has(slug) || STEEL_SUB_SLUGS.has(slug)) {
      console.log(`  ${slug}: skipped (${INACTIVE.has(slug) ? 'inactive' : 'steel sub-slug'})`);
      skipped++;
      continue;
    }

    const playbookText = readFileSync(`playbooks/${slug}.md`, 'utf8');
    const newHash      = sha256(playbookText);
    const planPath     = `timeline/${slug}.plan.json`;
    const existing     = readJSON(planPath);

    if (existing?.source_hash === newHash) {
      console.log(`  ${slug}: unchanged`);
      unchanged++;
      continue;
    }

    if (!API_KEY) {
      console.log(`  ${slug}: ANTHROPIC_API_KEY not set — skipping extraction`);
      skipped++;
      continue;
    }

    try {
      console.log(`  ${slug}: extracting…`);
      const plan = await callExtract(slug, playbookText);
      writeFileSync(planPath, JSON.stringify({
        source_hash:  newHash,
        extracted_at: new Date().toISOString(),
        ...plan,
      }, null, 2));
      console.log(`  ${slug}: ✓ ${plan.departments?.length ?? 0} depts, ${plan.milestones?.length ?? 0} milestones`);
      extracted++;
    } catch (err) {
      console.error(`  ${slug}: extraction failed — ${err.message}`);
      skipped++;
    }
  }

  console.log(`\nDone: ${extracted} extracted, ${unchanged} unchanged, ${skipped} skipped.`);
}

main();
