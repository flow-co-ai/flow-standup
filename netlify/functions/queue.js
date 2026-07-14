// GET  -> the live draft queue (drafted daily by Naz's fireflies-monday-watch
//         Cowork automation, written to checks/draft-queue.json on the state branch).
// POST -> patch one item by id: { id, patch: { status: "done" } } etc.
//         Uses the same OPS_PASSCODE gate as the existing checkmark endpoint.

const { getJSON, putJSON } = require("./lib/github");

const QUEUE_PATH = "checks/draft-queue.json";
const EMPTY = { updatedAt: null, items: [] };

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"] || JSON.parse(event.body || "{}").passcode;
    if (passcode !== process.env.OPS_PASSCODE) {
      return json(401, { error: "unauthorized" });
    }

    if (event.httpMethod === "GET") {
      const { data } = await getJSON(QUEUE_PATH, EMPTY);
      return json(200, data);
    }

    if (event.httpMethod === "POST") {
      const { id, patch } = JSON.parse(event.body || "{}");
      if (!id || !patch) return json(400, { error: "need id and patch" });
      const { data, sha } = await getJSON(QUEUE_PATH, EMPTY);
      const idx = data.items.findIndex((it) => it.id === id);
      if (idx === -1) return json(404, { error: `no item with id ${id}` });
      data.items[idx] = { ...data.items[idx], ...patch, updatedAt: new Date().toISOString() };
      data.updatedAt = new Date().toISOString();
      await putJSON(QUEUE_PATH, data, `dashboard: update ${id}`, sha);
      return json(200, data);
    }

    return json(405, { error: "method not allowed" });
  } catch (err) {
    // Without this, any GitHub API hiccup (expired token, rate limit, sha
    // conflict from a concurrent write) threw uncaught here — Netlify turned
    // that into a non-JSON 502, which also crashed the frontend's res.json()
    // call and rendered as an empty queue with no clue why.
    console.error("queue function error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};
