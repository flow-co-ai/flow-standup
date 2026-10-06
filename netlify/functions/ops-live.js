// GET -> every item on the four Monday boards, read live, in the same shape
// as site/monday-items.json (written daily by write_monday_snapshot.py), so
// the Ops page (site/index.html) shows Monday as it is right now and falls
// back to the morning snapshot if this call fails.
//
// Read-only. Same OPS_PASSCODE gate as every other function here.

const { boards } = require("../../config.json");
const { resolveClientName } = require("./lib/clientAliases");
const { getJSON } = require("./lib/github");

const CACHE_TTL_MS = 60_000;
let cache = null; // { expiresAt, body }

const FIELDS = `
  id name created_at updated_at
  group { title }
  column_values { id type text }
  updates(limit: 1) { created_at creator { name } }
`;
const Q_FIRST = `query ($ids: [ID!]!) { boards(ids: $ids) { items_page(limit: 100) { cursor items { ${FIELDS} } } } }`;
const Q_NEXT = `query ($c: String!) { next_items_page(limit: 100, cursor: $c) { cursor items { ${FIELDS} } } }`;

async function gql(query, variables) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: process.env.MONDAY_API_TOKEN,
      "Content-Type": "application/json",
      "API-Version": "2023-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function boardItems(boardId) {
  const first = await gql(Q_FIRST, { ids: [String(boardId)] });
  let page = first.boards[0].items_page;
  const items = [...page.items];
  while (page.cursor && page.items.length) {
    page = (await gql(Q_NEXT, { c: page.cursor })).next_items_page;
    items.push(...page.items);
  }
  return items;
}

// First column of a type, matched by type because column ids differ per board.
function colText(item, type) {
  const cv = (item.column_values || []).find((c) => c.type === type);
  const t = cv && cv.text ? cv.text.trim() : "";
  return t || null;
}

function dueFromTimeline(text) {
  const dates = (text || "").match(/\d{4}-\d{2}-\d{2}/g);
  return dates ? dates[dates.length - 1] : null;
}

function shape(item, board) {
  const upd = (item.updates || [])[0];
  return {
    monday_item_id: String(item.id),
    name: item.name || "",
    board: board.name,
    status: colText(item, "status"),
    monday_url: `https://flowcompany.monday.com/boards/${board.id}/pulses/${item.id}`,
    updated_at: upd ? upd.created_at : null, // newest update post
    last_by: upd && upd.creator ? upd.creator.name : null,
    item_updated_at: item.updated_at || null, // any change, including status
    people: colText(item, "people"),
    created_at: (item.created_at || "").slice(0, 10) || null,
    last_activity: colText(item, "date"),
    due: dueFromTimeline(colText(item, "timeline")),
  };
}

// Recent "status changed to Done" events recorded by monday-done-webhook.js.
// Same filter as build_ops.py: real webhook events only, last 14 days.
async function shippedEvents(days = 14) {
  const { data: acc } = await getJSON("standups/completed-accumulator.json", {}, "main");
  const weeks = [{ items: acc.items || [] }, ...(acc.history || [])];
  const cutoff = Date.now() - days * 86400000;
  const seen = new Set();
  const out = [];
  for (const week of weeks) {
    for (const e of week.items || []) {
      if (e.source !== "MON" || e.generated === true) continue;
      const date = (e.sourceDate || "").slice(0, 10);
      if (!date || new Date(date + "T12:00:00Z").getTime() < cutoff) continue;
      const key = e.monday_item_id || e.text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        monday_item_id: e.monday_item_id || null,
        name: (e.text || "").replace("Marked Done on Monday:", "").trim(),
        client: e.client || null,
        date,
      });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
    if (passcode !== process.env.OPS_PASSCODE) return json(401, { error: "unauthorized" });
    if (event.httpMethod !== "GET") return json(405, { error: "method not allowed" });

    if (cache && cache.expiresAt > Date.now()) return json(200, { ...cache.body, cached: true });

    const by_client = {};
    for (const board of boards) {
      const items = await boardItems(board.id);
      for (const it of items) {
        const client = resolveClientName((it.group && it.group.title) || "") || "Unassigned";
        (by_client[client] = by_client[client] || []).push(shape(it, board));
      }
    }

    let shipped = null; // null = couldn't read; page then keeps the morning list
    try { shipped = await shippedEvents(); } catch (e) { console.error("ops-live shipped:", e); }

    const body = { generated_at: new Date().toISOString(), live: true, by_client, shipped };
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, body };
    return json(200, { ...body, cached: false });
  } catch (err) {
    console.error("ops-live error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};
