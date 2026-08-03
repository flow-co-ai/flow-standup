// GET ?client=<name> -> live Monday read/reply state for one client's Inbox
// pane (site/app.js's buildInboxPane), computed fresh from Monday's own
// viewers/creator_id on updates -- not the daily generate.py batch snapshot
// (site/inbox.json). Read-only, same OPS_PASSCODE gate as every other
// function here -- never writes to Monday.
//
// Short in-memory cache (per warm function container, not guaranteed across
// concurrent Netlify instances) so rapid repeat opens/refreshes of the same
// client don't re-hit Monday's API needlessly. The frontend falls back to
// the static site/inbox.json on any non-200 here.

const { mondayClientOverview, BOARD_LABEL_IDS } = require("./lib/monday");
const { buildLiveInboxEntries } = require("./lib/inbox-state");

const CACHE_TTL_MS = 45_000;
const cache = new Map(); // client -> { expiresAt, body }

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
    if (passcode !== process.env.OPS_PASSCODE) {
      return json(401, { error: "unauthorized" });
    }
    if (event.httpMethod !== "GET") return json(405, { error: "method not allowed" });

    const client = (event.queryStringParameters || {}).client;
    if (!client) return json(400, { error: "need client" });

    const cached = cache.get(client);
    if (cached && cached.expiresAt > Date.now()) {
      return json(200, { ...cached.body, cached: true });
    }

    const overview = await mondayClientOverview(client);
    const items = buildLiveInboxEntries(overview, BOARD_LABEL_IDS);
    const body = { client, generated_at: new Date().toISOString(), items };

    cache.set(client, { expiresAt: Date.now() + CACHE_TTL_MS, body });
    return json(200, { ...body, cached: false });
  } catch (err) {
    // Mirrors queue.js's fix: log server-side so a Monday API failure is
    // diagnosable in the function logs, not just a silent {error} the
    // frontend drops before falling back to the static inbox.json.
    console.error("inbox-live function error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};
