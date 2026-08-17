// build_standup_summary.js — one AI-written line summarising the whole day.
//
// Reads every active client's pulse/[slug].json brief_v2.blocks, counts blocks
// by side, and calls Claude once (forced tool emit_summary) to write
// standups/standup-summary.json: { date, hero, subline, block_counts }.
//
// Runs after apply_ops_pulse.js in daily-pulse.yml.
//
// Env:
//   ANTHROPIC_API_KEY  required to generate hero/subline; without it, counts
//                      are still written and hero/subline stay empty.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL   = 'claude-sonnet-4-6';

// ── forced tool ───────────────────────────────────────────────────────────────

const EMIT_SUMMARY = {
  name: 'emit_summary',
  description: 'Emit the single-sentence hero and subline for the day.',
  input_schema: {
    type: 'object',
    required: ['hero', 'subline'],
    properties: {
      hero: {
        type: 'string',
        description: 'One sentence, ≤25 words, naming the single most important thing across all clients today. Name the client and the item. Prefer hot blocks and blocks whose side is "you". No hedging.',
      },
      subline: {
        type: 'string',
        description: 'One sentence stating counts, exact template: "X blocks yours, Y team\'s, Z with clients, N clients quiet." Numbers must match the totals passed in.',
      },
    },
  },
};

// ── helpers ───────────────────────────────────────────────────────────────────

function readJSON(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function extractBlocks(pulse) {
  // brief_v2 lives either at pulse.brief_v2 (post-carryover write) or nested
  // inside pulse.brief.brief_v2 (raw emit_brief tool output).
  const v2 = pulse?.brief_v2 || pulse?.brief?.brief_v2;
  return v2?.blocks || [];
}

function loadPerClient() {
  const rows = [];
  for (const c of CLIENTS) {
    if (c.active === false) continue;
    const path = `pulse/${c.slug}.json`;
    if (!existsSync(path)) continue;
    const pulse = readJSON(path);
    if (!pulse) continue;
    rows.push({
      slug:   c.slug,
      name:   c.name,
      blocks: extractBlocks(pulse),
    });
  }
  return rows;
}

function countBlocks(rows) {
  const counts = { you: 0, team: 0, client: 0 };
  for (const r of rows) {
    for (const b of r.blocks || []) {
      if (counts[b.side] !== undefined) counts[b.side]++;
    }
  }
  return counts;
}

function quietCount(rows) {
  return rows.filter(r => !(r.blocks || []).length).length;
}

async function callSummary({ rows, counts, quiet, today }) {
  const clientBlocks = rows.map(r => ({
    client: r.name,
    blocks: (r.blocks || []).map(b => ({
      item:     b.item,
      side:     b.side,
      who:      b.who,
      age_days: b.age_days,
      hot:      !!b.hot,
    })),
  }));

  const prompt = [
    `Today: ${today}`,
    `Block counts (already computed from the data below):`,
    `  you=${counts.you}`,
    `  team=${counts.team}`,
    `  client=${counts.client}`,
    `  quiet_clients=${quiet}`,
    ``,
    `Per-client blocks:`,
    JSON.stringify(clientBlocks, null, 2),
    ``,
    `Rules:`,
    `- hero: one sentence ≤25 words. Name the single most important thing right now across all clients. Concrete: name the client and the item verbatim from the data. Prefer hot blocks and blocks on side "you" (that's Sohib). If everything is quiet, say so — do not invent urgency.`,
    `- subline: exact template — "X blocks yours, Y team's, Z with clients, N clients quiet." Fill X/Y/Z/N from the counts above.`,
    `- No hedging. No em dashes. No URLs.`,
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  400,
      temperature: 0,
      tools:       [EMIT_SUMMARY],
      tool_choice: { type: 'tool', name: 'emit_summary' },
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
  console.log('=== Build standup summary ===');

  const today  = new Date().toISOString().slice(0, 10);
  const rows   = loadPerClient();
  const counts = countBlocks(rows);
  const quiet  = quietCount(rows);

  console.log(`  ${rows.length} active clients — you=${counts.you}, team=${counts.team}, client=${counts.client}, quiet=${quiet}`);

  let hero = '', subline = '';
  if (!API_KEY) {
    console.log('  ANTHROPIC_API_KEY not set — writing counts only, hero/subline blank');
  } else if (!rows.length) {
    console.log('  no active pulse files — writing empty summary');
  } else {
    try {
      const out = await callSummary({ rows, counts, quiet, today });
      hero    = out.hero    || '';
      subline = out.subline || '';
    } catch (err) {
      console.error(`  summary generation failed — ${err.message}`);
    }
  }

  if (!existsSync('standups')) mkdirSync('standups');
  const out = {
    date:         today,
    generated_at: new Date().toISOString(),
    hero,
    subline,
    block_counts: counts,
  };
  writeFileSync('standups/standup-summary.json', JSON.stringify(out, null, 2));
  console.log(`  ✓ standups/standup-summary.json written`);
}

main();
