// GET  -> the live draft queue (drafted daily by Naz's fireflies-monday-watch
//         Cowork automation, written to checks/draft-queue.json on the state branch).
// POST -> patch one item by id: { id, patch: { status: "done" } } etc.
//         Uses the same OPS_PASSCODE gate as the existing checkmark endpoint.

const { getJSON, updateJSON } = require("./lib/github");
const { enforceSentInvariant, mondayItemNameAndParent, BOARD_LABEL_IDS, CLIENT_GROUPS } = require("./lib/monday");

const QUEUE_PATH = "checks/draft-queue.json";
const EMPTY = { updatedAt: null, items: [] };

class NotFoundError extends Error {}

// Same source of truth the pipeline itself routes with (lib/monday.js) --
// the dashboard's board/group dropdowns are populated from this, not a
// second hand-maintained copy of the client roster.
function routingOptions() {
  const boardIds = {};
  for (const [name, id] of Object.entries(BOARD_LABEL_IDS)) {
    if (name === "Dev+SEO") continue; // same board/id as "Web+SEO" -- one dropdown option, not two
    boardIds[name] = id;
  }
  return { boards: Object.keys(boardIds), boardIds, groupsByClient: CLIENT_GROUPS };
}

// update_only payloads only ever carry existingItemId (see SKILL.md A4h) --
// never a name, since nothing new is being created. create_subitem/update_
// only payloads that DO reference a parent (parentItemId) never carry the
// parent's name either. Both used to render as a bare numeric id on the
// card. Resolves once per item per gap, live, and the result gets persisted
// back into the payload (see the GET handler below) so this isn't a live
// Monday call on every single page load once it's resolved -- only for
// whatever's still missing it.
async function resolveMissingMondayNames(items) {
  const resolved = {};
  for (const item of items) {
    const p = item.payload;
    if (!p) continue;
    const patch = {};
    try {
      if (p.mode === "update_only" && p.existingItemId && !p.itemName) {
        const info = await mondayItemNameAndParent(p.existingItemId);
        patch.itemName = info.name;
        // Discovered live (the pipeline didn't already know this target is a
        // subitem) -- capture it the same way an explicit parentItemId would
        // have been, so the card can label it "Subitem of X" too.
        if (info.parentItem && !p.parentItemId) {
          patch.parentItemId = info.parentItem.id;
          patch.parentItemName = info.parentItem.name;
        }
      }
      if (p.parentItemId && !p.parentItemName && !patch.parentItemName) {
        const parent = await mondayItemNameAndParent(p.parentItemId);
        patch.parentItemName = parent.name;
      }
    } catch (err) {
      // Leave it as-is -- the frontend already falls back to showing the
      // bare id if itemName/parentItemName never resolve. Never let one bad
      // id (deleted item, wrong id) break the whole queue load.
      console.error(`queue.js: couldn't resolve Monday name for item ${item.id}:`, err);
    }
    if (Object.keys(patch).length) resolved[item.id] = patch;
  }
  return resolved;
}

function applyResolvedNames(items, resolved) {
  return items.map((it) => {
    const patch = resolved[it.id];
    if (!patch || !it.payload) return it;
    return { ...it, payload: { ...it.payload, ...patch } };
  });
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"] || JSON.parse(event.body || "{}").passcode;
    if (passcode !== process.env.OPS_PASSCODE) {
      return json(401, { error: "unauthorized" });
    }

    if (event.httpMethod === "GET") {
      const { data } = await getJSON(QUEUE_PATH, EMPTY);
      const resolved = await resolveMissingMondayNames(data.items || []);
      if (Object.keys(resolved).length) {
        try {
          const written = await updateJSON(QUEUE_PATH, (fresh) => {
            fresh.items = applyResolvedNames(fresh.items || [], resolved);
            return fresh;
          }, "queue: backfill resolved Monday item/parent names", { fallback: EMPTY });
          return json(200, { ...written, routing: routingOptions() });
        } catch (err) {
          // The write failed (rare -- e.g. exhausted 409 retries) but the
          // resolution itself succeeded -- still return it resolved this
          // load rather than showing bare ids again; it'll just re-resolve
          // and retry the write on the next GET.
          console.error("queue.js: resolved Monday names but failed to persist them:", err);
          data.items = applyResolvedNames(data.items || [], resolved);
        }
      }
      return json(200, { ...data, routing: routingOptions() });
    }

    if (event.httpMethod === "POST") {
      const { id, patch } = JSON.parse(event.body || "{}");
      if (!id || !patch) return json(400, { error: "need id and patch" });
      try {
        const data = await updateJSON(QUEUE_PATH, (data) => {
          const idx = data.items.findIndex((it) => it.id === id);
          if (idx === -1) throw new NotFoundError(`no item with id ${id}`);
          // enforceSentInvariant: a real Monday item existing always wins over
          // whatever this patch asked for -- e.g. "undo" on a Mondayed card
          // can't silently claim a real send never happened.
          data.items[idx] = enforceSentInvariant({ ...data.items[idx], ...patch, updatedAt: new Date().toISOString() });
          data.updatedAt = new Date().toISOString();
          return data;
        }, `dashboard: update ${id}`, { fallback: EMPTY });
        return json(200, data);
      } catch (err) {
        if (err instanceof NotFoundError) return json(404, { error: err.message });
        throw err;
      }
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
