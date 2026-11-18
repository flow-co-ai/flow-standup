// Work reports: the weekly "here's what we did" message to each client.
//
// GET                         -> { due_days, last_sent: { [client]: entry }, recent: [entry] }
// POST { action: "draft", client, from, to }
//                             -> { report, silent, items, window }
// POST { action: "sent", client, from, to, channel, headline, text }
//                             -> { ok, entry }
//
// Draft reads Monday live (the client's groups on all four boards, posts in
// the window), adds the Done marks from monday-done-webhook.js, and asks the
// model to write the report under lenses/work-report.md. It also returns
// "silent" items: open work with no post from the team in the window. That
// list is for Sohib and Nacer, never the client.
//
// Nothing is sent from here. "sent" only logs the final text to the state
// branch (work-reports/log.json) so the page can show when each client last
// got a report.
//
// Env: OPS_PASSCODE, MONDAY_API_TOKEN, ANTHROPIC_API_KEY, GH_STATE_TOKEN.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../../config.json");
const { mondayGraphQL, CLIENT_GROUPS, BOARD_LABEL_IDS } = require("./lib/monday");
const { resolveClientName } = require("./lib/clientAliases");
const { getJSON, updateJSON } = require("./lib/github");
const { MODEL } = require("./lib/model");

const LOG_PATH = "work-reports/log.json";
const LOG_KEEP = 300;
const SETTINGS = (config.ops && config.ops.work_report) || {};
const LEADS = new Set((SETTINGS.leads || ["Sohib Boundaoui", "Nacer Amrouch"]).map((n) => n.toLowerCase()));
const DUE_DAYS = SETTINGS.due_days || 7;
const AREA = { Ads: "Ads", "Web+SEO": "Website & SEO", CRM: "CRM & automations", Video: "Video & content" };
const BOARDS = ["Ads", "Web+SEO", "CRM", "Video"];
const CLOSED = /^(done|complete|completed|cancel+ed|archived|not needed)$/i;
const RECENT_DAYS = (config.ops && config.ops.recent_days) || 30; // older open items are the Overview's "quiet" problem, not this week's chase list
const POST_CHARS = 1800;
const PAYLOAD_CHARS = 90000;
const MODEL_TIMEOUT_MS = 45000; // Netlify cuts synchronous functions at 60s

let LENS = "";
try { LENS = fs.readFileSync(path.join(__dirname, "../../lenses/work-report.md"), "utf8"); }
catch (e) { console.error("work-report: lens missing, check netlify.toml included_files", e); }

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(obj),
});

