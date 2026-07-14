// The real "Send to Monday" action — only ever called by a human clicking the
// button on the page, never by the automation itself (fireflies-monday-watch
// only ever drafts; it never calls this).

const { sendQueueItemToMonday } = require("./lib/monday");

exports.handler = async (event) => {
  const pass_ = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
  if (pass_ !== process.env.OPS_PASSCODE) {
    return { statusCode: 401, body: "unauthorized" };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method not allowed" };

  const { id } = JSON.parse(event.body || "{}");
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: "need id" }) };

  try {
    const result = await sendQueueItemToMonday(id);
    if (result.error) return { statusCode: 400, body: JSON.stringify(result) };
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
