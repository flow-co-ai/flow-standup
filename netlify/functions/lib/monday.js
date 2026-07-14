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
// v1: one item + one update per queue card.
async function sendQueueItemToMonday(id) {
  const { data, sha } = await getJSON(QUEUE_PATH, { updatedAt: null, items: [] });
  const idx = data.items.findIndex((it) => it.id === id);
  if (idx === -1) return { error: `no item with id ${id}` };
  const item = data.items[idx];
  const payload = item.payload;
  if (!payload || !payload.boardId || !payload.groupId || !payload.itemName) {
    return { error: "this draft is missing a full payload — use /monday-task manually for it" };
  }

  const created = await mondayGraphQL(
    `mutation($board: ID!, $group: String!, $name: String!, $cols: JSON) {
       create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cols) { id }
     }`,
    { board: payload.boardId, group: payload.groupId, name: payload.itemName, cols: JSON.stringify(payload.columnValues || {}) }
  );
  const itemId = created.create_item.id;

  if (payload.updateBody) {
    await mondayGraphQL(`mutation($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`, {
      item: itemId,
      body: payload.updateBody,
    });
  }

  data.items[idx] = { ...item, status: "sent", mondayItemId: itemId, updatedAt: new Date().toISOString() };
  data.updatedAt = new Date().toISOString();
  await putJSON(QUEUE_PATH, data, `send-to-monday: fired ${id}`, sha);
  return { ok: true, mondayItemId: itemId };
}

module.exports = { mondayGraphQL, sendQueueItemToMonday };
