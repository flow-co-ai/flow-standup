// POST { id, message, history } -> per-item chatbot for one Draft Queue card.
// Either asks a follow-up question (reply only) or resolves the draft by
// calling the resolve_item tool, which writes a real payload + status: "ready"
// (or status: "ignored") directly onto checks/draft-queue.json on the state
// branch -- no waiting for the next fireflies-monday-watch run.
//
// SYSTEM_RULES below is a condensed copy of the drafting rules from
// /Users/naz/Claude/memory/projects/monday-automation.md (board audit §9/§19,
// single-item bias §16, subitem hierarchy §22b, update format §7, group/role
// IDs §4/§5). That file lives outside this repo and isn't available to a
// deployed function, so keep this in sync by hand if the canonical doc changes.

const { getJSON, putJSON } = require("./lib/github");
const { mondayGraphQL } = require("./lib/monday");

const ANTHROPIC_MODEL = "claude-sonnet-4-5"; // check docs.claude.com/en/docs/about-claude/models if this starts erroring
const QUEUE_PATH = "checks/draft-queue.json";
const EMPTY = { updatedAt: null, items: [] };

const SYSTEM_RULES = `You are Ask Flow Ops, helping Naz resolve one drafted Monday.com task from the
fireflies-monday-watch queue. Gather what you need via conversation and live Monday
lookups, then either resolve the draft (call resolve_item) or ask ONE clear,
specific follow-up question in your reply text. Never resolve on a guess.

## Boards (Team Workspace, id 10979040)
- Ads: 18405754310 -- Meta/Google/LSA/landing pages/graphics/review campaigns. Media buying only.
- Web + SEO (aka "Dev+SEO"): 18099807701 -- website build, automations, GBP, texting policy, reporting. NOT CRM/GHL work.
- CRM: 18418241405 (subitems live on linked board 18418241406) -- all GHL/CRM builds, automations, integrations (Kommo/Como, Clio, HCP, NextGen, Sugar). Owned by Ahmed Memon + Ali Shaheer.
- Video board (18100257069): DO NOT USE for anything. Video work folds into the Ads item it serves.

## Client group IDs (Ads / Web+SEO / CRM)
- Maadi Law: group_mm51vdbk / group_mm51tkzh / group_mm5112vv
- MedStation: group_mm516qss / group_mm51nc9h / group_mm512p9w
- Quality HVAC: group_mm23tg6s / group_mm231wbb / group_mm231wbb (verify CRM id before writing, can differ despite same title)
- Full Smile: group_mkxdznat / group_mkxdmhbz / group_mkxdmhbz (verify CRM id before writing)
- Justice Consumer Law: group_mkqxyga2 / group_mkqxyga2 / no CRM group yet
- Liferun: group_mkwj8zze / group_mkwj9a1c / group_mkwj9a1c (verify CRM id before writing)
- BillyDoe Meats: group_mm2dt8f / group_mm2dqm7n / no CRM group yet
- Vous Physique: group_mm22cd1z / group_mm231372 / no CRM group yet (confirm before writing)
- Steel Round Bars: group_mkqxskcn / group_mkqxskcn / group_mkqxskcn (verify CRM id before writing)
- Flow Company (internal): group_mkwjedjg / group_mkwjem1v / no CRM group yet
If the client or its group id isn't listed here or you're unsure it's current, use monday_lookup to confirm rather than guessing -- group IDs can change.

## MANDATORY board audit before drafting
Before calling resolve_item with mode create_item, create_subitem, or update_only,
you MUST use monday_lookup on the relevant board to check whether a parent item,
existing subitem, or duplicate already exists for this client's workstream. Never
guess an existingItemId or parentItemId -- look it up. One good lookup is usually
enough; don't loop forever, but don't skip it either.

## Single-item bias (fewer items, not more)
Prefer folding new information into an EXISTING item over creating a new one:
1. If a parent item already exists for this workstream, use create_subitem
   against it rather than a new top-level create_item.
2. If this is just new information/confirmation about work already tracked,
   use update_only (post an update, create nothing).
3. Only use create_item when this is a genuinely new workstream with no
   existing parent on the board.
Less is more -- one sequenced workflow is one item with steps in the update,
not several items.

## Update format (§7) -- updateBody MUST follow this exactly
1. Open with "<p>Salam,</p>" -- nothing else, no @-tag at the start.
2. Body as "<ul><li>...</li></ul>" bullets. Knowledgeable (don't dumb it down),
   organized, one clear thought per bullet, more than enough detail -- assume
   the reader has NOT seen the source meeting.
3. Tag people at the very bottom only, one line, exact HTML:
   <p><a class="mention" data-mention-id="USERID" data-mention-type="User">@Full Display Name</a> ...</p>
4. NEVER use em dashes (—) or en dashes (–). Avoid hyphens outside canonical terms.
5. itemName: 2-3 words max, lead with the noun or action verb. No articles.
6. Bold (<strong>) action verbs, deadlines, and constraints.
7. HTML only, no markdown.

## Assignment is automatic -- you do not set columnValues yourself
Every create_item/create_subitem you resolve gets its status and people
columns set automatically based on the board, using fixed default assignees:
- Ads board: Khurram Jamil + Ads Team
- Web+SEO board: Muhammad Hashir Faiz + Zayan Faiz
- CRM board: Ahmed Memon + Ali Shaheer
Do NOT tag Naz or Sohib by default on ANY board. Only pass needsNaz: true to
resolve_item as a deliberate judgment call when the task is genuinely complex
or high-stakes enough to need Naz directly involved -- never as a default.
Status defaults to Start. Only pass blocked: true if this is genuinely
blocked on a client or 3rd party (sets status to Stuck instead).
create_subitem now also requires boardId (not used in the mutation itself,
but required so the right default assignees can be applied).

Mirror the SAME people in your updateBody's closing mention-chip line (§7),
using their real Monday user IDs:
- Ads Team: 102221061 (tag as "@Ads Team"), Khurram Jamil: 102221064
- Muhammad Hashir Faiz: 69741994, Zayan Faiz: 101662542
- Ahmed Memon: 108080159, Ali Shaheer: 108080161
- Sohib Boundaoui: 69662034, Nacer Amrouch (Naz): 70062990 (only if needsNaz)
Clients are NEVER Monday users and never get @-tagged -- mention them by plain
text name in the body. If a client needs to be chased, assign/tag Naz instead
(and set needsNaz: true).

## Defaults when unstated
Leave timeline blank unless a real deadline is named.

## Your tools
- monday_lookup(boardId, groupId, searchTerm): list or search items on a board.
  ALWAYS pass groupId when you know it (from the Client group IDs table) --
  it scopes the query to just that client's items. An unscoped board-wide
  query is unreliable and can miss items on boards with many clients. Omit
  searchTerm to list everything in scope (the mandatory audit), or pass it to
  filter by keyword. If this errors (bad board/group id), it tells you so --
  don't treat an error as "the board is empty," fix the id or ask Naz.
- resolve_item(...): call this ONCE, when you have enough to finalize. Two shapes:
  - action: "ignore" -- no Monday action needed (duplicate, informational only,
    already handled elsewhere). No other fields required.
  - action: "draft" -- provide mode (create_item | create_subitem | update_only),
    the fields that mode needs, updateBody in the §7 format above (almost
    always include one), and blocked/needsNaz if either genuinely applies.

If you don't have enough yet (ambiguous target, missing confirmation, unclear
scope), do NOT call resolve_item. Just ask one specific question in your reply.`;

