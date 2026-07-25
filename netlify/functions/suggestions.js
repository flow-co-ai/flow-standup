// suggestions.js — the human gate for performance-lens suggestions.
//
// GET  -> checks/suggestion-decisions.json (so the Performance tab can hide
//         already-decided pills and the lens can learn from dismissals).
// POST {action:"dismiss", slug, clientName, suggestion, reason}
//      -> records the dismissal + reason. The reason feeds back into the
//         next lens run (apply_performance.js reads this file).
// POST {action:"approve", slug, clientName, suggestion}
//      -> appends a draft into checks/draft-queue.json and fires it through
//         sendQueueItemToMonday — the SAME path, same substance gates, same
//         duplicate guards as every other human-approved send. Automation
//         never calls this; only the approve button does.
//
// Same OPS_PASSCODE gate as every other write endpoint.

const { getJSON, updateJSON } = require("./lib/github");
const {
  sendQueueItemToMonday,
  CLIENT_GROUPS,
  BOARD_LABEL_IDS,
} = require("./lib/monday");

const DECISIONS_PATH = "checks/suggestion-decisions.json";
const QUEUE_PATH     = "checks/draft-queue.json";

// pulse slug -> CLIENT_GROUPS key (Monday group naming)
const SLUG_TO_MONDAY = {
  "billy-doe":         "Billy Doe Meats",
  "full-smile":        "Full Smile",
  "hvac":              "Quality HVAC",
  "jcl":               "Justice Consumer Law",
  "liferun":           "Liferun",
  "maadi-law":         "Maadi Law",
  "vous-physique":     "Vous Physique",
  "steel-round-bars":  "Steel Round Bars",
  "flow-company":      "Flow Company",
  // cotton-collections / healing-helps: no Monday group mapped yet —
  // approve returns a clear error instead of guessing.
};

exports.handler = async (event) => {
  const pass_ = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
  if (pass_ !== process.env.OPS_PASSCODE) {
    return { statusCode: 401, body: "unauthorized" };
  }

  if (event.httpMethod === "GET") {
    const { data } = await getJSON(DECISIONS_PATH, { updatedAt: null, items: [] });
    return json(200, data);
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method not allowed" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "invalid JSON body" }); }

  const { action, slug, clientName, suggestion, reason } = body;
  if (!action || !slug || !suggestion?.id) {
    return json(400, { error: "need action, slug, suggestion.id" });
  }

  const decisionBase = {
    id: `${slug}:${suggestion.id}:${Date.now()}`,
    slug,
    suggestionId: suggestion.id,
    type: suggestion.type || null,
    text: suggestion.text || "",
    decidedAt: new Date().toISOString(),
  };

  if (action === "dismiss") {
    if (!reason || !reason.trim()) {
      return json(400, { error: "dismiss requires a reason — that reason is what the lens learns from" });
    }
    await recordDecision({ ...decisionBase, decision: "dismissed", reason: reason.trim() });
    return json(200, { ok: true, decision: "dismissed" });
  }

  if (action === "approve") {
    const mondayClient = SLUG_TO_MONDAY[slug];
    const groupId = mondayClient ? CLIENT_GROUPS[mondayClient]?.Ads : null;
    if (!groupId) {
      return json(400, { error: `no Ads group mapped for "${slug}" — add it to CLIENT_GROUPS / SLUG_TO_MONDAY first` });
    }
    if (!suggestion.monday_item_name || !suggestion.monday_update) {
      return json(400, { error: "suggestion is missing monday_item_name / monday_update" });
    }

    // One item, details in the update — Sohib's chosen format.
    const draftId = `perf-${slug}-${suggestion.id}`;
    const draft = {
      id: draftId,
      board: "Ads",
      client: mondayClient,
      status: "active",
      source: "performance-lens",
      createdAt: new Date().toISOString(),
      payload: {
        mode: "create_item",
        boardId: BOARD_LABEL_IDS.Ads,
        groupId,
        itemName: suggestion.monday_item_name,
        updateBody: suggestion.monday_update,
      },
    };

    // Append the draft (skip if this exact draft already exists — double-click guard).
    await updateJSON(
      QUEUE_PATH,
      (data) => {
        data.items = data.items || [];
        if (!data.items.some((it) => it.id === draftId)) data.items.push(draft);
        data.updatedAt = new Date().toISOString();
        return data;
      },
      `suggestions: draft ${draftId}`,
      { fallback: { updatedAt: null, items: [] } }
    );

    // Fire through the SAME gates as every other send (substance check,
    // duplicate guard, sent invariant) — nothing bespoke.
    const result = await sendQueueItemToMonday(draftId);
    if (result.error) return json(400, result);

    await recordDecision({
      ...decisionBase,
      decision: "approved",
      mondayItemId: result.mondayItemId,
    });
    return json(200, { ok: true, decision: "approved", mondayItemId: result.mondayItemId });
  }

  return json(400, { error: `unknown action: ${action}` });
};

async function recordDecision(decision) {
  await updateJSON(
    DECISIONS_PATH,
    (data) => {
      data.items = data.items || [];
      data.items.push(decision);
      if (data.items.length > 500) data.items = data.items.slice(-500);
      data.updatedAt = new Date().toISOString();
      return data;
    },
    `suggestions: ${decision.decision} ${decision.suggestionId} (${decision.slug})`,
    { fallback: { updatedAt: null, items: [] } }
  );
}

function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
