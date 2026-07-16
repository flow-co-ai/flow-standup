// POST { message, history } -> the global "Ask Flow Ops" widget, embedded on
// every page (Standup + Daily Ops), not scoped to one card. It can answer
// questions against live Monday + the live draft queue, and draft brand-new
// Daily Ops items from scratch (written straight into checks/draft-queue.json,
// same schema as every other card, so it shows up in the queue immediately).
//
// Nothing here is cached across calls or across turns -- every tool below
// hits GitHub/Monday fresh, every single time. Drafting reuses item-chat.js's
// exact rules/logic (DRAFTING_RULES, buildResolvedFields) and lib/monday.js's
// exact enforcement (buildColumnValues, checkUpdateBodySubstance) rather than
// a third copy of either.

const { getJSON, putJSON } = require("./lib/github");
const {
  mondayLookup,
  mondayItemDetail,
  mondayClientOverview,
  mondaySearchAllBoards,
  boardLabelForId,
} = require("./lib/monday");
const { DRAFTING_RULES, buildResolvedFields } = require("./item-chat");

const ANTHROPIC_MODEL = "claude-sonnet-4-5"; // check docs.claude.com/en/docs/about-claude/models if this starts erroring
const QUEUE_PATH = "checks/draft-queue.json";
const EMPTY = { updatedAt: null, items: [] };
const RUNDOWN_PATH = "site/latest.json"; // only ever pushed to main by the Weekly Standup workflow

const FRESHNESS_RULES = `## What's live vs. what's periodic -- be explicit about this, always
- Monday.com (monday_lookup, monday_item_detail) and the Daily Ops draft queue
  (read_draft_queue) are queried FRESH, live, right now, on every single call --
  never a cached copy from earlier in this conversation. Treat what they
  return as accurate as of this exact moment.
- The standup rundown (read_latest_rundown) is also fetched fresh, but the
  CONTENT it holds is only as current as its own week_of/generated date --
  it's a periodic synthesis, not a live view.
- Fireflies meeting transcripts and WhatsApp messages are NOT something you
  can search live. They only enter this system through the scheduled
  fireflies-monday-watch automation's periodic runs, which read them,
  synthesize/summarize, and write the results into the draft queue (as each
  item's sourceLabel + note) and into the standup rundown. If a question
  depends on something that automation might not have processed yet, say so
  explicitly -- e.g. "as of the last automation run (see the item's
  sourceLabel / the rundown's week_of), I see X -- I have no live access to
  raw transcripts or WhatsApp, so anything since then wouldn't be reflected
  yet." Never imply you searched a transcript or a WhatsApp thread directly --
  you didn't, and can't.`;

const STATUS_RESEARCH_RULES = `## Answering "what's the status of X" questions -- go deep, every time
A confirmed real bug: asked about Full Smile's DigitalOcean work, this
assistant once checked one board, found nothing obviously named "DigitalOcean",
and answered as if that settled it -- missing the CRM board entirely, and
missing the item that actually had the real recent status on it (an item
called "Duplicate Contacts" with no mention of "DigitalOcean" in its name at
all, even though its update history was exactly the answer). Two lessons,
both mandatory from now on:

1. **Search by CLIENT across all 3 boards, not by topic keyword on one
   board.** Use monday_client_overview(client) FIRST -- it pulls every item
   in that client's group on Ads, Web+SEO, AND CRM in one call, so no board
   ever gets silently skipped. Only fall back to monday_search_all_boards
   (keyword, all 3 boards) if you don't know which client this is yet, or as
   a supplementary check -- never as your only search, since a keyword
   search over item NAMES misses items whose real content is only in the
   update text, not the title (exactly what happened with "Duplicate
   Contacts").
2. **Never stop at "yes, there's an item for this."** For every item that
   looks relevant (parent or subitem), call monday_item_detail(itemId) and
   actually read its updates AND its subitems' updates. A parent item's own
   status column can look untouched (e.g. still "Start") while the real
   answer -- a fix already live, a specific bug already closed, exactly who
   did it and when -- is sitting in a subitem's update history, or on a
   sibling item you'd have missed without step 1. Then also call
   read_draft_queue(client's name or the topic) to check for a related
   Fireflies/WhatsApp-sourced note on the same topic, and fold that in too
   (cite it, e.g. "per the 7/15 Ads sync..."). Only after all of that,
   synthesize a real answer: what's actually done (who confirmed it, when),
   what's still blocked or unstarted, what's in progress -- citing names and
   dates from the real updates. "There's an item called X, status Y" is not
   an acceptable final answer to a status question by itself.`;

