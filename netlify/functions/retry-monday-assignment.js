// "Retry assignment" -- only ever called by a human clicking the button that
// appears on a card carrying a live `sendWarning` (site/addon.js). The card
// already exists for real on Monday (mondayItemId is set); this never
// creates anything, it only re-runs the status/people push and the parent's
// Ongoing roll-up that failed the first time -- see
// lib/monday.js's retrySubitemAssignment for why re-running them
// unconditionally is safe.

const { retrySubitemAssignment } = require("./lib/monday");

exports.handler = async (event) => {
  const pass_ = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
  if (pass_ !== process.env.OPS_PASSCODE) {
    return { statusCode: 401, body: "unauthorized" };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method not allowed" };

  const { id } = JSON.parse(event.body || "{}");
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: "need id" }) };

  try {
    const result = await retrySubitemAssignment(id);
    if (result.error) return { statusCode: 400, body: JSON.stringify(result) };
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
