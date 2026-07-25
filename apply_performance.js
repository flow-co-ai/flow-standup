// apply_performance.js — applies lenses/performance.md to each client's pulse.
//
// v2 — reconciled with the score/verdict/series layer now in pulse.js:
//   - trend evidence comes from pulse.windsor.series (no history file read)
//   - client kind comes from pulse.type (clients.json `type`)
//   - score, status, flags and the daily verdict are passed to the lens as
//     context it must extend, not restate
//
// Runs AFTER pulse.js in the Daily Pulse workflow, BEFORE the commit step.
// Writes a `performance` key into pulse/[slug].json:
//   { generated_at, cadence, stale, verdict, findings[], suggestions[], next_check }
//
// Cadence: every 3rd day per client (staggered by slug), PLUS any day the
// pulse carries flags. Off days carry the previous block forward from git
// HEAD with { stale: true } so the tab never goes blank.
//
// Principle preserved: this only ever DRAFTS. Suggestions reach Monday only
// when a human clicks approve in the Performance tab.
//
// Env: ANTHROPIC_API_KEY (required to generate; without it, carry-forward only)
//      FORCE_PERFORMANCE=1 (optional: run every client today)
//      STATE_BRANCH (optional, default "state" — where suggestion decisions live)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CLIENTS = require('./clients.json');

const API_KEY      = process.env.ANTHROPIC_API_KEY || '';
const FORCE        = process.env.FORCE_PERFORMANCE === '1';
const STATE_BRANCH = process.env.STATE_BRANCH || 'state';
const MODEL        = 'claude-sonnet-4-6';

// ── cadence ────────────────────────────────────────────────────────

function slugOffset(slug) {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 997;
  return h % 3;
}

function isCadenceDay(slug) {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return (dayIndex + slugOffset(slug)) % 3 === 0;
}

// ── previous performance block (survives pulse.js overwriting the file) ──

function previousPerformance(slug) {
  try {
    const prev = JSON.parse(
      execSync(`git show HEAD:pulse/${slug}.json`, { encoding: 'utf8' })
    );
    return prev.performance || null;
  } catch {
    return null;
  }
}

// ── past decisions (approved / dismissed, written by the suggestions fn) ──

