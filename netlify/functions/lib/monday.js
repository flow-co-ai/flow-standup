// Payload modes supported by sendQueueItemToMonday:
//   create_item    (original) -- needs boardId, groupId, itemName, columnValues
//   create_subitem             -- needs parentItemId, itemName, optional columnValues
//   update_only                -- needs existingItemId, just posts the update, creates nothing

const { getJSON, putJSON } = require("./github");

const QUEUE_PATH = "checks/draft-queue.json";

async function mondayGraphQL(query, variables) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { Authorization: process.env.MONDAY_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Shared by send-to-monday.js (button click) and chat.js (the send_to_monday tool).
async function sendQueueItemToMonday(id) {
  const { data, sha } = await getJSON(QUEUE_PATH, { updatedAt: null, items: [] });
  const idx = data.items.findIndex((it) => it.id === id);
  if (idx === -1) return { error: `no item with id ${id}` };
  const item = data.items[idx];
  const payload = item.payload;
  if (!payload) {
    return { error: "this draft has no payload -- use /monday-task manually for it" };
  }

  const mode = payload.mode || "create_item"; // default for any older payloads without a mode field
  let resultItemId;

  try {
    if (mode === "create_item") {
      if (!payload.boardId || !payload.groupId || !payload.itemName) {
        return { error: "create_item payload missing boardId/groupId/itemName" };
      }
      const created = await mondayGraphQL(
        `mutation($board: ID!, $group: String!, $name: String!, $cols: JSON) {
           create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cols) { id }
         }`,
        { board: payload.boardId, group: payload.groupId, name: payload.itemName, cols: JSON.stringify(payload.columnValues || {}) }
      );
      resultItemId = created.create_item.id;
    } else if (mode === "create_subitem") {
      if (!payload.parentItemId || !payload.itemName) {
        return { error: "create_subitem payload missing parentItemId/itemName" };
      }
      const created = await mondayGraphQL(
        `mutation($parent: ID!, $name: String!, $cols: JSON) {
           create_subitem(parent_item_id: $parent, item_name: $name, column_values: $cols) { id }
         }`,
        { parent: payload.parentItemId, name: payload.itemName, cols: JSON.stringify(payload.columnValues || {}) }
      );
      resultItemId = created.create_subitem.id;
    } else if (mode === "update_only") {
      if (!payload.existingItemId) {
        return { error: "update_only payload missing existingItemId" };
      }
      resultItemId = payload.existingItemId; // no create call at all, just post the update below
    } else {
      return { error: `unknown payload mode: ${mode}` };
    }

    if (payload.updateBody) {
      await mondayGraphQL(`mutation($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`, {
        item: resultItemId,
        body: payload.updateBody,
      });
    }

    data.items[idx] = { ...item, status: "sent", mondayItemId: resultItemId, updatedAt: new Date().toISOString() };
    data.updatedAt = new Date().toISOString();
    await putJSON(QUEUE_PATH, data, `send-to-monday: fired ${id} (${mode})`, sha);

    return { ok: true, mondayItemId: resultItemId, mode };
  } catch (err) {
    // Mirrors the queue.js fix: log server-side so a Monday API failure is
    // diagnosable in the function logs, not just a silent {error} the caller drops.
    console.error("sendQueueItemToMonday error:", err);
    return { error: String(err) };
  }
}

module.exports = { mondayGraphQL, sendQueueItemToMonday };
