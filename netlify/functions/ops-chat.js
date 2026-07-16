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

const STATUS_RESEARCH_RULES = `## Answering "what's the status of X" questions -- the standard procedure, always
This is the fixed procedure for ANY status question, about any client, any
topic -- not a special case, not something to reach for only when a first
attempt seems insufficient. Follow it every time:
1. If you don't already know which client this is about, call
   monday_search_all_boards(searchTerm) FIRST. It normalizes case and
   spacing/punctuation (so "digitalocean", "Digital Ocean", and "digital
   ocean" all match each other) and checks BOTH item names and update text
   across all 3 boards -- a topic can be real and only ever mentioned inside
   an update, never in any item's title. It tells you clientsMatched, the
   distinct clients found. Only ask Naz which client this is about if
   clientsMatched is empty (genuinely found nothing) or has 2+ entries
   (found it under multiple different clients) -- if it resolved to exactly
   one client, proceed with that client, don't ask preemptively just because
   you weren't sure going in.
2. Once you know the client (Naz named it directly, or step 1 resolved to
   exactly one), call monday_client_overview(client). It returns EVERY item
   in that client's relevant board group(s), already fully detailed (each
   item's own updates, each of its subitems, each subitem's own updates) --
   not just the one item whose name happens to match the topic. This is
   mandatory regardless of how confident you are that you already know which
   single item is "the" relevant one -- an item's name matching (or not
   matching) the topic is never a substitute for having the rest of the
   group in front of you.
3. Read through everything before forming an answer. Never state that
   something looks stale, unchanged, or "still at X" unless you've actually
   looked at the updates on every item (and every subitem) in that group --
   recency is verified across the whole group, never assumed from the one
   item you happened to notice.
4. Cross-reference read_draft_queue(client name or topic) for anything
   Fireflies/WhatsApp-sourced on the same subject, and fold it in (cite it,
   e.g. "per the 7/15 Ads sync...").
5. Only then synthesize: what's actually done (who confirmed it, when),
   what's blocked, what's in progress -- citing real names and dates from the
   updates you read. "There's an item for this, status Y" is never a
   complete answer on its own.`;

const RESPONSE_STYLE_RULES = `## Response style -- a quick rundown, not a report
Default to a real, quick, conversational rundown: 2-4 plain sentences, like
you'd say it out loud, not a written report. NO headers, NO bullet lists, NO
markdown report formatting in a normal answer -- save the deep multi-item
research for how you gather the answer (tool calls), not for how you present
it. Only go longer or more structured if Naz explicitly asks for more detail,
or a specific follow-up calls for it.`;

const SYSTEM_RULES = `You are Ask Flow Ops, a general assistant embedded as a floating chat widget
on every page of Naz's Flow Ops dashboard (the Standup page and the Daily Ops
page). Unlike item-chat.js's per-card assistant, you aren't scoped to one
card -- you can answer questions, look things up, and draft brand-new Daily
Ops items from scratch when asked, not just discuss existing ones.

${RESPONSE_STYLE_RULES}

${FRESHNESS_RULES}

Never guess: use your tools or ask a specific follow-up question rather than
answering or drafting on a guess.

${STATUS_RESEARCH_RULES}

${DRAFTING_RULES}

## Your tools
- monday_search_all_boards(searchTerm): use this FIRST whenever the client
  isn't already known. Normalizes case and spacing/punctuation (so
  "digitalocean" / "Digital Ocean" / "digital ocean" all match), and checks
  BOTH item names and update text across all 3 boards -- not just titles.
  Internally it's a cheap name+recency scan across everything first, then a
  full detail pull (updates, subitem updates) only for whatever actually
  matches or was recently touched, so it's not pulling full history for
  every item on every board just to check names. Returns matches plus
  clientsMatched (the distinct clients found) -- 0 or 2+ means ask Naz which
  client; exactly 1 means proceed with that client.
- monday_client_overview(client): the whole picture for a client in one
  call, once you know which client -- every item in that client's relevant
  board group(s) (Ads/Web+SEO/CRM), each one already fully detailed (its own
  updates, its subitems, each subitem's own updates). No keyword filter, so
  nothing gets missed because an item's name doesn't happen to mention the
  topic, and nothing needs a second "is this one relevant" pass -- this is
  the mandatory second step for any "status of X" question, per the
  procedure above.
- monday_lookup(boardId, groupId, searchTerm): a single board/group lookup,
  names/columns only. Mostly useful for the mandatory board audit before
  drafting on a board you already know; for status questions use
  monday_search_all_boards / monday_client_overview instead.
- monday_item_detail(itemId): full detail on one specific item by id (own
  updates, subitems, subitem updates). monday_client_overview already
  includes this for a whole client group -- reach for this tool on its own
  when you have a specific item id from somewhere else (e.g. Naz mentioned
  one directly) and don't need the rest of its group.
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
      "The whole picture for a client in one call: every item in that client's relevant board group(s) across all 3 boards (Ads, Web+SEO, CRM), each one already fully detailed -- its own updates, its subitems, and each subitem's own updates. No keyword filter (nothing gets missed because an item's name doesn't mention the topic) and no separate detail lookup needed (everything is already fully detailed). This is the mandatory first call for any 'status of X' question once you know the client. Returns one entry per board: {board, items} (or {board, items: [], note} if the client has no group there yet).",
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
      "Search across all 3 boards (Ads, Web+SEO, CRM) for when the client isn't known yet. Normalizes case and spacing/punctuation (\"digitalocean\" / \"Digital Ocean\" / \"digital ocean\" all match) and checks both item names AND update text, not just titles -- some things are only ever mentioned inside an update. Returns { matches: [{board, id, name, group, detail}], clientsMatched: [string] }. clientsMatched empty means genuinely nothing found (ask which client); 2+ entries means found under multiple clients (ask which one); exactly 1 means proceed with that client via monday_client_overview.",
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
