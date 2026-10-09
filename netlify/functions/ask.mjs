// POST { question, history?, focus? } with header x-ops-key -> { answer, as_of }
//
// The "Ask" tab on the Flow Ops page. Read-only lens over the state files this
// site already serves (ops.json, hub.json, monday-items.json). It calls no
// source API (Monday, Windsor, GHL, WhatsApp, Fireflies). The only outbound
// call is one Anthropic request per question. Nothing is written anywhere.
//
// Uses the same OPS_PASSCODE gate and ANTHROPIC_API_KEY as the other
// functions, so no new environment variables are needed.

import crypto from "node:crypto";

const MODEL_DEFAULT = "claude-sonnet-4-5"; // same model the other functions use; override with ASK_MODEL
const SITE_FALLBACK = "https://flowco-ops.netlify.app";
const FILES = ["ops.json", "hub.json", "monday-items.json"];

// Update text and chat text for these clients never reach the model.
// Numbers, item names, statuses and dates still do.
const HEALTHCARE = ["Full Smile", "MedStation"];

const MAX_QUESTION = 1000; // characters
const MAX_EXCHANGES = 6; // prior question/answer pairs sent back as context
const MAX_HISTORY_TEXT = 4000; // characters per prior message
const MAX_TOKENS = 1000; // answer length cap
const CACHE_MS = 5 * 60 * 1000; // reuse fetched state files for 5 minutes

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const env = (k) => (globalThis.Netlify && Netlify.env.get(k)) || process.env[k] || "";