const TOOLS = [
  {
    name: "monday_lookup",
    description:
      "List or search items on a Monday board. ALWAYS pass groupId when you know it (from the Client group IDs table) -- this scopes the query to just that client's items instead of an unscoped board-wide query, which is unreliable on boards with many items. Omit searchTerm to list everything in scope (useful for the mandatory board audit); pass it to filter by keyword. Returns id, name, and column values -- never guess an id, look it up here.",
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
    name: "resolve_item",
    description:
      "Finalize this draft. Call this only once, when you have enough to either draft the real Monday payload or determine no action is needed. Status and people columns are set automatically from boardId -- you don't provide columnValues yourself, just blocked/needsNaz if either genuinely applies.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["draft", "ignore"] },
        mode: { type: "string", enum: ["create_item", "create_subitem", "update_only"] },
        boardId: { type: "string", description: "Required for create_item and create_subitem -- determines the default status/assignee columns." },
        groupId: { type: "string" },
        itemName: { type: "string" },
        parentItemId: { type: "string" },
        existingItemId: { type: "string" },
        updateBody: { type: "string" },
        blocked: { type: "boolean", description: "True only if genuinely blocked on a client/3rd party -- sets status Stuck instead of the Start default." },
        needsNaz: { type: "boolean", description: "True only if this is complex/high-stakes enough that Naz should be tagged directly -- a deliberate judgment call, never a default." },
      },
      required: ["action"],
    },
  },
];

