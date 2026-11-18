// Shared by work-report.js (log, job status) and work-report-background.js
// (the draft itself). Reads a client's Monday posts in a window, adds Done
// marks from the webhook, and drafts the report under lenses/work-report.md.
// The draft runs in a background function because the model call can take
// longer than Netlify lets a normal function run.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../../../config.json");
const { mondayGraphQL, CLIENT_GROUPS, BOARD_LABEL_IDS } = require("./monday");
const { resolveClientName } = require("./clientAliases");
const { getJSON } = require("./github");
const { MODEL } = require("./model");

const SETTINGS = (config.ops && config.ops.work_report) || {};
const LEADS = new Set((SETTINGS.leads || ["Sohib Boundaoui", "Nacer Amrouch"]).map((n) => n.toLowerCase()));
const DUE_DAYS = SETTINGS.due_days || 7;
const AREA = { Ads: "Ads", "Web+SEO": "Website & SEO", CRM: "CRM & automations", Video: "Video & content" };
const BOARDS = ["Ads", "Web+SEO", "CRM", "Video"];
const CLOSED = /^(done|complete|completed|cancel+ed|archived|not needed)$/i;
const RECENT_DAYS = (config.ops && config.ops.recent_days) || 30; // older open items are the Overview's "quiet" problem, not this week's chase list
const POST_CHARS = 1800;
const PAYLOAD_CHARS = 90000;
const MODEL_TIMEOUT_MS = 240000; // runs in a background function (15 min limit), so the model gets room

// Same bundling as item-chat.js's rules file (netlify.toml included_files). A
// few candidate paths so it works whether or not lib/ is kept as a folder.
const LENS = (() => {
  for (const p of [path.join(__dirname, "..", "..", "..", "lenses", "work-report.md"), path.join(__dirname, "..", "..", "lenses", "work-report.md"), path.join(process.cwd(), "lenses", "work-report.md")]) {
    try { return fs.readFileSync(p, "utf8"); } catch {}
  }
  throw new Error("work-report: lenses/work-report.md wasn't bundled. Check included_files in netlify.toml.");
})();