function sameSecret(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── state files ─────────────────────────────────────────────────────────────
let cache = { at: 0, base: "", data: null };
async function loadState(base) {
  if (cache.data && cache.base === base && Date.now() - cache.at < CACHE_MS) return cache.data;
  const got = await Promise.all(
    FILES.map(async (f) => {
      const r = await fetch(`${base}/${f}`, { headers: { "cache-control": "no-cache" } });
      if (!r.ok) throw new Error(`could not read ${f} (${r.status})`);
      return r.json();
    })
  );
  const data = { ops: got[0], hub: got[1], monday: got[2] };
  cache = { at: Date.now(), base, data };
  return data;
}

// ── text hygiene ────────────────────────────────────────────────────────────
function clean(s, max) {
  let t = String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\[mention\]/gi, "")
    .replace(/@[\p{L}\p{N}._-]+(\s+[\p{Lu}][\p{L}.'-]+)?/gu, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[number]")
    .replace(/^\s*(hi|hey|hello|salam|salaam|assalamu alaikum)\b[\s,!.]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (max && t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return t;
}

// ── numbers ─────────────────────────────────────────────────────────────────
const r2 = (n) => Math.round(n * 100) / 100;
const isoDay = (d) => d.toISOString().slice(0, 10);
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}
function windowSum(dates, arr, end, days) {
  const start = addDays(end, -(days - 1));
  let sum = 0, seen = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] >= start && dates[i] <= end) { sum += Number(arr[i]) || 0; seen++; }
  }
  return seen ? { from: start, to: end, value: r2(sum), days_with_data: seen } : null;
}

const METRIC_LABELS = {
  spend: "Total paid spend, USD (Meta + Google Ads)",
  leads: "Total conversions counted as this client's result (field set per client)",
  purchases: "Purchases",
  revenue: "Revenue, USD",
  meta_spend: "Meta spend, USD",
  google_spend: "Google Ads spend, USD",
  meta_leads: "Meta conversions (this client's configured result field)",
  meta_clicks: "Meta clicks",
  google_conversions: "Google Ads conversions",
  google_clicks: "Google Ads clicks",
  gbp_actions: "Google listing actions (calls + directions + website clicks)",
  sc_clicks: "Search Console clicks",
  ga4_sessions: "Google Analytics sessions",
  ig_reach: "Instagram reach",
};

function metricsFor(c, completeThrough) {
  const dates = c.dates || [];
  const lastDate = dates[dates.length - 1];
  const out = {};
  for (const [key, arr] of Object.entries(c.series || {})) {
    if (!Array.isArray(arr)) continue;
    const end = (completeThrough && completeThrough[key]) || lastDate;
    if (!end) continue;
    const l28 = windowSum(dates, arr, end, 28);
    if (!l28) continue;
    const p28 = windowSum(dates, arr, addDays(end, -28), 28);
    const l7 = windowSum(dates, arr, end, 7);
    const p7 = windowSum(dates, arr, addDays(end, -7), 7);
    if (!l28.value && !(p28 && p28.value)) continue; // nothing in 8 weeks: leave it out
    out[key] = {
      label: METRIC_LABELS[key] || key,
      complete_through: end,
      last_7_days: l7 && { from: l7.from, to: l7.to, value: l7.value },
      prior_7_days: p7 && { from: p7.from, to: p7.to, value: p7.value },
      last_28_days: { from: l28.from, to: l28.to, value: l28.value },
      prior_28_days: p28 && { from: p28.from, to: p28.to, value: p28.value },
    };
  }
  return out;
}

function listingsFor(c, completeThrough) {
  const dates = c.dates || [];
  const end = (completeThrough && completeThrough.gbp_actions) || dates[dates.length - 1];
  if (!end) return [];
  return (c.profiles_daily || []).map((p) => {
    const row = { listing: p.label, window: null };
    for (const k of ["calls", "directions", "web_clicks", "impressions"]) {
      const w = Array.isArray(p[k]) ? windowSum(dates, p[k], end, 28) : null;
      if (w) { row[k] = w.value; row.window = `${w.from} to ${w.to}`; }
    }
    return row;
  });
}

// ── Monday ──────────────────────────────────────────────────────────────────
function daysAgo(day, today) {
  if (!day) return null;
  const d = new Date(String(day).length === 10 ? `${day}T00:00:00Z` : day);
  if (isNaN(d)) return null;
  return Math.max(0, Math.floor((today - d) / 86400000));
}

function latestUpdate(it) {
  const all = [...(it.recent_updates || [])];
  for (const s of it.subitems || []) for (const u of s.recent_updates || []) all.push({ ...u, on_subitem: s.name });
  all.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  for (const u of all) {
    const text = clean(u.text, 240);
    if (text.length > 12) return { date: u.date, author: u.author, on_subitem: u.on_subitem, text };
  }
  return null;
}

function mondayFor(items, sensitive, today) {
  const out = [];
  for (const it of items || []) {
    const quiet = daysAgo(it.last_activity || it.updated_at, today);
    const done = /^done$/i.test(String(it.status || "").trim());
    if (done && quiet != null && quiet > 30) continue; // old finished work adds noise
    const subs = it.subitems || [];
    const row = {
      item: clean(it.name, 120),
      board: it.board,
      status: it.status || "(blank)",
      people: it.people || null,
      created: it.created_at || null,
      last_activity: it.last_activity || null,
      days_since_activity: quiet,
      due: it.due || null,
    };
    if (subs.length) {
      row.subitems_done = `${subs.filter((s) => /^done$/i.test(String(s.status || ""))).length} of ${subs.length}`;
      row.subitems = subs.slice(0, 8).map((s) => `${clean(s.name, 60)} (${s.status || "blank"})`);
    }
    if (!sensitive) {
      const u = latestUpdate(it);
      if (u) row.latest_update = u;
    }
    out.push(row);
  }
  out.sort((a, b) => (a.days_since_activity ?? 9999) - (b.days_since_activity ?? 9999));
  return out;
}

// ── profile facts ───────────────────────────────────────────────────────────
function profileFor(p) {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) {
    if (!v) continue;
    out[k] = typeof v === "object" ? { value: clean(v.value, 160), as_of: v.at || null, confidence: v.confidence || null } : clean(v, 160);
  }
  return out;
}