async function mondayLookup(input) {
  const { boardId, groupId, searchTerm } = input;
  if (!boardId) throw new Error("monday_lookup needs boardId");

  let items;
  if (groupId) {
    // Verified working pattern: board + group scoped together, explicit limit.
    // An unscoped board-wide query silently misses items past the default page
    // size on boards with many clients -- that's what was reading as "empty."
    const data = await mondayGraphQL(
      `query($boardId: [ID!], $groupId: [String]) {
         boards(ids: $boardId) {
           groups(ids: $groupId) {
             id
             title
             items_page(limit: 100) { items { id name column_values { id text } } }
           }
         }
       }`,
      { boardId: [boardId], groupId: [groupId] }
    );
    const board = data?.boards?.[0];
    if (!board) throw new Error(`monday_lookup: no board found for boardId ${boardId} -- double check the id`);
    const group = board.groups?.[0];
    if (!group) throw new Error(`monday_lookup: no group found for groupId ${groupId} on board ${boardId} -- the id may be wrong or have changed`);
    items = group.items_page?.items || [];
  } else {
    const data = await mondayGraphQL(
      `query($boardId: [ID!]) { boards(ids: $boardId) { items_page(limit: 100) { items { id name column_values { id text } } } } }`,
      { boardId: [boardId] }
    );
    const board = data?.boards?.[0];
    if (!board) throw new Error(`monday_lookup: no board found for boardId ${boardId} -- double check the id`);
    items = board.items_page?.items || [];
  }

  const term = (searchTerm || "").toLowerCase();
  return term
    ? items.filter((it) => it.name.toLowerCase().includes(term) || (it.column_values || []).some((cv) => (cv.text || "").toLowerCase().includes(term)))
    : items;
}

function validatePayload(mode, input) {
  if (mode === "create_item") {
    if (!input.boardId || !input.groupId || !input.itemName) return "create_item needs boardId, groupId, and itemName";
  } else if (mode === "create_subitem") {
    if (!input.boardId || !input.parentItemId || !input.itemName) return "create_subitem needs boardId (for default status/assignees), parentItemId, and itemName";
  } else if (mode === "update_only") {
    if (!input.existingItemId) return "update_only needs existingItemId";
  } else {
    return `unknown mode: ${mode}`;
  }
  return null;
}

const STATUS_COLUMN = "color_mkwb1trm";
const PEOPLE_COLUMN = "multiple_person_mkwb5f2e";
const NAZ_USER_ID = 70062990;

// Board-scoped default assignees (Naz, 2026-07-15): never tag Naz/Sohib by
// default on any board -- only added via the model's needsNaz flag, a
// deliberate judgment call, not a default. Enforced here in code rather than
// just requested in the system prompt, so it can't be silently skipped.
const BOARD_ASSIGNEES = {
  "18405754310": [ // Ads: Khurram Jamil + Ads Team
    { id: 102221064, kind: "person" },
    { id: 102221061, kind: "person" },
  ],
  "18099807701": [ // Web + SEO: Muhammad Hashir Faiz + Zayan Faiz
    { id: 69741994, kind: "person" },
    { id: 101662542, kind: "person" },
  ],
  "18418241405": [ // CRM: Ahmed Memon + Ali Shaheer
    { id: 108080159, kind: "person" },
    { id: 108080161, kind: "person" },
  ],
};

const USER_NAMES = {
  102221064: "Khurram Jamil",
  102221061: "Ads Team",
  69741994: "Muhammad Hashir Faiz",
  101662542: "Zayan Faiz",
  108080159: "Ahmed Memon",
  108080161: "Ali Shaheer",
  69662034: "Sohib Boundaoui",
  70062990: "Nacer Amrouch",
};

function buildColumnValues(boardId, blocked, needsNaz) {
  const assignees = BOARD_ASSIGNEES[boardId];
  if (!assignees) throw new Error(`no default assignees configured for board ${boardId}`);
  const personsAndTeams = needsNaz ? [...assignees, { id: NAZ_USER_ID, kind: "person" }] : assignees;
  return {
    [STATUS_COLUMN]: { label: blocked ? "Stuck" : "Start" },
    [PEOPLE_COLUMN]: { personsAndTeams },
  };
}

function assignedToLine(personsAndTeams) {
  return `Assigned to: ${personsAndTeams.map((p) => USER_NAMES[p.id] || `user ${p.id}`).join(", ")}`;
}

// Turns a §7-format HTML update body into a flat plain-text preview for the
// card's note field: block boundaries (</li>, <br>, </p>) become " / ",
// everything else is stripped tags + decoded entities.
function htmlToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<li[^>]*>/gi, "")
    .replace(/<\/li>/gi, " / ")
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/<\/p>/gi, " / ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .replace(/^\s*\/\s*/, "")
    .replace(/\s*\/\s*$/, "")
    .trim();
}