const SYSTEM_RULES = `You are Ask Flow Ops, a general assistant embedded as a floating chat widget
on every page of Naz's Flow Ops dashboard (the Standup page and the Daily Ops
page). Unlike item-chat.js's per-card assistant, you aren't scoped to one
card -- you can answer questions, look things up, and draft brand-new Daily
Ops items from scratch when asked, not just discuss existing ones.

${FRESHNESS_RULES}

Never guess: use your tools or ask a specific follow-up question rather than
answering or drafting on a guess.

${STATUS_RESEARCH_RULES}

${DRAFTING_RULES}

## Your tools
- monday_client_overview(client): every item a client has across all 3
  boards (Ads/Web+SEO/CRM), group-scoped -- no keyword filter, so nothing
  gets missed by naming. This is your FIRST move for any "status of X"
  question once you know the client. See the client list below.
- monday_search_all_boards(searchTerm): keyword search across all 3 boards
  at once. Use when the client isn't known yet, or as a supplementary check
  -- not as your only search (see the rules above on why item names can
  miss the real content).
- monday_lookup(boardId, groupId, searchTerm): a single board/group lookup.
  Mostly useful for the mandatory board audit before drafting something on a
  specific board you already know; for "status of X" research prefer
  monday_client_overview.
- monday_item_detail(itemId): full detail on ONE item -- its column values,
  its own updates, its subitems, AND each subitem's own updates. Call this on
  every item that looks relevant before answering a status question -- see
  the rules above.
- read_draft_queue(searchTerm?): fresh GET of the live Daily Ops queue
  (checks/draft-queue.json). Each item carries id, title, note, status,
  board, group, source, sourceLabel (which meeting/WhatsApp/automation run it
  came from -- your only window into that periodic content), payload,
  priority, mondayItemId. Pass searchTerm to filter by keyword across
  title/note/sourceLabel/group (case-insensitive substring); omit it to get
  everything. Call again whenever you need current state -- never assume an
  earlier call in this conversation is still accurate.
- read_latest_rundown(): fresh read of the latest weekly standup rundown
  (executive summary + per-department summaries). Periodic, not live -- check
  week_of to tell Naz how current it actually is.
- draft_new_item(...): draft a brand-new Daily Ops item from scratch and
  write it straight into the live draft queue, so it shows up in the Daily
  Ops dashboard immediately -- exactly as if the fireflies-monday-watch
  automation had drafted it. Complete the mandatory board audit above
  (monday_client_overview / monday_item_detail) BEFORE calling this, to avoid
  drafting a duplicate of something that already exists. Provide:
  - client: the client's display name, e.g. "Maadi Law" -- used for the
    dashboard's client grouping and the card title's "[Client]" prefix.
  - mode, and whichever of boardId/groupId/parentItemId/existingItemId that
    mode needs (same rules as above).
  - itemName (2-3 words, §7 format) and updateBody (§7 format -- this is the
    field the content-depth gate checks; a thin one-liner gets rejected with
    an error, not silently sent).
  - priority (rubric above), blocked/needsNaz if either genuinely applies.
  - sourceLabel: a short human-readable provenance note for the card, e.g.
    "Ops chat: Naz request, 7/16" -- shown on the card like any other item's
    source.
  If you don't have enough yet (ambiguous client/board, missing confirmation,
  unclear scope), do NOT call draft_new_item. Just ask one specific question.`;