function sameSecret(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const inWindow = (iso, w) => { const t = Date.parse(iso || ""); return t >= w.start && t <= w.end; };
const clip = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
// "@Muhammad Hashir Faiz please…" -> "please…": who did what stays internal.
// Emails and phone numbers never reach the model, so they can't land in a
// report, a saved draft or the sent log. A "phone" needs 10+ digits, so dates
// like 2026-11-17 and amounts are left alone.
const redact = (s) => String(s || "")
  .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
  .replace(/\+?\(?\d[\d\s().-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m));
const stripMentions = (s) => String(s || "").replace(/@[\p{Lu}][\p{L}'.-]*(\s+[\p{Lu}][\p{L}'.-]*){0,3}/gu, "").replace(/[ \t]{2,}/g, " ").trim();

function colText(item, type) {
  const cv = (item.column_values || []).find((c) => c.type === type);
  return cv && cv.text ? cv.text.trim() : "";
}

// ── Monday ─────────────────────────────────────────────────────────────
const POST = "id text_body created_at creator { name } replies { id text_body created_at creator { name } }";
const ITEM = `id name created_at updated_at column_values { id type text }
  updates(limit: 25) { ${POST} }
  subitems { id name updated_at column_values { id type text } }`;

async function groupItems(boardKey, groupId) {
  const data = await mondayGraphQL(
    `query($b: [ID!], $g: [String]) { boards(ids: $b) { groups(ids: $g) { items_page(limit: 100) { items { ${ITEM} } } } } }`,
    { b: [BOARD_LABEL_IDS[boardKey]], g: [groupId] }
  );
  return (((data.boards || [])[0] || {}).groups || [])[0]?.items_page?.items || [];
}

async function subitemPosts(ids) {
  if (!ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await mondayGraphQL(`query($ids: [ID!]) { items(ids: $ids) { id updates(limit: 10) { ${POST} } } }`, { ids: ids.slice(i, i + 50) });
    for (const it of data.items || []) out.set(String(it.id), it.updates || []);
  }
  return out;
}

// Flatten updates + replies into dated posts, tagged by who wrote them.
function postsOf(updates, w) {
  const all = [];
  for (const u of updates || []) {
    all.push(u);
    for (const r of u.replies || []) all.push(r);
  }
  return all
    .filter((p) => inWindow(p.created_at, w) && (p.text_body || "").trim())
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((p) => {
      const by = (p.creator && p.creator.name) || "";
      return { date: p.created_at.slice(0, 10), role: LEADS.has(by.toLowerCase()) ? "lead" : "specialist", by, text: clip(stripMentions(redact(p.text_body)), POST_CHARS) };
    });
}

function lastTeamPost(updates) {
  let best = null;
  for (const u of updates || []) for (const p of [u, ...(u.replies || [])]) {
    const by = (p.creator && p.creator.name) || "";
    if (LEADS.has(by.toLowerCase())) continue;
    if (!best || p.created_at > best.created_at) best = { created_at: p.created_at, by };
  }
  return best;
}

// Done marks recorded by monday-done-webhook.js, same source as ops-live.js.
async function doneMarks(client, w) {
  try {
    const { data: acc } = await getJSON("standups/completed-accumulator.json", {}, "main");
    const ids = new Set();
    for (const week of [{ items: acc.items || [] }, ...(acc.history || [])]) {
      for (const e of week.items || []) {
        if (e.source !== "MON" || e.generated === true || !e.monday_item_id) continue;
        if (resolveClientName(e.client || "") !== client) continue;
        const d = (e.sourceDate || "").slice(0, 10);
        if (d && inWindow(d + "T12:00:00Z", w)) ids.add(String(e.monday_item_id));
      }
    }
    return ids;
  } catch (e) {
    console.error("work-report: done marks unavailable", e);
    return new Set();
  }
}

// Team messages about this client from WhatsApp, written daily by
// build_work_log.py (work-log/[slug].json, redacted, no sender names). The
// safety net for work that never got a Monday update.
const WA_MAX = 120, WA_CHARS = 600;
async function whatsappLog(client, w) {
  const ad = (config.ops && config.ops.ad_slugs) || {};
  const slugs = ad[client] || [];
  const files = await Promise.all(slugs.map((s) => getJSON(`work-log/${s}.json`, null, "main").then((r) => r.data).catch(() => null)));
  const seen = new Set(), out = [];
  for (const f of files) for (const m of (f && f.messages) || []) {
    const key = `${m.at}|${m.text}`;
    if (seen.has(key) || !inWindow(m.at, w)) continue;
    seen.add(key);
    out.push(m);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-WA_MAX)
    .map((m, i) => ({ id: `wa${i + 1}`, date: m.at.slice(0, 10), chat: m.chat === "client" ? "client group" : "team group", text: clip(stripMentions(redact(m.text)), WA_CHARS) }));
}

async function collect(client, w) {
  const groups = CLIENT_GROUPS[client];
  if (!groups) throw Object.assign(new Error(`No Monday groups are mapped for ${client}. Add it to CLIENT_GROUPS in netlify/functions/lib/monday.js.`), { status: 400 });

  const [perBoard, done, whatsapp] = await Promise.all([
    Promise.all(BOARDS.filter((b) => groups[b]).map(async (b) => {
      try { return { board: b, items: await groupItems(b, groups[b]) }; }
      catch (e) { return { board: b, items: [], error: String(e.message || e) }; }
    })),
    doneMarks(client, w),
    whatsappLog(client, w).catch((e) => { console.error("work-report: whatsapp log", e); return []; }),
  ]);

  // Boards that share one group id (e.g. Steel's Web+SEO/CRM/Video) return the same items: keep the first.
  const seen = new Set();
  const rows = [];
  for (const { board, items } of perBoard) for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    rows.push({ board, it });
  }

  const subIds = rows.flatMap(({ it }) => (it.subitems || []).filter((s) => inWindow(s.updated_at, w)).map((s) => String(s.id)));
  const subPosts = await subitemPosts(subIds).catch(() => new Map());

  const evidence = [], silent = [], sources = [];
  const end = new Date(w.end).toISOString();
  for (const { board, it } of rows) {
    if ((it.created_at || "") > end) continue;
    const status = colText(it, "status");
    const people = colText(it, "people");
    const url = `https://flowcompany.monday.com/boards/${BOARD_LABEL_IDS[board]}/pulses/${it.id}`;
    const posts = postsOf(it.updates, w);
    const subs = (it.subitems || []).map((s) => ({ name: s.name, status: colText(s, "status"), posts: postsOf(subPosts.get(String(s.id)), w) }))
      .filter((s) => s.posts.length);
    const markedDone = done.has(String(it.id));

    if (posts.length || subs.length || markedDone) {
      evidence.push({
        id: String(it.id), area: AREA[board], name: it.name, status: status || "(none)",
        marked_done_in_window: markedDone,
        posts: posts.map(({ by, ...p }) => p), // names stay out of the model input
        subitems: subs.map((s) => ({ name: s.name, status: s.status, posts: s.posts.map(({ by, ...p }) => p) })),
      });
      sources.push({ id: String(it.id), name: it.name, area: AREA[board], status, url });
    }

    // Open work where nobody doing it posted in the window.
    const recent = Date.parse(it.updated_at || it.created_at || 0) >= w.start - RECENT_DAYS * 86400000;
    const open = status && !CLOSED.test(status) && recent;
    const teamPosted = posts.some((p) => p.role === "specialist") || subs.some((s) => s.posts.some((p) => p.role === "specialist"));
    if (open && !teamPosted && !markedDone) {
      const last = lastTeamPost(it.updates);
      silent.push({
        id: String(it.id), name: it.name, area: AREA[board], status, people, url,
        last_team_post: last ? last.created_at.slice(0, 10) : null,
        new_this_window: inWindow(it.created_at, w),
      });
    }
  }

  // Keep the model input bounded: trim the longest texts first if needed.
  const input = () => JSON.stringify({ monday_items: evidence, whatsapp_team_messages: whatsapp });
  let payload = input();
  while (payload.length > PAYLOAD_CHARS) {
    const longest = [...evidence.flatMap((e) => e.posts), ...whatsapp].sort((a, b) => b.text.length - a.text.length)[0];
    if (!longest || longest.text.length < 300) break;
    longest.text = clip(longest.text, Math.floor(longest.text.length * 0.6));
    payload = input();
  }

  silent.sort((a, b) => String(a.last_team_post || "").localeCompare(String(b.last_team_post || "")));
  const errors = perBoard.filter((b) => b.error).map((b) => `${AREA[b.board]}: ${b.error}`);
  return { evidence, whatsapp, payload, silent, sources, errors };
}