function sameSecret(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const inWindow = (iso, w) => { const t = Date.parse(iso || ""); return t >= w.start && t <= w.end; };
const clip = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
// "@Muhammad Hashir Faiz please…" -> "please…": who did what stays internal.
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
      return { date: p.created_at.slice(0, 10), role: LEADS.has(by.toLowerCase()) ? "lead" : "specialist", by, text: clip(stripMentions(p.text_body), POST_CHARS) };
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

async function collect(client, w) {
  const groups = CLIENT_GROUPS[client];
  if (!groups) throw Object.assign(new Error(`No Monday groups are mapped for ${client}. Add it to CLIENT_GROUPS in netlify/functions/lib/monday.js.`), { status: 400 });

  const [perBoard, done] = await Promise.all([
    Promise.all(BOARDS.filter((b) => groups[b]).map(async (b) => {
      try { return { board: b, items: await groupItems(b, groups[b]) }; }
      catch (e) { return { board: b, items: [], error: String(e.message || e) }; }
    })),
    doneMarks(client, w),
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

  // Keep the model input bounded: trim the longest posts first if needed.
  let payload = JSON.stringify(evidence);
  while (payload.length > PAYLOAD_CHARS) {
    const longest = evidence.flatMap((e) => e.posts).sort((a, b) => b.text.length - a.text.length)[0];
    if (!longest || longest.text.length < 300) break;
    longest.text = clip(longest.text, Math.floor(longest.text.length * 0.6));
    payload = JSON.stringify(evidence);
  }

  silent.sort((a, b) => String(a.last_team_post || "").localeCompare(String(b.last_team_post || "")));
  const errors = perBoard.filter((b) => b.error).map((b) => `${AREA[b.board]}: ${b.error}`);
  return { evidence, payload, silent, sources, errors };
}

// ── Model ──────────────────────────────────────────────────────────────
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
        max_tokens: 3000,
        system,
        messages: [{ role: "user", content: `Monday items for ${client}, ${w.from} to ${w.to}:\n\n${payload}\n\nWrite the work report JSON.` }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Model call failed (${res.status}): ${(body.error && body.error.message) || "unknown"}`);
    const text = (body.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    const raw = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const start = raw.indexOf("{"), stop = raw.lastIndexOf("}");
    return JSON.parse(raw.slice(start, stop + 1));
  } finally {
    clearTimeout(timer);
  }
}

// Drop any bullet that doesn't trace to an item we actually sent.
function clean(report, ids) {
  const keep = (list) => (Array.isArray(list) ? list : [])
    .map((b) => ({ area: b.area || "Other", text: String(b.text || "").trim(), source_ids: (b.source_ids || []).map(String).filter((id) => ids.has(id)) }))
    .filter((b) => b.text && b.source_ids.length);
  return {
    headline: String(report.headline || "").trim(),
    done: keep(report.done), in_progress: keep(report.in_progress),
    waiting_on_you: keep(report.waiting_on_you), next_week: keep(report.next_week),
    internal_flags: (Array.isArray(report.internal_flags) ? report.internal_flags : []).map((f) => ({ text: String(f.text || "").trim(), source_ids: (f.source_ids || []).map(String) })).filter((f) => f.text),
  };
}

// ── Log ────────────────────────────────────────────────────────────────
function lastSentByClient(entries) {
  const out = {};
  for (const e of entries) if (!out[e.client] || e.sentAt > out[e.client].sentAt) out[e.client] = { sentAt: e.sentAt, from: e.from, to: e.to, channel: e.channel };
  return out;
}

exports.handler = async (event) => {
  try {
    const key = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
    if (!sameSecret(key, process.env.OPS_PASSCODE)) return json(401, { error: "unauthorized" });

    if (event.httpMethod === "GET") {
      const { data } = await getJSON(LOG_PATH, { entries: [] });
      const entries = data.entries || [];
      return json(200, { due_days: DUE_DAYS, last_sent: lastSentByClient(entries), recent: entries.slice(-40).reverse().map(({ text, ...e }) => e) });
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    const body = JSON.parse(event.body || "{}");
    const client = resolveClientName(String(body.client || "").trim());
    if (!client) return json(400, { error: "Pick a client." });
    if (!isDay(body.from) || !isDay(body.to) || body.from > body.to) return json(400, { error: "Pick a valid date range." });
    const w = { from: body.from, to: body.to, start: Date.parse(body.from + "T00:00:00Z"), end: Date.parse(body.to + "T23:59:59Z") };

    if (body.action === "sent") {
      const text = String(body.text || "").trim();
      if (!text) return json(400, { error: "Nothing to log: the report is empty." });
      const entry = {
        id: crypto.randomUUID(), client, from: w.from, to: w.to,
        channel: ["whatsapp", "email"].includes(body.channel) ? body.channel : "other",
        headline: clip(body.headline, 200), text: clip(text, 12000), sentAt: new Date().toISOString(),
      };
      await updateJSON(LOG_PATH, (d) => ({ entries: [...(d.entries || []), entry].slice(-LOG_KEEP) }), `work report sent: ${client} ${w.from}..${w.to}`, { fallback: { entries: [] } });
      return json(200, { ok: true, entry: { ...entry, text: undefined } });
    }

    if (body.action !== "draft") return json(400, { error: "Unknown action." });

    const { evidence, payload, silent, sources, errors } = await collect(client, w);
    let report = { headline: "", done: [], in_progress: [], waiting_on_you: [], next_week: [], internal_flags: [] };
    if (evidence.length) report = clean(await draft(client, w, payload), new Set(evidence.map((e) => e.id)));
    return json(200, { client, window: { from: w.from, to: w.to }, report, silent, sources, errors, empty: !evidence.length, model: MODEL });
  } catch (err) {
    console.error("work-report error:", err);
    const msg = err.name === "AbortError" ? "The draft took too long. Try a shorter date range." : String((err && err.message) || err);
    return json(err.status || 500, { error: msg });
  }
};
