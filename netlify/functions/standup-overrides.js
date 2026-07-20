// GET  -> current overrides file. The frontend's normal read path is the
//         public raw-GitHub URL (same pattern as checks/<week>.json via
//         loadRemoteChecks()) -- this GET exists mainly so the writer side
//         can inspect state directly if needed, mirroring queue.js.
// POST -> one action against checks/standup-overrides.json on the state
//         branch. Same OPS_PASSCODE gate as queue.js/save-checks.js.
//
// Unlike checks/<week>.json (legitimately per-week -- checkmarks reset every
// week), this file is NOT week-scoped: a hide/rename/reorder is meant to
// stick even after the pipeline regenerates latest.json next week. Cards are
// identified by a stable key the frontend derives from the live standup.json
// (`client:<name>` / `prospect:<name>`), or by a manual prospect's own id --
// nothing here needs to know about weeks at all.
//
// Actions:
//   reorder              { order: [key, ...] }        -- rank = array index, for every key given
//   hide / unhide         { key }
//   edit                  { key, patch: {...} }        -- headline (clients) / name+summary (prospects)
//   addProspect           { name, summary? }           -- creates a manualProspects entry
//   removeManualProspect  { id }                       -- hard delete (manual entries only)

const { getJSON, updateJSON } = require("./lib/github");

const OVERRIDES_PATH = "checks/standup-overrides.json";
const EMPTY = { updatedAt: null, overrides: {}, manualProspects: [] };

class NotFoundError extends Error {}
class BadRequestError extends Error {}

function nextManualId(existing) {
  let n = 1;
  while (existing.some((p) => p.id === `manual-${n}`)) n++;
  return `manual-${n}`;
}

// Shared by this file's own HTTP handler AND ops-chat.js's global standup-
// card tools -- one retry-safe write path (updateJSON's retry-on-409) for
// every action, so the global assistant never gets a second, looser copy of
// this logic. Throws NotFoundError/BadRequestError on a bad request; callers
// decide how to turn that into a response (HTTP status here, a tool_result
// error string in ops-chat.js).
async function applyStandupOverrideAction(body) {
  return updateJSON(OVERRIDES_PATH, (data) => {
    data.overrides = data.overrides || {};
    data.manualProspects = data.manualProspects || [];

    switch (body.action) {
      case "reorder": {
        if (!Array.isArray(body.order) || !body.order.length) throw new BadRequestError("need a non-empty order: []");
        body.order.forEach((key, i) => {
          data.overrides[key] = { ...(data.overrides[key] || {}), rank: i };
        });
        break;
      }
      case "hide":
      case "unhide": {
        if (!body.key) throw new BadRequestError("need key");
        data.overrides[body.key] = { ...(data.overrides[body.key] || {}), hidden: body.action === "hide" };
        break;
      }
      case "edit": {
        if (!body.key || !body.patch) throw new BadRequestError("need key and patch");
        // A manual prospect's name/summary IS its base content, not an
        // override of something pipeline-generated -- edit it in place.
        if (body.key.startsWith("manual-")) {
          const idx = data.manualProspects.findIndex((p) => p.id === body.key);
          if (idx === -1) throw new NotFoundError(`no manual prospect ${body.key}`);
          data.manualProspects[idx] = { ...data.manualProspects[idx], ...body.patch };
        } else {
          data.overrides[body.key] = { ...(data.overrides[body.key] || {}), ...body.patch };
        }
        break;
      }
      case "addProspect": {
        if (!body.name || !body.name.trim()) throw new BadRequestError("need name");
        const id = nextManualId(data.manualProspects); // already "manual-<n>" -- don't re-prefix
        data.manualProspects.push({
          id,
          name: body.name.trim(),
          summary: body.summary || "",
          createdAt: new Date().toISOString(),
        });
        break;
      }
      case "removeManualProspect": {
        if (!body.id) throw new BadRequestError("need id");
        const idx = data.manualProspects.findIndex((p) => p.id === body.id);
        if (idx === -1) throw new NotFoundError(`no manual prospect ${body.id}`);
        data.manualProspects.splice(idx, 1);
        delete data.overrides[body.id];
        break;
      }
      default:
        throw new BadRequestError(`unknown action ${body.action}`);
    }

    data.updatedAt = new Date().toISOString();
    return data;
  }, `standup-overrides: ${body.action}`, { fallback: EMPTY });
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"] || JSON.parse(event.body || "{}").passcode;
    if (passcode !== process.env.OPS_PASSCODE) return json(401, { error: "unauthorized" });

    if (event.httpMethod === "GET") {
      const { data } = await getJSON(OVERRIDES_PATH, EMPTY);
      return json(200, data);
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    const body = JSON.parse(event.body || "{}");

    try {
      const data = await applyStandupOverrideAction(body);
      return json(200, data);
    } catch (err) {
      if (err instanceof NotFoundError) return json(404, { error: err.message });
      if (err instanceof BadRequestError) return json(400, { error: err.message });
      throw err;
    }
  } catch (err) {
    console.error("standup-overrides function error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};

exports.applyStandupOverrideAction = applyStandupOverrideAction;
exports.NotFoundError = NotFoundError;
exports.BadRequestError = BadRequestError;
exports.OVERRIDES_PATH = OVERRIDES_PATH;
exports.EMPTY = EMPTY;
