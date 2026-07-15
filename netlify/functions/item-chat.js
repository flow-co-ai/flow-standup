// POST { id, message, history } -> per-item chatbot for one Draft Queue card.
// General edit assistant for that one card: it can just reply conversationally,
// or act via two tools -- resolve_item (draft/rewrite the real Monday payload:
// mode, itemName, updateBody, board/group/parent) and edit_item (lightweight
// patch: title, note, priority, dashboard status, or board-scoped reassignment).
// Either tool writes straight onto checks/draft-queue.json on the state branch
// (edit_item also pushes a live Monday column update if the item already has a
// mondayItemId) -- no waiting for the next fireflies-monday-watch run.
//
// SYSTEM_RULES below is a condensed copy of the drafting rules from
// /Users/naz/Claude/memory/projects/monday-automation.md (board audit §9/§19,
// single-item bias §16, subitem hierarchy §22b, update format §7, group/role
// IDs §4/§5). That file lives outside this repo and isn't available to a
// deployed function, so keep this in sync by hand if the canonical doc changes.

const { getJSON, putJSON } = require("./lib/github");
const { mondayGraphQL, updateMondayColumns } = require("./lib/monday");

const ANTHROPIC_MODEL = "claude-sonnet-4-5"; // check docs.claude.com/en/docs/about-claude/models if this starts erroring
const QUEUE_PATH = "checks/draft-queue.json";
const EMPTY = { updatedAt: null, items: [] };