// ── digest ──────────────────────────────────────────────────────────────────
function buildDigest({ ops, hub, monday }) {
  const today = new Date();
  const settings = (ops && ops.settings) || {};
  const skip = new Set([...(settings.not_clients || ["CAPI Setup", "Unassigned"]), ...(settings.inactive_clients || []), "Unmapped"]);
  const names = [...new Set([...Object.keys((monday && monday.by_client) || {}), ...Object.keys((hub && hub.clients) || {})])]
    .filter((n) => n && !skip.has(n))
    .sort();
  const ct = (hub && hub.complete_through) || {};

  const clients = {};
  for (const name of names) {
    const sensitive = HEALTHCARE.includes(name);
    const h = (hub.clients || {})[name] || {};
    const o = (ops.clients || {})[name] || null;
    const c = { result_type: h.kind || (o && o.kind) || null, privacy: sensitive ? "healthcare: update and chat text withheld" : null };

    if (h.profile) c.profile = profileFor(h.profile);
    if (h.system) c.booking_or_ops_system = h.system;

    if (o) {
      c.paid_this_week_vs_last = {
        source: "Windsor (Meta + Google Ads), from ops.json",
        this_window: { from: ops.window.cur[0], to: ops.window.cur[1], ...o.cur },
        prior_window: { from: ops.window.prev[0], to: ops.window.prev[1], ...o.prev },
        ads_complete_through: o.through || ops.through,
        last_day_with_spend: o.last_spend || null,
        has_paid: o.has_paid,
      };
      if (o.daily && o.daily.dates) {
        c.paid_daily_last_28 = { dates: o.daily.dates, spend: o.daily.spend, results: o.daily.results };
      }
    }

    const m = metricsFor(h, ct);
    if (Object.keys(m).length) c.metrics = m;

    const listings = listingsFor(h, ct);
    if (listings.length) c.google_listings_28_days = listings;

    if (h.crm) c.ghl_crm = { ...h.crm, note: `GHL, last ${h.crm.window_days || 28} days` };
    if (h.windsor_leads_28d != null) c.form_leads_28_days = h.windsor_leads_28d;

    const sl = h.source_list;
    if (sl) {
      c.data_sources = {
        windsor: (sl.windsor || []).map((w) => ({ connector: w.name, last_data: w.last || "none" })),
        listings: (sl.listings || []).map((l) => ({ listing: l.label, sending_data: !!l.has_data })),
        ghl: sl.ghl ? (sl.ghl.data ? "connected, sending data" : sl.ghl.configured ? "set up, no data" : "not connected") : null,
        whatsapp_last_read: sl.chats || null,
        meetings_last_read: sl.meetings || null,
        playbook: !!sl.playbook,
      };
    }

    const threads = h.threads || [];
    if (threads.length) {
      c.chats_awaiting_reply = threads.map((t) =>
        sensitive
          ? { chat: t.chat, since: t.at, hours_unanswered: t.hours }
          : { chat: t.chat, since: t.at, hours_unanswered: t.hours, message: clean(t.text, 180) }
      );
    }
    if (!sensitive && (h.said || []).length) {
      c.decisions_and_commitments = h.said.map((s) => ({ type: s.subject, what: clean(s.value, 200), by: s.by, on: s.at, where: s.where }));
    }

    const shipped = (ops.shipped || []).filter((s) => s.client === name);
    if (shipped.length) c.recently_completed = shipped.map((s) => ({ item: clean(s.name, 120), date: s.date }));

    const items = mondayFor(((monday && monday.by_client) || {})[name], sensitive, today);
    if (items.length) c.monday_items = items;

    clients[name] = c;
  }

  return {
    today: isoDay(today),
    as_of: {
      monday_snapshot: (monday && monday.generated_at) || null,
      numbers_built: (hub && hub.generated_at) || null,
      ads_complete_through: (ops && ops.through) || null,
      metric_complete_through: ct,
    },
    boards: settings.boards || null,
    status_meaning: {
      queued: ["Start", "(blank)"],
      in_progress: ["Ongoing", "In Progress", "Working on it"],
      review: ["For Review"],
      blocked: ["Stuck", "Waiting", "any item name containing ⛔"],
      done: ["Done"],
    },
    clients,
  };
}