// ── Model ──────────────────────────────────────────────────────────────
// A forced tool call, so the report comes back as parsed JSON. Free-form JSON
// broke on a stray quote inside a bullet.
const BULLET = {
  type: "object",
  properties: {
    area: { type: "string", enum: ["Ads", "Website & SEO", "Google listings", "CRM & automations", "Video & content", "Other"] },
    text: { type: "string" },
    source_ids: { type: "array", items: { type: "string" } },
  },
  required: ["area", "text", "source_ids"],
};
const REPORT_TOOL = {
  name: "submit_work_report",
  description: "Submit the client's work report for this window.",
  input_schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      done: { type: "array", items: BULLET },
      in_progress: { type: "array", items: BULLET },
      waiting_on_you: { type: "array", items: BULLET },
      next_week: { type: "array", items: BULLET },
      internal_flags: { type: "array", items: { type: "object", properties: { text: { type: "string" }, source_ids: { type: "array", items: { type: "string" } } }, required: ["text"] } },
    },
    required: ["headline", "done", "in_progress", "waiting_on_you", "next_week", "internal_flags"],
  },
};

async function draft(client, w, payload) {
  const system = LENS.replace("{today}", new Date().toISOString().slice(0, 10)).replace("{client}", client).replace("{from}", w.from).replace("{to}", w.to);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system,
        tools: [REPORT_TOOL],
        tool_choice: { type: "tool", name: REPORT_TOOL.name },
        messages: [{ role: "user", content: `What the team logged for ${client}, ${w.from} to ${w.to}:\n\n${payload}\n\nSubmit the work report.` }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Model call failed (${res.status}): ${(body.error && body.error.message) || "unknown"}`);
    const call = (body.content || []).find((c) => c.type === "tool_use" && c.name === REPORT_TOOL.name);
    if (!call) throw new Error("The model didn't return a report. Try again.");
    if (body.stop_reason === "max_tokens") throw new Error("The report ran too long. Try a shorter date range.");
    return call.input;
  } finally {
    clearTimeout(timer);
  }
}

// Drop any bullet that doesn't trace to an item we actually sent.
// House style: no em dashes in anything the page shows or sends.
const noDash = (s) => String(s || "").replace(/\s*—\s*/g, ", ").trim();

function clean(report, ids) {
  const keep = (list) => (Array.isArray(list) ? list : [])
    .map((b) => ({ area: b.area || "Other", text: noDash(b.text), source_ids: (b.source_ids || []).map(String).filter((id) => ids.has(id)) }))
    .filter((b) => b.text && b.source_ids.length)
    .map((b) => ({ ...b, whatsapp_only: b.source_ids.every((id) => id.startsWith("wa")) }));
  return {
    headline: noDash(report.headline),
    done: keep(report.done), in_progress: keep(report.in_progress),
    waiting_on_you: keep(report.waiting_on_you), next_week: keep(report.next_week),
    internal_flags: (Array.isArray(report.internal_flags) ? report.internal_flags : []).map((f) => ({ text: noDash(f.text), source_ids: (f.source_ids || []).map(String) })).filter((f) => f.text),
  };
}

// Full draft for one client and window: what the page shows.
async function buildDraft(client, w) {
  const { evidence, whatsapp, payload, silent, sources, errors } = await collect(client, w);
  const empty = !evidence.length && !whatsapp.length;
  let report = { headline: "", done: [], in_progress: [], waiting_on_you: [], next_week: [], internal_flags: [] };
  if (!empty) report = clean(await draft(client, w, payload), new Set([...evidence.map((e) => e.id), ...whatsapp.map((m) => m.id)]));
  // Work that reached the report only through chat: log it in Monday.
  const notOnMonday = ["done", "in_progress", "waiting_on_you", "next_week"].flatMap((k) => report[k]).filter((b) => b.whatsapp_only).map((b) => b.text);
  return { client, window: { from: w.from, to: w.to }, report, silent, sources, errors, empty, whatsapp_count: whatsapp.length, not_on_monday: notOnMonday, model: MODEL };
}

// Shared request checks for both handlers.
function parseWindow(body) {
  const client = resolveClientName(String(body.client || "").trim());
  if (!client) throw Object.assign(new Error("Pick a client."), { status: 400 });
  if (!isDay(body.from) || !isDay(body.to) || body.from > body.to) throw Object.assign(new Error("Pick a valid date range."), { status: 400 });
  return { client, w: { from: body.from, to: body.to, start: Date.parse(body.from + "T00:00:00Z"), end: Date.parse(body.to + "T23:59:59Z") } };
}

// One shared draft per client on the state branch, so everyone with the
// passcode sees the same draft, edits and send status.
const clientKey = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const draftPath = (client) => `work-reports/drafts/${clientKey(client)}.json`;

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const jobPath = (id) => `work-reports/jobs/${id}.json`;

module.exports = { buildDraft, parseWindow, sameSecret, clip, DUE_DAYS, JOB_ID, jobPath, draftPath };