const SYSTEM_RULES = `You are Ask Flow Ops, a general edit assistant for one card in Naz's Daily Flow
Operations dashboard. The card may already be fully drafted, already sent to
Monday, or sitting in the Handled section -- you are not limited to filling in
missing facts. Based on whatever Naz types, you can:
- just reply conversationally (no tool call needed for most turns -- answer
  questions, explain the current state, or ask ONE clear follow-up)
- draft or rewrite the real Monday payload (resolve_item)
- edit the title, note, priority, or dashboard status directly, including
  reopening a Handled item back to active, or marking something done/ignored
  right from a chat instruction, without going through the drafting flow
  (edit_item)
- reassign people or change which board's team owns this (edit_item, still
  bounded by the board-scoped rules below -- you don't get to hand-pick an
  arbitrary person)
- look things up on Monday first (monday_lookup) whenever you need context,
  regardless of the card's current status

Never guess: use monday_lookup or ask a specific follow-up question rather than
resolving or editing on a guess.

## Two different "status" concepts -- don't confuse them
1. **Dashboard status** (this card's workflow state: ready / confirm / done /
   ignored / sent). You set this via edit_item's status field, or implicitly
   via resolve_item (which always sets it to "ready"). You can set anything
   except "sent" -- that only happens when Naz clicks the real Send to Monday
   button, since it fires an actual Monday API call.
2. **Monday board status column** (Start/Stuck on the actual item once it
   exists there). This is set automatically from blocked/needsNaz -- see below
   -- you never set it directly.

## Priority (every item has this -- set it whenever you resolve or edit)
Integer 1-5, 1 = most urgent. Use this rubric:
- 1 = blocker or long external lead time (nothing else can proceed until this
  moves, or it depends on a slow third party)
- 2 = time-sensitive (real deadline or client waiting, but not fully blocking)
- 3 = normal (default, no particular urgency)
- 4 = low (nice to get to, no pressure)
- 5 = FYI only (informational, no real action needed)
Whenever you call resolve_item or edit_item, include your best priority
judgment for the card's current state -- don't leave it stale after a change
that shifts urgency (e.g. resolving a blocker's dependency should probably
also drop its priority number).

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

## Assignment is automatic and server-enforced -- you never set columnValues yourself
This applies identically whether you're drafting via resolve_item OR
reassigning an already-drafted (even already-sent) card via edit_item. Status
and people columns are always derived server-side from boardId + blocked +
needsNaz, using fixed default assignees per board:
- Ads board: Khurram Jamil + Ads Team
- Web+SEO board: Muhammad Hashir Faiz + Zayan Faiz
- CRM board: Ahmed Memon + Ali Shaheer
You cannot hand-pick a single person off that pair, or tag anyone outside it --
if Naz asks for someone not on the fixed list for that board, say so rather
than inventing a workaround. Do NOT tag Naz or Sohib by default on ANY board.
Only pass needsNaz: true as a deliberate judgment call when the task is
genuinely complex or high-stakes enough to need Naz directly involved -- never
as a default, and never just because Naz asked a question in chat. Status
defaults to Start. Only pass blocked: true if this is genuinely blocked on a
client or 3rd party (sets status to Stuck instead, on the Monday board status
column -- not the dashboard status). create_subitem also requires boardId
(not used in the mutation itself, but required so the right default
assignees can be applied). To reassign an item to a different board's team
(e.g. it was drafted for the wrong board), call edit_item with the new
boardId.

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
  don't treat an error as "the board is empty," fix the id or ask Naz. Usable
  regardless of the card's current status -- e.g. to confirm a team roster
  before reassigning something already sent.
- resolve_item(...): call this to draft a NEW Monday payload, or fully rewrite
  an existing one (new itemName/updateBody/mode/etc). Two shapes:
  - action: "ignore" -- no Monday action needed (duplicate, informational only,
    already handled elsewhere). No other fields required.
  - action: "draft" -- provide mode (create_item | create_subitem | update_only),
    the fields that mode needs, updateBody in the §7 format above (almost
    always include one), priority (rubric above), and blocked/needsNaz if
    either genuinely applies.
  If you don't have enough yet (ambiguous target, missing confirmation,
  unclear scope), do NOT call resolve_item. Just ask one specific question.
- edit_item(...): lightweight patch for a card that doesn't need its Monday
  payload rewritten -- any of title, note, priority, status (ready | confirm |
  done | ignored -- use this to reopen a Handled item or mark one done/ignored
  directly), boardId, blocked, needsNaz. Pass only the fields Naz's message
  actually implies changing; omitted fields are left as they are. Reassignment
  (boardId/blocked/needsNaz) still goes through the same server-enforced rules
  above, and also pushes live to the real Monday item if this card already has
  one (mondayItemId in the context below).`;

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
      "Draft a new Monday payload, or fully rewrite an existing one. Call this once you have enough to either draft the real Monday payload or determine no action is needed. Status and people columns are set automatically from boardId -- you don't provide columnValues yourself, just blocked/needsNaz if either genuinely applies.",
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
        priority: { type: "integer", minimum: 1, maximum: 5, description: "1 (blocker/long lead time) to 5 (FYI only) -- see the priority rubric. Defaults to 3 if omitted." },
        blocked: { type: "boolean", description: "True only if genuinely blocked on a client/3rd party -- sets status Stuck instead of the Start default." },
        needsNaz: { type: "boolean", description: "True only if this is complex/high-stakes enough that Naz should be tagged directly -- a deliberate judgment call, never a default." },
      },
      required: ["action"],
    },
  },
  {
    name: "edit_item",
    description:
      "Lightweight patch to this card -- title, note, priority, dashboard status, and/or board-scoped reassignment. Use this instead of resolve_item when the Monday payload itself doesn't need rewriting (e.g. just bumping priority, reopening a Handled item, marking done/ignored, or reassigning to a different board's team). Pass only the fields that should change. Status/assignee changes still go through the same server-enforced rules as resolve_item, and push live to Monday if this card was already sent (has a mondayItemId).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        note: { type: "string" },
        priority: { type: "integer", minimum: 1, maximum: 5, description: "1 (blocker/long lead time) to 5 (FYI only) -- see the priority rubric." },
        status: { type: "string", enum: ["ready", "confirm", "done", "ignored"], description: "Dashboard workflow status. Never \"sent\" -- that only happens via the real Send to Monday button." },
        boardId: { type: "string", description: "Reassign this item to a different board's fixed default team. Recomputes status/people columns." },
        blocked: { type: "boolean", description: "True only if genuinely blocked on a client/3rd party -- sets the Monday status column to Stuck instead of Start." },
        needsNaz: { type: "boolean", description: "True only as a deliberate judgment call to also tag Naz -- never a default." },
      },
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

