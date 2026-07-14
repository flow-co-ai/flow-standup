// GET  -> the live draft queue (drafted daily by Naz's fireflies-monday-watch
//         Cowork automation, written to checks/draft-queue.json on the state branch).
// POST -> patch one item by id: { id, patch: { status: "done" } } etc.
//         Uses the same OPS_PASSCODE gate as the existing checkmark endpoint.

const { getJSON, putJSON } = require("./lib/github");

const QUEUE_PATH = "checks/draft-queue.json";
const EMPTY = { updatedAt: null, items: [] };

exports.handler = async (event) => {
  const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"] || JSON.parse(event.body || "{}").passcode;
  if (passcode !== process.env.OPS_PASSCODE) {
    return { statusCode: 401, body: "unauthorized" };
  }

  if (event.httpMethod === "GET") {
    const { data } = await getJSON(QUEUE_PATH, EMPTY);
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
  }

  if (event.httpMethod === "POST") {
    const { id, patch } = JSON.parse(event.body || "{}");
    if (!id || !patch) return { statusCode: 400, body: JSON.stringify({ error: "need id and patch" }) };
    const { data, sha } = await getJSON(QUEUE_PATH, EMPTY);
    const idx = data.items.findIndex((it) => it.id === id);
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: `no item with id ${id}` }) };
    data.items[idx] = { ...data.items[idx], ...patch, updatedAt: new Date().toISOString() };
    data.updatedAt = new Date().toISOString();
    await putJSON(QUEUE_PATH, data, `dashboard: update ${id}`, sha);
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
  }

  return { statusCode: 405, body: "method not allowed" };
};