const TOOLS = [
  {
    name: "monday_client_overview",
    description:
      "Every item a client has across all 3 boards (Ads, Web+SEO, CRM), group-scoped -- no keyword filter, so nothing gets missed because an item's name doesn't happen to mention the topic. This is the FIRST tool to call for any 'status of X' question once you know the client. Returns one entry per board: {board, items} (or {board, items: [], note} if the client has no group there yet).",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client display name exactly as it appears in the Client group IDs table, e.g. \"Full Smile\", \"Maadi Law\"." },
      },
      required: ["client"],
    },
  },
  {
    name: "monday_search_all_boards",
    description:
      "Keyword search across all 3 boards at once (Ads, Web+SEO, CRM). Use when the client isn't known yet, or as a supplementary check -- prefer monday_client_overview once you know the client, since this can still miss items whose name/columns don't mention the search term. Returns one entry per board: {board, items}.",
    input_schema: {
      type: "object",
      properties: {
        searchTerm: { type: "string" },
      },
      required: ["searchTerm"],
    },
  },
  {
    name: "monday_lookup",
    description:
      "List or search items on ONE specific Monday board. ALWAYS pass groupId when you know it (from the Client group IDs table) -- this scopes the query to just that client's items instead of an unscoped board-wide query, which is unreliable on boards with many items. Mostly useful for the mandatory board audit before drafting on a board you already know; for 'status of X' research prefer monday_client_overview, which covers all 3 boards at once. Returns id, name, and column values -- never guess an id, look it up here. Always a fresh, live call.",
    input_schema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "18405754310 (Ads), 18099807701 (Web+SEO), 18418241405 (CRM)" },
        groupId: { type: "string", description: "Client's group id on this board, from the Client group IDs table. Strongly recommended." },
        searchTerm: { type: "string", description: "Optional keyword filter. Omit to list all items in the given board/group." },
      },
      required: ["boardId"],
    },
  },
  {
    name: "monday_item_detail",
    description:
      "Full detail on one Monday item: its column values, its own posted updates, its subitems, AND each subitem's own posted updates. Call this on every item that looks relevant to a status question before answering -- a parent's status column can look untouched while the real answer is in a subitem's update history. Always a fresh, live call.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
    },
  },
  {
    name: "read_draft_queue",
    description:
      "Fresh GET of the live Daily Ops draft queue (checks/draft-queue.json) -- never a cached copy from earlier in this conversation. Each item carries id, title, note, status, board, group, source, sourceLabel, payload, priority, mondayItemId. Pass searchTerm to filter by keyword across title/note/sourceLabel/group; omit it to get everything. Call again whenever time may have passed since your last call.",
    input_schema: {
      type: "object",
      properties: {
        searchTerm: { type: "string", description: "Optional keyword filter, case-insensitive substring match across title/note/sourceLabel/group. Omit to get every item." },
      },
    },
  },
  {
    name: "read_latest_rundown",
    description:
      "Fresh read of the latest weekly standup rundown -- executive_summary plus departments_overview. Periodic (regenerated by a scheduled GitHub Action), not live -- use week_of to gauge how current it is.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "draft_new_item",
    description:
      "Draft a brand-new Daily Ops item from scratch and write it into the live draft queue so it shows up in the dashboard immediately. Uses the same board-scoped status/assignee enforcement and updateBody content-depth gate as every other drafting path -- a too-thin updateBody is rejected with an error, not silently sent. Complete the mandatory board audit (monday_lookup / monday_item_detail) first.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client display name, e.g. \"Maadi Law\" -- drives the dashboard's client grouping and the card title's [Client] prefix." },
        mode: { type: "string", enum: ["create_item", "create_subitem", "update_only"] },
        boardId: { type: "string", description: "Required for create_item and create_subitem -- determines the default status/assignee columns." },
        groupId: { type: "string", description: "Required for create_item -- the client's group id on that board." },
        parentItemId: { type: "string", description: "Required for create_subitem." },
        existingItemId: { type: "string", description: "Required for update_only." },
        itemName: { type: "string", description: "2-3 words max, per the §7 format rules." },
        updateBody: { type: "string", description: "§7 format. Must pass the content-depth gate (real context + goal/done line), not a single generic sentence." },
        priority: { type: "integer", minimum: 1, maximum: 5, description: "1 (blocker/long lead time) to 5 (FYI only) -- see the priority rubric. Defaults to 3 if omitted." },
        blocked: { type: "boolean", description: "True only if genuinely blocked on a client/3rd party -- sets status Stuck instead of the Start default." },
        needsNaz: { type: "boolean", description: "True only if this is complex/high-stakes enough that Naz should be tagged directly -- a deliberate judgment call, never a default." },
        sourceLabel: { type: "string", description: "Short human-readable provenance for this card, e.g. \"Ops chat: Naz request, 7/16\". Defaults to a generic ops-chat label with today's date if omitted." },
      },
      required: ["client", "mode", "itemName", "updateBody"],
    },
  },
];

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Short "M/D" date, matching the style already used in existing sourceLabels
// (e.g. "Fireflies: Maadi Law backfill sweep, 7/10").
function shortDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function uniqueId(client, itemName, existingItems) {
  const base = slugify(`${client}-${itemName}`) || "ops-chat-item";
  const existingIds = new Set(existingItems.map((it) => it.id));
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Cross-referencing step 3 of the status-research workflow: find anything in
// the Fireflies/WhatsApp-sourced draft queue mentioning the same topic. Case-
// insensitive substring match across the fields that actually carry that
// periodic content (title/note/sourceLabel), plus group for a client-name
// filter.
function filterQueueItems(items, searchTerm) {
  if (!searchTerm) return items;
  const term = searchTerm.toLowerCase();
  return items.filter((it) =>
    [it.title, it.note, it.sourceLabel, it.group].some((f) => (f || "").toLowerCase().includes(term))
  );
}

// Reuses item-chat.js's exact buildResolvedFields -- it only reads
// item.priority as a fallback, so calling it with {} (no pre-existing item)
// works unmodified for drafting a brand-new card. Writes straight into
// checks/draft-queue.json in the exact same schema every other card uses.
async function draftNewItem(input) {
  const built = buildResolvedFields({}, input);
  if (built.error) return { error: built.error };

  const fresh = await getJSON(QUEUE_PATH, EMPTY);
  const id = uniqueId(input.client, input.itemName, fresh.data.items);
  const boardLabel = input.boardId ? boardLabelForId(input.boardId) || "n/a" : "n/a";

  const newItem = {
    id,
    title: built.titleUpdate.title || `[${input.client}] ${input.itemName}`,
    note: built.titleUpdate.note,
    status: "ready",
    board: boardLabel,
    group: input.client,
    source: "ops-chat",
    sourceLabel: input.sourceLabel || `Ops chat: Naz request, ${shortDate(new Date())}`,
    payload: built.payload,
    priority: built.titleUpdate.priority,
    updatedAt: new Date().toISOString(),
  };

  fresh.data.items.push(newItem);
  fresh.data.updatedAt = new Date().toISOString();
  await putJSON(QUEUE_PATH, fresh.data, `ops-chat: drafted new item ${id}`, fresh.sha);
  return { ok: true, item: newItem };
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"] || JSON.parse(event.body || "{}").passcode;
    if (passcode !== process.env.OPS_PASSCODE) return json(401, { error: "unauthorized" });
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    const { message, history } = JSON.parse(event.body || "{}");
    if (!message) return json(400, { error: "need message" });

    let convo = [...(history || []), { role: "user", content: message }];
    let finalText = "";

    for (let turn = 0; turn < 10; turn++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2048, system: SYSTEM_RULES, tools: TOOLS, messages: convo }),
      });
      const msg = await res.json();
      if (msg.type === "error") return json(500, { error: msg.error });

      const toolUses = msg.content.filter((b) => b.type === "tool_use");
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      finalText = text || finalText;
      convo.push({ role: "assistant", content: msg.content });

      if (msg.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const toolResults = [];
      for (const tu of toolUses) {
        let result;
        try {
          if (tu.name === "monday_client_overview") {
            result = await mondayClientOverview(tu.input.client);
          } else if (tu.name === "monday_search_all_boards") {
            result = await mondaySearchAllBoards(tu.input.searchTerm);
          } else if (tu.name === "monday_lookup") {
            result = await mondayLookup(tu.input);
          } else if (tu.name === "monday_item_detail") {
            result = await mondayItemDetail(tu.input.itemId);
          } else if (tu.name === "read_draft_queue") {
            const { data } = await getJSON(QUEUE_PATH, EMPTY);
            result = filterQueueItems(data.items || [], tu.input.searchTerm);
          } else if (tu.name === "read_latest_rundown") {
            const { data } = await getJSON(RUNDOWN_PATH, null, "main");
            result = data || { error: "no rundown found yet" };
          } else if (tu.name === "draft_new_item") {
            result = await draftNewItem(tu.input);
          } else {
            result = { error: `unknown tool ${tu.name}` };
          }
        } catch (err) {
          result = { error: String(err) };
        }
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      convo.push({ role: "user", content: toolResults });
    }

    return json(200, { reply: finalText });
  } catch (err) {
    console.error("ops-chat function error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};