// Maps the item.board label (as stored on the queue item, e.g. "CRM") to a
// numeric boardId -- needed so edit_item can reassign/recompute columnValues
// for items that never went through create_item (which is the only mode that
// stores a numeric boardId on the payload itself).
const BOARD_LABEL_IDS = {
  Ads: "18405754310",
  "Web+SEO": "18099807701",
  "Dev+SEO": "18099807701",
  CRM: "18418241405",
};

// Priority is an integer 1-5, defaulting to 3 (normal) if the model omits it
// or sends something out of range -- see the rubric in SYSTEM_RULES.
function clampPriority(p) {
  const n = Math.round(Number(p));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null;
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

// Builds the resolved payload + the item.title/item.note/item.priority rewrite
// for a "draft" resolution. Returns { error } on validation/lookup failure, or
// { payload, titleUpdate } on success -- status/people are always computed
// here, never trusted from the model's tool call.
function buildResolvedFields(item, input) {
  const validationError = validatePayload(input.mode, input);
  if (validationError) return { error: validationError };

  const priority = input.priority !== undefined
    ? clampPriority(input.priority)
    : (Number.isFinite(item.priority) ? item.priority : 3);

  if (input.mode === "update_only") {
    return {
      payload: { mode: "update_only", existingItemId: input.existingItemId, updateBody: input.updateBody },
      titleUpdate: { note: htmlToPlainText(input.updateBody), priority },
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
    titleUpdate: { title: input.itemName, note: [plain, assigned].filter(Boolean).join(" / "), priority },
  };
}

// Lightweight patch for edit_item -- title/note/priority/status are plain
// field rewrites; boardId/blocked/needsNaz re-derive columnValues through the
// same buildColumnValues() used by resolve_item, so reassignment obeys the
// identical server-enforced rules whether the card is still a draft or
// already sent. Returns { error }, or { patch, liveUpdate } where liveUpdate
// (if present) is what needs pushing to the real Monday item.
function buildEditFields(item, input) {
  const patch = {};

  if (input.title !== undefined) patch.title = input.title;
  if (input.note !== undefined) patch.note = input.note;
  if (input.priority !== undefined) {
    const p = clampPriority(input.priority);
    if (p === null) return { error: `invalid priority: ${input.priority}` };
    patch.priority = p;
  }
  if (input.status !== undefined) {
    if (!["ready", "confirm", "done", "ignored"].includes(input.status)) {
      return { error: `invalid status "${input.status}" -- edit_item can only set ready/confirm/done/ignored; "sent" only happens via the real Send to Monday button` };
    }
    if (input.status === "ready" && !item.payload) {
      return { error: "can't mark this ready -- there's no Monday payload yet. Use resolve_item to draft one first." };
    }
    patch.status = input.status;
  }

  let liveUpdate = null;
  if (input.boardId !== undefined || input.blocked !== undefined || input.needsNaz !== undefined) {
    const boardId = input.boardId || (item.payload && item.payload.boardId) || BOARD_LABEL_IDS[item.board];
    if (!boardId) return { error: "need a boardId to set or change assignees on this item -- ask Naz which board it belongs to" };

    // Preserve whichever of blocked/needsNaz isn't being touched right now,
    // read back off the existing columnValues so e.g. changing only priority
    // never silently resets an existing Stuck/needsNaz state.
    const existingCV = item.payload && item.payload.columnValues;
    const currentBlocked = existingCV ? existingCV[STATUS_COLUMN]?.label === "Stuck" : false;
    const currentNeedsNaz = existingCV ? (existingCV[PEOPLE_COLUMN]?.personsAndTeams || []).some((p) => p.id === NAZ_USER_ID) : false;
    const blocked = input.blocked !== undefined ? !!input.blocked : currentBlocked;
    const needsNaz = input.needsNaz !== undefined ? !!input.needsNaz : currentNeedsNaz;

    let columnValues;
    try {
      columnValues = buildColumnValues(boardId, blocked, needsNaz);
    } catch (err) {
      return { error: String(err) };
    }

    // update_only payloads don't carry columnValues (the real item they point
    // at already has its own status/assignees from whenever it was created),
    // so only rewrite the payload for create_item/create_subitem drafts.
    if (item.payload && item.payload.mode !== "update_only") {
      const updatedPayload = { ...item.payload, columnValues };
      if (item.payload.mode === "create_item") updatedPayload.boardId = boardId;
      patch.payload = updatedPayload;

      const assigned = assignedToLine(columnValues[PEOPLE_COLUMN].personsAndTeams);
      const priorAssigned = existingCV ? assignedToLine(existingCV[PEOPLE_COLUMN]?.personsAndTeams || []) : null;
      const noteBase = (priorAssigned && item.note && item.note.includes(priorAssigned))
        ? item.note.replace(priorAssigned, "").replace(/\s*\/\s*$/, "").trim()
        : item.note;
      patch.note = [noteBase, assigned].filter(Boolean).join(" / ");
    }

    if (item.mondayItemId) {
      liveUpdate = { itemId: item.mondayItemId, boardId, columnValues };
    }
  }

  if (Object.keys(patch).length === 0 && !liveUpdate) {
    return { error: "edit_item needs at least one field to change (title, note, priority, status, boardId, blocked, or needsNaz)" };
  }
  return { patch, liveUpdate };
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
## The card you're helping with right now
id: ${item.id}
title: ${item.title}
note: ${item.note || ""}
dashboard status: ${item.status || "confirm"}
priority: ${Number.isFinite(item.priority) ? item.priority : "unset (treated as 3/normal)"}
board (as drafted, verify before trusting): ${item.board || "n/a"}
client group: ${item.group || "n/a"}
source: ${item.sourceLabel || item.source || "n/a"}
has a drafted Monday payload: ${item.payload ? `yes (mode: ${item.payload.mode || "create_item"})` : "no"}
already sent to a real Monday item: ${item.mondayItemId ? `yes (item id ${item.mondayItemId})` : "no"}
${item.clarification ? `Naz previously told you: "${item.clarification}"` : ""}`;

    const system = SYSTEM_RULES + "\n" + itemContext;

    let convo = [...(history || []), { role: "user", content: message }];
    let finalText = "";
    let changed = false;
    let changedItem = null;

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
              const priority = tu.input.priority !== undefined ? clampPriority(tu.input.priority) : (Number.isFinite(fresh.data.items[freshIdx].priority) ? fresh.data.items[freshIdx].priority : 3);
              fresh.data.items[freshIdx] = { ...fresh.data.items[freshIdx], status: "ignored", priority, updatedAt: new Date().toISOString() };
              fresh.data.updatedAt = new Date().toISOString();
              await putJSON(QUEUE_PATH, fresh.data, `item-chat: ${id} resolved (ignore)`, fresh.sha);
              changed = true;
              changedItem = fresh.data.items[freshIdx];
              result = { ok: true };
            } else {
              const built = buildResolvedFields(fresh.data.items[freshIdx], tu.input);
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
                changed = true;
                changedItem = fresh.data.items[freshIdx];
                result = { ok: true };
              }
            }
          } else if (tu.name === "edit_item") {
            const fresh = await getJSON(QUEUE_PATH, EMPTY);
            const freshIdx = fresh.data.items.findIndex((it) => it.id === id);
            if (freshIdx === -1) {
              result = { error: `item ${id} no longer exists` };
            } else {
              const built = buildEditFields(fresh.data.items[freshIdx], tu.input);
              if (built.error) {
                result = { error: built.error };
              } else {
                fresh.data.items[freshIdx] = { ...fresh.data.items[freshIdx], ...built.patch, updatedAt: new Date().toISOString() };
                fresh.data.updatedAt = new Date().toISOString();
                await putJSON(QUEUE_PATH, fresh.data, `item-chat: ${id} edited`, fresh.sha);
                changed = true;
                changedItem = fresh.data.items[freshIdx];
                result = { ok: true };

                if (built.liveUpdate) {
                  try {
                    await updateMondayColumns(built.liveUpdate.boardId, built.liveUpdate.itemId, built.liveUpdate.columnValues);
                  } catch (err) {
                    // The local edit already saved -- a failed live push is a
                    // separate, non-fatal problem the model should surface to Naz.
                    result = { ok: true, warning: `saved locally but failed to update the live Monday item: ${String(err)}` };
                  }
                }
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

    return json(200, { reply: finalText, changed, item: changedItem });
  } catch (err) {
    console.error("item-chat function error:", err);
    return json(500, { error: String((err && err.message) || err) });
  }
};
