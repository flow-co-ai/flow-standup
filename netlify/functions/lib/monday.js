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
  const { data } = await getJSON(QUEUE_PATH, { updatedAt: null, items: [] });
  const idx = data.items.findIndex((it) => it.id === id);
  if (idx === -1) return { error: `no item with id ${id}` };
  const item = data.items[idx];
  const payload = item.payload;
  if (!payload) {
    return { error: "this draft has no payload -- use /monday-task manually for it" };
  }
  // A card's dashboard status can be reverted back to active after a real send
  // (the "undo" button on a Handled card is one flip away from doing exactly
  // this) -- but the real Monday item already exists once mondayItemId is set,
  // so sending again here would create a genuine duplicate on the board. This
  // is the actual fix, not just refusing based on the (revertible) status.
  if (item.mondayItemId) {
    return { error: `already sent to Monday as item ${item.mondayItemId} -- sending again would create a duplicate. Edit the real Monday item directly instead.` };
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

    // Re-fetch fresh right before writing the "sent" flag. The create/update
    // calls above are real network round trips to Monday -- long enough for a
    // concurrent write elsewhere (another card's chat, the automation) to move
    // checks/draft-queue.json out from under the sha we read at the top. Writing
    // with that stale sha throws a 409 here *after* the real Monday item already
    // exists, which was silently leaving cards stuck showing active with a real
    // duplicate-risk item sitting on Monday. Same fix pattern as item-chat.js's
    // tool calls.
    const fresh = await getJSON(QUEUE_PATH, { updatedAt: null, items: [] });
    const freshIdx = fresh.data.items.findIndex((it) => it.id === id);
    if (freshIdx === -1) {
      return { ok: true, mondayItemId: resultItemId, mode, warning: `sent to Monday, but item ${id} no longer exists in the queue to mark as sent` };
    }
    fresh.data.items[freshIdx] = { ...fresh.data.items[freshIdx], status: "sent", mondayItemId: resultItemId, updatedAt: new Date().toISOString() };
    fresh.data.updatedAt = new Date().toISOString();
    await putJSON(QUEUE_PATH, fresh.data, `send-to-monday: fired ${id} (${mode})`, fresh.sha);

    return { ok: true, mondayItemId: resultItemId, mode };
  } catch (err) {
    // Mirrors the queue.js fix: log server-side so a Monday API failure is
    // diagnosable in the function logs, not just a silent {error} the caller drops.
    console.error("sendQueueItemToMonday error:", err);
    return { error: String(err) };
  }
}

// Pushes a status/people (or any column) change onto an item that already
// exists for real on a Monday board -- used by item-chat.js's edit_item tool
// when Naz reassigns or reopens something after it's already been sent.
async function updateMondayColumns(boardId, itemId, columnValues) {
  await mondayGraphQL(
    `mutation($board: ID!, $item: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cols) { id }
     }`,
    { board: boardId, item: itemId, cols: JSON.stringify(columnValues) }
  );
}

module.exports = { mondayGraphQL, sendQueueItemToMonday, updateMondayColumns };