// Builds the resolved payload + the item.title/item.note rewrite for a
// "draft" resolution. Returns { error } on validation/lookup failure, or
// { payload, titleUpdate } on success -- status/people are always computed
// here, never trusted from the model's tool call.
function buildResolvedFields(input) {
  const validationError = validatePayload(input.mode, input);
  if (validationError) return { error: validationError };

  if (input.mode === "update_only") {
    return {
      payload: { mode: "update_only", existingItemId: input.existingItemId, updateBody: input.updateBody },
      titleUpdate: { note: htmlToPlainText(input.updateBody) },
    };
  }

  let columnValues;
  try {
    columnValues = buildColumnValues(input.boardId, !!input.blocked, !!input.needsNaz);
  } catch (err) {
    return { error: String(err) };
  }

  const payload = { mode: input.mode, itemName: input.itemName, columnValues, updateBody: input.updateBody };
  if (input.mode === "create_item") {
    payload.boardId = input.boardId;
    payload.groupId = input.groupId;
  } else {
    payload.parentItemId = input.parentItemId;
  }

  const plain = htmlToPlainText(input.updateBody);
  const assigned = assignedToLine(columnValues[PEOPLE_COLUMN].personsAndTeams);
  return {
    payload,
    titleUpdate: { title: input.itemName, note: [plain, assigned].filter(Boolean).join(" / ") },
  };
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"] || JSON.parse(event.body || "{}").passcode;
    if (passcode !== process.env.OPS_PASSCODE) return json(401, { error: "unauthorized" });
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    const { id, message, history } = JSON.parse(event.body || "{}");
    if (!id || !message) return json(400, { error: "need id and message" });

    const { data } = await getJSON(QUEUE_PATH, EMPTY);
    const item = data.items.find((it) => it.id === id);
    if (!item) return json(404, { error: `no item with id ${id}` });

    const itemContext = `
## The draft you're resolving right now
id: ${item.id}
title: ${item.title}
note: ${item.note || ""}
board (as drafted, verify before trusting): ${item.board || "n/a"}
client group: ${item.group || "n/a"}
source: ${item.sourceLabel || item.source || "n/a"}
${item.clarification ? `Naz previously told you: "${item.clarification}"` : ""}`;

    const system = SYSTEM_RULES + "\n" + itemContext;

    let convo = [...(history || []), { role: "user", content: message }];
    let finalText = "";
    let resolved = false;
    let resolvedItem = null;

    for (let turn = 0; turn < 6; turn++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2048, system, tools: TOOLS, messages: convo }),
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
          if (tu.name === "monday_lookup") {
            result = await mondayLookup(tu.input);
          } else if (tu.name === "resolve_item") {
            // Re-fetch fresh right before writing so a concurrent write elsewhere
            // (another card, the automation) doesn't collide on a stale sha.
            const fresh = await getJSON(QUEUE_PATH, EMPTY);
            const freshIdx = fresh.data.items.findIndex((it) => it.id === id);
            if (freshIdx === -1) {
              result = { error: `item ${id} no longer exists` };
            } else if (tu.input.action === "ignore") {
              fresh.data.items[freshIdx] = { ...fresh.data.items[freshIdx], status: "ignored", updatedAt: new Date().toISOString() };
              fresh.data.updatedAt = new Date().toISOString();
              await putJSON(QUEUE_PATH, fresh.data, `item-chat: ${id} resolved (ignore)`, fresh.sha);
              resolved = true;
              resolvedItem = fresh.data.items[freshIdx];
              result = { ok: true };
            } else {
              const built = buildResolvedFields(tu.input);
              if (built.error) {
                result = { error: built.error };
              } else {
                fresh.data.items[freshIdx] = {
                  ...fresh.data.items[freshIdx],
                  ...built.titleUpdate,
                  status: "ready",
                  payload: built.payload,
                  updatedAt: new Date().toISOString(),
                };
                fresh.data.updatedAt = new Date().toISOString();
                await putJSON(QUEUE_PATH, fresh.data, `item-chat: ${id} resolved (${tu.input.mode})`, fresh.sha);
                resolved = true;
                resolvedItem = fresh.data.items[freshIdx];
                result = { ok: true };
              }
            }
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

    return json(200, { reply: finalText, resolved, item: resolvedItem });
  } catch (err) {
    console.error("item-chat function error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};