// ── prompt ──────────────────────────────────────────────────────────────────
const RULES = `You answer questions from the Flow Co team inside their Flow Ops dashboard. Flow Co is a marketing agency; the clients below are its clients. You are read-only and you only know what is in DATA.

Source of truth
- Answer only from DATA. If the answer is not there, say "That isn't in today's data" and say what would be needed. Never estimate, extrapolate or fill gaps from general knowledge.
- Every number you give names its window (dates) and where it comes from (Meta, Google Ads, Google listings, Search Console, GHL, Monday). Use the window labels already attached to the number in DATA.
- Never compare numbers from windows of different lengths as if they were comparable. Organic listing numbers are 28-day; paid has both 7-day and 28-day versions. Say which you used.
- Data is a daily snapshot, not live. When freshness matters, say when it is from using as_of. Live Monday changes since then are not visible to you.
- "result_type" says what a client's conversions mean (leads, sales). Use the client's own result wording.
- Monday status mapping is in status_meaning. days_since_activity is how long since anyone touched the item; an item can be in progress and still stale.

Privacy
- Never output the name, email, phone number or ID of any patient, lead or customer. Team members and client business contacts are fine.
- For clients marked privacy "healthcare", update text and chat text are withheld. If asked for them, say they are withheld here and to open the item in Monday.

Limits
- You cannot change anything: not Monday, not tasks, not settings. If asked to, say this tab is read-only and point to the Tasks tab or Monday.

Style
- Lead with the answer. Default to 2 to 5 short plain sentences.
- Use a short list only when covering several clients or items. No headers. No tables.
- Bold at most one key figure per answer. No em dashes.
- If the question is ambiguous between clients, answer for the most likely one and say which you assumed.`;

// ── handler ─────────────────────────────────────────────────────────────────
export default async (req, context) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const pass = env("OPS_PASSCODE");
  if (!sameSecret(req.headers.get("x-ops-key"), pass)) return json(401, { error: "unauthorized" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Send JSON." }); }

  const question = String((body && body.question) || "").trim();
  if (!question) return json(400, { error: "Ask a question." });
  if (question.length > MAX_QUESTION) return json(400, { error: `Keep questions under ${MAX_QUESTION} characters.` });

  const key = env("ANTHROPIC_API_KEY");
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY is not set for functions on Netlify." });

  const base = String((context && context.site && context.site.url) || env("URL") || SITE_FALLBACK).replace(/^http:/, "https:").replace(/\/$/, "");

  let state;
  try { state = await loadState(base); } catch (err) {
    console.error("ask: state read failed:", err.message);
    return json(502, { error: "Couldn't read today's data files. Try again in a minute." });
  }
  const digest = buildDigest(state);

  const messages = [];
  const hist = Array.isArray(body.history) ? body.history.slice(-MAX_EXCHANGES) : [];
  for (const h of hist) {
    const q = String((h && h.q) || "").slice(0, MAX_HISTORY_TEXT).trim();
    const a = String((h && h.a) || "").slice(0, MAX_HISTORY_TEXT).trim();
    if (q && a) messages.push({ role: "user", content: q }, { role: "assistant", content: a });
  }
  messages.push({ role: "user", content: question });

  const focus = String((body && body.focus) || "").slice(0, 80);
  const system = [
    { type: "text", text: RULES },
    { type: "text", text: `DATA (JSON):\n${JSON.stringify(digest)}`, cache_control: { type: "ephemeral" } },
  ];
  if (focus && digest.clients[focus]) {
    system.push({ type: "text", text: `The person has "${focus}" selected in the sidebar. If they say "this client" or "this one", they mean ${focus}. A question that names no client is about all clients unless it clearly continues an earlier question about one.` });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 50000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env("ASK_MODEL") || MODEL_DEFAULT, max_tokens: MAX_TOKENS, system, messages }),
    });
    const msg = await res.json().catch(() => ({}));
    if (!res.ok || msg.type === "error") {
      console.error("ask: Anthropic error", res.status, msg && msg.error && msg.error.type);
      return json(502, { error: res.status === 529 ? "The model is busy. Try again in a minute." : "The model call failed. Try again in a minute." });
    }
    const answer = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return json(200, {
      answer: answer || "No answer came back. Try rephrasing.",
      as_of: { monday: digest.as_of.monday_snapshot, ads_through: digest.as_of.ads_complete_through },
    });
  } catch (err) {
    console.error("ask: request failed:", err.name === "AbortError" ? "timeout" : err.message);
    return json(504, { error: "That took too long. Try a narrower question." });
  } finally {
    clearTimeout(timer);
  }
};
