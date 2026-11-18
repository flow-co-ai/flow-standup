// Work reports: the weekly "here's what we did" message to each client.
//
// GET                         -> { due_days, last_sent: { [client]: entry }, recent: [entry] }
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
const { parseWindow, sameSecret, clip, DUE_DAYS, JOB_ID, jobPath } = require("./lib/workReport");

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
      const { data } = await getJSON(LOG_PATH, { entries: [] });
      const entries = data.entries || [];
      return json(200, { due_days: DUE_DAYS, last_sent: lastSentByClient(entries), recent: entries.slice(-40).reverse().map(({ text, ...e }) => e) });
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    const body = JSON.parse(event.body || "{}");
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
    const { text: _omit, ...shown } = entry;
    return json(200, { ok: true, entry: shown });
  } catch (err) {
    console.error("work-report error:", err);
    return json(err.status || 500, { error: String((err && err.message) || err) });
  }
};
