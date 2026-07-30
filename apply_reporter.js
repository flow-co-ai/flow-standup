// apply_reporter.js — applies lenses/reporter.md to each active client.
//
// Weekly cadence: runs on Mondays (or FORCE_REPORTER=1). Off-cadence days
// carry the previous report forward with { stale: true } so the page never
// goes blank.
//
// Per client: reads pulse/[slug].json (28-day numbers + latest performance
// block, used even when stale: true) and timeline/[slug].plan.json
// milestones if present.
//
// Steel special-case: REPORT_GROUPS merges multiple client slugs into one
// output report. While per-entity pulse files don't exist, the group falls
// back to pulse/[output].json (the current umbrella file).
//
// Writes reports/[slug].json.
//
// Env:
//   ANTHROPIC_API_KEY   required to generate; without it, carry-forward only
//   FORCE_REPORTER=1    run every client regardless of day
//   DRY_RUN=1           build + print all prompts, no API call
//   DRY_RUN=<slug>      build + print prompt for that slug only, no API call

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');

const API_KEY     = process.env.ANTHROPIC_API_KEY || '';
const FORCE       = process.env.FORCE_REPORTER === '1';
const DRY_RUN_VAL = process.env.DRY_RUN || '';
const DRY_RUN     = !!DRY_RUN_VAL;
const DRY_RUN_SLUG = DRY_RUN_VAL !== '1' ? DRY_RUN_VAL : null; // null = all
const MODEL       = 'claude-sonnet-4-6';

// Groups: multiple client slugs → one combined output report.
// Members with no pulse file are skipped; if none exist, falls back to
// pulse/[output].json (the umbrella file) so the report always has data.
const REPORT_GROUPS = [
  {
    output:  'steel-round-bars',
    name:    'Steel Round Bars',
    members: ['steel-forte', 'steel-advance', 'steel-ohare'],
  },
];

// Fast lookup sets built from REPORT_GROUPS.
const GROUP_MEMBER_SLUGS = new Set(REPORT_GROUPS.flatMap(g => g.members));
const GROUP_OUTPUT_SLUGS = new Set(REPORT_GROUPS.map(g => g.output));

// ── cadence ───────────────────────────────────────────────────────────────────

function isMonday() {
  return new Date().getDay() === 1;
}

// The Monday of the current week as YYYY-MM-DD.
function weekOfDate() {
  const d   = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

// ── carry-forward ─────────────────────────────────────────────────────────────

function previousReport(slug) {
  const p = `reports/${slug}.json`;
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  } catch { /* */ }
  return null;
}

// ── forced tool ───────────────────────────────────────────────────────────────

const EMIT_REPORT = {
  name: 'emit_report',
  description: 'Emit the structured client report. Shape matches reporter.md exactly.',
  input_schema: {
    type: 'object',
    required: ['verdict', 'narrative', 'highlights', 'watch_item'],
    properties: {
      verdict: {
        type: 'string',
        description: 'One client-readable line, max 14 words. The honest headline.',
      },
      narrative: {
        type: 'string',
        description: '3-5 short sentences: what happened, why (from findings), what is being done, what to expect next period.',
      },
      highlights: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          required: ['number', 'phrase'],
          properties: {
            number: { type: 'string', description: 'The specific metric value, e.g. "88" or "$24.99".' },
            phrase: { type: 'string', description: 'Plain phrase saying what this number means to the client.' },
          },
        },
      },
      watch_item: {
        description: 'The one thing being actively managed, with its fix named in the same breath. Null when there is nothing real to surface.',
        anyOf: [
          {
            type: 'object',
            required: ['issue', 'fix'],
            properties: {
              issue: { type: 'string', description: 'What is being watched or managed.' },
              fix:   { type: 'string', description: 'What is being done about it, already in motion.' },
            },
          },
          { type: 'null' },
        ],
      },
    },
  },
};

// ── pulse + timeline loaders ──────────────────────────────────────────────────