async function fetchDecisions() {
  const url = `https://raw.githubusercontent.com/flow-co-ai/flow-standup/refs/heads/${STATE_BRANCH}/checks/suggestion-decisions.json?t=${Date.now()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { items: [] };
    return await res.json();
  } catch {
    return { items: [] };
  }
}

// ── the forced tool (never prompt for raw JSON) ────────────────────

const EMIT_PERFORMANCE = {
  name: 'emit_performance',
  description: 'Emit the structured performance analysis for one client.',
  input_schema: {
    type: 'object',
    required: ['verdict', 'findings', 'suggestions', 'next_check'],
    properties: {
      verdict: { type: 'string', description: 'One line, max 12 words. Extends or corrects the daily verdict, never repeats it.' },
      findings: {
        type: 'array', maxItems: 5,
        items: {
          type: 'object',
          required: ['id', 'priority', 'text', 'confidence', 'channel'],
          properties: {
            id:         { type: 'string' },
            priority:   { type: 'integer', minimum: 1, maximum: 4 },
            text:       { type: 'string', description: 'Max 30 words, must include a real number from the data.' },
            confidence: { type: 'string', enum: ['confirmed', 'probable', 'hypothesis'] },
            channel:    { type: 'string' },
          },
        },
      },
      suggestions: {
        type: 'array', maxItems: 3,
        items: {
          type: 'object',
          required: ['id', 'type', 'text', 'cites', 'monday_item_name', 'monday_update'],
          properties: {
            id:    { type: 'string' },
            type:  { type: 'string', enum: ['scale', 'kill', 'budget_shift', 'creative_refresh', 'fix', 'watch'] },
            text:  { type: 'string', description: 'Max 25 words, concrete magnitude.' },
            cites: { type: 'array', items: { type: 'string' }, minItems: 1 },
            monday_item_name: { type: 'string', description: 'Max 6 words.' },
            monday_update:    { type: 'string', description: '2-4 plain sentences: action, cited numbers, success check and date.' },
          },
        },
      },
      next_check: { type: 'string', description: 'ISO date to re-check.' },
    },
  },
};

// ── build + call ───────────────────────────────────────────────────

function trimSeries(series, days = 45) {
  if (!series || typeof series !== 'object') return null;
  const out = {};
  for (const [k, arr] of Object.entries(series)) {
    if (Array.isArray(arr)) out[k] = arr.slice(-days);
  }
  return out;
}

function buildPrompt(lens, pulse, decisions) {
  const kind  = pulse.type || 'leadgen';
  const today = new Date().toISOString().slice(0, 10);

  const filled = lens
    .replaceAll('{today}', today)
    .replaceAll('{client}', pulse.name)
    .replaceAll('{client_kind}', kind);

  const recentDecisions = (decisions.items || [])
    .filter(d => d.slug === pulse.slug)
    .slice(-10);

  const w = pulse.windsor || {};
  const parts = [filled];

  parts.push('\n## TRIAGE (machine-computed this morning)\n');
  parts.push(JSON.stringify({
    score:  pulse.score,
    status: pulse.status,
    flags:  w.flags || [],
    daily_verdict: pulse.verdict || null,
  }, null, 1));

  parts.push('\n## 28-DAY WINDOW\n');
  parts.push(JSON.stringify({
    totals:       w.totals,
    top_campaign: w.top_campaign,
    organic:      w.organic,
    analytics:    w.analytics,
    search:       w.search,
    social:       w.social,
    ghl:          pulse.ghl,
  }, null, 1));

  parts.push('\n## 7D VS PRIOR 7D DELTAS\n');
  parts.push(JSON.stringify(w.deltas || {}, null, 1));

  parts.push('\n## DAILY SERIES (oldest → newest, last 45 days — compute the 3-day signal from this)\n');
  parts.push(JSON.stringify(trimSeries(w.series)));

  parts.push('\n## PAST DECISIONS (approved = live experiments; dismissed = do not resurface without new evidence)\n');
  parts.push(recentDecisions.length ? JSON.stringify(recentDecisions, null, 1) : 'None yet.');

  return parts.join('\n');
}

async function callLens(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      tools: [EMIT_PERFORMANCE],
      tool_choice: { type: 'tool', name: 'emit_performance' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('no tool_use block in response');
  return toolUse.input;
}

// ── main ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== Apply performance lens (v2) ===');
  const lensPath = 'lenses/performance.md';
  if (!existsSync(lensPath)) { console.error('lenses/performance.md missing — aborting'); process.exit(1); }
  const lens = readFileSync(lensPath, 'utf8');
  const decisions = await fetchDecisions();

  let generated = 0, carried = 0, skipped = 0;

  for (const client of CLIENTS) {
    const pulsePath = `pulse/${client.slug}.json`;
    if (!existsSync(pulsePath)) { skipped++; continue; }
    const pulse = JSON.parse(readFileSync(pulsePath, 'utf8'));

    const w = pulse.windsor || {};
    const noData     = w.error && (!pulse.ghl || pulse.ghl?.error);
    const flags      = w.flags || [];
    const seriesDays = (w.series?.dates || []).length;
    const due        = FORCE || flags.length > 0 || isCadenceDay(client.slug);

    if (!due || noData || !API_KEY || seriesDays < 6) {
      const prev = previousPerformance(client.slug);
      if (prev) {
        pulse.performance = { ...prev, stale: true };
        writeFileSync(pulsePath, JSON.stringify(pulse, null, 2));
        carried++;
        console.log(`  ${client.slug}: carried forward (${!due ? 'off-cadence' : noData ? 'no data' : !API_KEY ? 'no api key' : 'thin series'})`);
      } else {
        skipped++;
        console.log(`  ${client.slug}: skipped, nothing to carry`);
      }
      continue;
    }

    try {
      const prompt = buildPrompt(lens, pulse, decisions);
      const out    = await callLens(prompt);
      pulse.performance = {
        generated_at: new Date().toISOString(),
        cadence: flags.length ? 'flag_triggered' : 'scheduled_3d',
        stale: false,
        ...out,
      };
      writeFileSync(pulsePath, JSON.stringify(pulse, null, 2));
      generated++;
      console.log(`  ${client.slug}: ✓ ${out.findings.length} findings, ${out.suggestions.length} suggestions`);
    } catch (err) {
      console.error(`  ${client.slug}: lens failed — ${err.message}`);
      const prev = previousPerformance(client.slug);
      if (prev) {
        pulse.performance = { ...prev, stale: true };
        writeFileSync(pulsePath, JSON.stringify(pulse, null, 2));
        carried++;
      }
    }
  }

  console.log(`\nDone: ${generated} generated, ${carried} carried, ${skipped} skipped.`);
}

main();
