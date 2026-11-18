// Work reports: the weekly "here's what we did" message to each client.
//
// GET                         -> { due_days, last_sent: { [client]: entry }, recent: [entry] }
// GET ?client=<name>          -> { sent: [entries with text, newest first], draft }
//                                the shared draft and send history both partners see
// POST { action: "save_draft", client, text: { whatsapp, email }, subject }
//                             -> { ok } (edits to the shared draft)
// GET ?job=<id>               -> { status: "pending" } until work-report-background.js
//                                has saved the draft, then the draft itself (and the
//                                job file is removed from the state branch)
// POST { action: "sent", client, from, to, channel, headline, text }
//                             -> { ok, entry }
//
// Drafting happens in work-report-background.js because the model call can
// outlast a normal function. Nothing is sent to a client from here: "sent"
// only logs the final text to work-reports/log.json on the state branch so
// the page can show who is due a report.
//
// Env: OPS_PASSCODE, MONDAY_API_TOKEN, ANTHROPIC_API_KEY, GH_STATE_TOKEN.

const crypto = require("crypto");
const { getJSON, updateJSON, deleteFile } = require("./lib/github");
const { resolveClientName } = require("./lib/clientAliases");
const { parseWindow, sameSecret, clip, DUE_DAYS, JOB_ID, jobPath, draftPath } = require("./lib/workReport");

const LOG_PATH = "work-reports/log.json";
const LOG_KEEP = 300;

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(obj),
});

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
      const job = (event.queryStringParameters || {}).job;
      if (job) {
        if (!JOB_ID.test(job)) return json(400, { error: "Bad job id." });
        const { data, sha } = await getJSON(jobPath(job), null);
        if (!sha) return json(200, { status: "pending" });
        await deleteFile(jobPath(job), sha, `work report draft ${job} picked up`).catch((e) => console.error("work-report: job cleanup", e));
        return json(200, data);
      }
      const q = event.queryStringParameters || {};
      if (q.client) {
        const client = resolveClientName(String(q.client));
        const [{ data: log }, { data: draft }] = await Promise.all([getJSON(LOG_PATH, { entries: [] }), getJSON(draftPath(client), null)]);
        const sent = (log.entries || []).filter((e) => e.client === client).slice(-10).reverse();
        return json(200, { client, sent, draft: draft && draft.data ? draft : null });
      }
      const { data } = await getJSON(LOG_PATH, { entries: [] });
      const entries = data.entries || [];
      return json(200, { due_days: DUE_DAYS, last_sent: lastSentByClient(entries), recent: entries.slice(-40).reverse().map(({ text, ...e }) => e) });
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    const body = JSON.parse(event.body || "{}");
    if (body.action === "save_draft") {
      const client = resolveClientName(String(body.client || "").trim());
      const text = body.text || {};
      // Throwing inside the mutate aborts without writing anything.
      await updateJSON(draftPath(client), (d) => {
        if (!d || !d.data) throw Object.assign(new Error("No shared draft for this client. Draft one first."), { status: 404 });
        return { ...d, text: { whatsapp: clip(text.whatsapp, 12000), email: clip(text.email, 12000) }, subject: clip(body.subject, 300), editedAt: new Date().toISOString() };
      }, `work report draft edited: ${client}`, { fallback: null });
      return json(200, { ok: true });
    }
    if (body.action !== "sent") return json(400, { error: "Unknown action." });
    const { client, w } = parseWindow(body);
    const text = String(body.text || "").trim();
    if (!text) return json(400, { error: "Nothing to log: the report is empty." });
    const entry = {
      id: crypto.randomUUID(), client, from: w.from, to: w.to,
      channel: ["whatsapp", "email"].includes(body.channel) ? body.channel : "other",
      headline: clip(body.headline, 200), text: clip(text, 12000), sentAt: new Date().toISOString(),
    };
    await updateJSON(LOG_PATH, (d) => ({ entries: [...(d.entries || []), entry].slice(-LOG_KEEP) }), `work report sent: ${client} ${w.from}..${w.to}`, { fallback: { entries: [] } });
    // Mark the shared draft as sent so the other partner sees it was handled.
    await updateJSON(draftPath(client), (d) => {
      if (!d || !d.data) throw new Error("no shared draft to mark");
      const t = { ...(d.text || {}) };
      if (entry.channel === "whatsapp") t.whatsapp = text; // what actually went out
      return { ...d, sentAt: entry.sentAt, sentChannel: entry.channel, text: t };
    }, `work report draft sent: ${client}`, { fallback: null }).catch((e) => console.error("work-report: couldn't mark draft sent:", e.message));
    const { text: _omit, ...shown } = entry;
    return json(200, { ok: true, entry: shown });
  } catch (err) {
    console.error("work-report error:", err);
    return json(err.status || 500, { error: String((err && err.message) || err) });
  }
};