function loadPulse(slug) {
  const p = `pulse/${slug}.json`;
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadTimeline(slug) {
  const p = `timeline/${slug}.plan.json`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Returns [{ slug, pulse }, ...] for a solo client.
function resolveSoloPulses(client) {
  const pulse = loadPulse(client.slug);
  return pulse ? [{ slug: client.slug, pulse }] : [];
}

// Returns [{ slug, pulse }, ...] for a group.
// Falls back to pulse/[group.output].json if no member files exist yet.
function resolveGroupPulses(group) {
  const found = group.members
    .map(s => ({ slug: s, pulse: loadPulse(s) }))
    .filter(x => x.pulse);
  if (found.length) return found;
  const fallback = loadPulse(group.output);
  return fallback ? [{ slug: group.output, pulse: fallback }] : [];
}

// ── prompt builder ────────────────────────────────────────────────────────────

function pulseBlock(slug, pulse) {
  const w    = pulse.windsor    || {};
  const perf = pulse.performance || null;
  const parts = [];

  parts.push('\n## TRIAGE\n');
  parts.push(JSON.stringify({
    score:         pulse.score,
    status:        pulse.status,
    daily_verdict: pulse.verdict || null,
  }, null, 1));

  parts.push('\n## 28-DAY TOTALS\n');
  parts.push(JSON.stringify({
    totals:       w.totals,
    top_campaign: w.top_campaign,
    organic:      w.organic,
    analytics:    w.analytics,
    search:       w.search,
    social:       w.social,
    ghl:          pulse.ghl,
  }, null, 1));

  parts.push('\n## 7D vs PRIOR 7D DELTAS\n');
  parts.push(JSON.stringify(w.deltas || {}, null, 1));

  if (perf) {
    const tag = perf.stale ? ' (carried forward — numbers still valid)' : '';
    parts.push(`\n## PERFORMANCE FINDINGS${tag}\n`);
    parts.push(JSON.stringify({ verdict: perf.verdict, findings: perf.findings }, null, 1));
  } else {
    parts.push('\n## PERFORMANCE FINDINGS\nNone yet — describe numbers plainly.\n');
  }

  return parts.join('\n');
}

function buildPrompt(lens, displayName, clientKind, pulseEntries, timeline) {
  const today   = new Date().toISOString().slice(0, 10);
  const isGroup = pulseEntries.length > 1;

  const filled = lens
    .replaceAll('{today}',       today)
    .replaceAll('{client}',      displayName)
    .replaceAll('{client_kind}', clientKind);

  const parts = [filled];
  parts.push(`\n## REPORT CONTEXT\nWeekly report. Week of ${weekOfDate()}. Window: last 28 days.\n`);

  if (isGroup) {
    parts.push(
      '\nThis client spans multiple entities. ' +
      'Produce one unified report covering all entities. ' +
      'Treat combined activity as the client story.\n'
    );
    for (const { slug, pulse } of pulseEntries) {
      parts.push(`\n${'─'.repeat(50)}\n# ENTITY: ${pulse.name || slug}\n`);
      parts.push(pulseBlock(slug, pulse));
    }
  } else {
    parts.push(pulseBlock(pulseEntries[0].slug, pulseEntries[0].pulse));
  }

  if (timeline) {
    const milestones = timeline.milestones ?? timeline;
    parts.push('\n## TIMELINE MILESTONES\n');
    parts.push(JSON.stringify(milestones, null, 1));
  }

  return parts.join('\n');
}

// ── API call ──────────────────────────────────────────────────────────────────

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
      max_tokens:  1200,
      tools:       [EMIT_REPORT],
      tool_choice: { type: 'tool', name: 'emit_report' },
      messages:    [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data    = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('no tool_use block in response');
  return toolUse.input;
}

// ── process one output slot ───────────────────────────────────────────────────
// Returns counts delta: { generated, carried, skipped }

async function processSlot({ outputSlug, displayName, clientKind, pulseEntries, timeline, lens, due, weekDate }) {
  let generated = 0, carried = 0, skipped = 0;

  if (!pulseEntries.length) {
    skipped++;
    console.log(`  ${outputSlug}: skipped — no pulse file`);
    return { generated, carried, skipped };
  }

  // DRY_RUN: build and print the prompt, no API call, no cadence gate.
  if (DRY_RUN) {
    if (DRY_RUN_SLUG && outputSlug !== DRY_RUN_SLUG) {
      skipped++;
      return { generated, carried, skipped };
    }
    const prompt = buildPrompt(lens, displayName, clientKind, pulseEntries, timeline);
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`DRY RUN PROMPT — ${outputSlug}`);
    console.log(`${'═'.repeat(64)}\n`);
    console.log(prompt);
    console.log(`\n${'═'.repeat(64)}\nEND PROMPT — ${outputSlug}\n`);
    skipped++;
    return { generated, carried, skipped };
  }

  // Off-cadence or no API key: carry the last report forward.
  if (!due || !API_KEY) {
    const prev = previousReport(outputSlug);
    if (prev) {
      writeFileSync(
        `reports/${outputSlug}.json`,
        JSON.stringify({ ...prev, stale: true }, null, 2)
      );
      carried++;
      console.log(`  ${outputSlug}: carried forward (${!due ? 'off-cadence' : 'no api key'})`);
    } else {
      skipped++;
      console.log(`  ${outputSlug}: skipped — off-cadence, no prior report`);
    }
    return { generated, carried, skipped };
  }

  // Generate.
  try {
    const prompt = buildPrompt(lens, displayName, clientKind, pulseEntries, timeline);
    const out    = await callLens(prompt);
    writeFileSync(
      `reports/${outputSlug}.json`,
      JSON.stringify({
        generated_at: new Date().toISOString(),
        week_of:      weekDate,
        slug:         outputSlug,
        stale:        false,
        ...out,
      }, null, 2)
    );
    generated++;
    console.log(`  ${outputSlug}: ✓ "${out.verdict.slice(0, 60)}"`);
  } catch (err) {
    console.error(`  ${outputSlug}: lens failed — ${err.message}`);
    const prev = previousReport(outputSlug);
    if (prev) {
      writeFileSync(
        `reports/${outputSlug}.json`,
        JSON.stringify({ ...prev, stale: true }, null, 2)
      );
      carried++;
    }
  }

  return { generated, carried, skipped };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Apply reporter lens ===');

  const lensPath = 'lenses/reporter.md';
  if (!existsSync(lensPath)) {
    console.error('lenses/reporter.md missing — aborting');
    process.exit(1);
  }
  const lens = readFileSync(lensPath, 'utf8');

  mkdirSync('reports', { recursive: true });

  const due      = FORCE || isMonday();
  const weekDate = weekOfDate();
  let   generated = 0, carried = 0, skipped = 0;

  function tally(counts) {
    generated += counts.generated;
    carried   += counts.carried;
    skipped   += counts.skipped;
  }

  // ── groups (multi-entity → single report) ──────────────────────────────────
  for (const group of REPORT_GROUPS) {
    const pulseEntries = resolveGroupPulses(group);
    const clientKind   = pulseEntries[0]?.pulse.type || 'leadgen';
    const timeline     = loadTimeline(group.output);
    tally(await processSlot({
      outputSlug: group.output,
      displayName: group.name,
      clientKind,
      pulseEntries,
      timeline,
      lens, due, weekDate,
    }));
  }

  // ── solo clients (skip group members and group output slugs) ───────────────
  const soloClients = CLIENTS.filter(
    c => c.active !== false
      && !GROUP_MEMBER_SLUGS.has(c.slug)
      && !GROUP_OUTPUT_SLUGS.has(c.slug)
  );

  for (const client of soloClients) {
    const pulseEntries = resolveSoloPulses(client);
    const clientKind   = client.type || pulseEntries[0]?.pulse.type || 'leadgen';
    const timeline     = loadTimeline(client.slug);
    tally(await processSlot({
      outputSlug: client.slug,
      displayName: client.name,
      clientKind,
      pulseEntries,
      timeline,
      lens, due, weekDate,
    }));
  }

  console.log(`\nDone: ${generated} generated, ${carried} carried, ${skipped} skipped.`);
}

main();
