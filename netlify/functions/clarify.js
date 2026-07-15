// POST {id, message} -> stash Naz's one-line answer on a content-conflict draft
// (per-item clarify box on the dashboard) so the next automation run can
// finalize it into a real payload. Same GET-sha/PUT pattern as queue.js.

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
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    const { id, message } = JSON.parse(event.body || "{}");
    if (!id || !message) return json(400, { error: "need id and message" });

    const { data, sha } = await getJSON(QUEUE_PATH, EMPTY);
    const idx = data.items.findIndex((it) => it.id === id);
    if (idx === -1) return json(404, { error: `no item with id ${id}` });

    data.items[idx] = {
      ...data.items[idx],
      clarification: message,
      clarifiedAt: new Date().toISOString(),
      awaitingFinalize: true,
      updatedAt: new Date().toISOString(),
    };
    data.updatedAt = new Date().toISOString();
    await putJSON(QUEUE_PATH, data, `clarify: ${id}`, sha);

    return json(200, data.items[idx]);
  } catch (err) {
    console.error("clarify function error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};
