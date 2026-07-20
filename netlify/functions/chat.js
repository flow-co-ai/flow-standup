// Chat backend for the "Draft queue" panel. Client passes { topic: "queue", messages: [...] }
// so the system prompt grounds on the right data.

const { getJSON, updateJSON } = require("./lib/github");
const { mondayGraphQL, sendQueueItemToMonday, enforceSentInvariant } = require("./lib/monday");

const ANTHROPIC_MODEL = "claude-sonnet-4-5"; // check docs.claude.com/en/docs/about-claude/models if this starts erroring
const QUEUE_PATH = "checks/draft-queue.json";

// Aborts an updateJSON write without retrying (item genuinely doesn't exist) --
// see lib/github.js's updateJSON for why only a ConflictError should retry.
class ToolAbort extends Error {}

const TOOLS = [
  {
    name: "monday_lookup",
    description: "Search a Monday.com board for items matching a keyword. Returns id, name, and column values for matches.",
    input_schema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "18405754310 (Ads), 18099807701 (Web+SEO), 18418241405 (CRM)" },
        searchTerm: { type: "string" },
      },
      required: ["boardId", "searchTerm"],
    },
  },
  {
    name: "monday_create_update",
    description: "Post an update (comment) on an existing Monday item.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" }, body: { type: "string" } },
      required: ["itemId", "body"],
    },
  },
  {
    name: "monday_change_status",
    description: "Change a status-type column's value on a Monday item.",
    input_schema: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        itemId: { type: "string" },
        columnId: { type: "string" },
        label: { type: "string" },
      },
      required: ["boardId", "itemId", "columnId", "label"],
    },
  },
  {
    name: "fireflies_search",
    description: "Search recent Fireflies meeting transcripts by keyword.",
    input_schema: {
      type: "object",
      properties: { keyword: { type: "string" }, limit: { type: "number" } },
      required: ["keyword"],
    },
  },
  {
    name: "update_queue_item",
    description: "Patch one item in the shared draft queue (checks/draft-queue.json) — mark done/ignored, edit a note, etc.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
    },
  },
  {
    name: "send_to_monday",
    description:
      "Actually create the drafted item on Monday.com and post its update, using the queue item's stored payload. Only do this when the person clearly asked you to send/fire/create it — never on your own initiative.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

async function runTool(name, input) {
  switch (name) {
    case "monday_lookup": {
      const data = await mondayGraphQL(
        `query($boardId: [ID!]) { boards(ids: $boardId) { items_page(query_params: {}) { items { id name column_values { id text } } } } }`,
        { boardId: [input.boardId] }
      );
      const items = data.boards?.[0]?.items_page?.items || [];
      const term = input.searchTerm.toLowerCase();
      return items
        .filter((it) => it.name.toLowerCase().includes(term) || it.column_values.some((cv) => (cv.text || "").toLowerCase().includes(term)))
        .slice(0, 10);
    }
    case "monday_create_update": {
      const data = await mondayGraphQL(`mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`, {
        itemId: input.itemId,
        body: input.body,
      });
      return data.create_update;
    }
    case "monday_change_status": {
      const data = await mondayGraphQL(
        `mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
           change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
         }`,
        { boardId: input.boardId, itemId: input.itemId, columnId: input.columnId, value: JSON.stringify({ label: input.label }) }
      );
      return data.change_column_value;
    }
    case "fireflies_search": {
      const res = await fetch("https://api.fireflies.ai/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.FIREFLIES_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($keyword: String!, $limit: Int) { search(keyword: $keyword, limit: $limit) { id title date } }`,
          variables: { keyword: input.keyword, limit: input.limit || 5 },
        }),
      });
      const json = await res.json();
      return json.data?.search || { error: json.errors };
    }
    case "update_queue_item": {
      try {
        const written = await updateJSON(QUEUE_PATH, (data) => {
          const idx = data.items.findIndex((it) => it.id === input.id);
          if (idx === -1) throw new ToolAbort(`no item with id ${input.id}`);
          // enforceSentInvariant: a real Monday item existing always wins over
          // whatever status this patch asked for.
          data.items[idx] = enforceSentInvariant({ ...data.items[idx], ...input.patch, updatedAt: new Date().toISOString() });
          data.updatedAt = new Date().toISOString();
          return data;
        }, `chat: update ${input.id}`, { fallback: { updatedAt: null, items: [] } });
        return written.items.find((it) => it.id === input.id);
      } catch (err) {
        return { error: err instanceof ToolAbort ? err.message : String(err) };
      }
    }
    case "send_to_monday":
      return sendQueueItemToMonday(input.id);
    default:
      return { error: `unknown tool ${name}` };
  }
}

exports.handler = async (event) => {
  const pass_ = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
  if (pass_ !== process.env.OPS_PASSCODE) {
    return { statusCode: 401, body: "unauthorized" };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method not allowed" };

  const { messages, topic } = JSON.parse(event.body || "{}");
  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "need messages: []" }) };
  }

  const { data: queue } = await getJSON(QUEUE_PATH, { updatedAt: null, items: [] });

  const system = `You are Ask Flow Ops, a private assistant for Naz and Sohib at Flow Company, answering
under the "${topic || "queue"}" section of the dashboard. You have live tool access to Monday.com,
Fireflies, and the shared draft queue — use it, don't just describe what someone should click.
send_to_monday actually creates a real Monday item — only use it when clearly asked to send/fire/create,
never on your own initiative. When you take an action, say plainly what you did so it's easy to double check.

Today's draft queue (checks/draft-queue.json):
${JSON.stringify(queue, null, 2)}`;

  let convo = [...messages];
  let finalText = "";

  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1024, system, tools: TOOLS, messages: convo }),
    });
    const msg = await res.json();
    if (msg.type === "error") return { statusCode: 500, body: JSON.stringify({ error: msg.error }) };

    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    finalText = text || finalText;
    convo.push({ role: "assistant", content: msg.content });

    if (msg.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const toolResults = [];
    for (const tu of toolUses) {
      let result;
      try {
        result = await runTool(tu.name, tu.input);
      } catch (err) {
        result = { error: String(err) };
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ reply: finalText, messages: convo }) };
};
