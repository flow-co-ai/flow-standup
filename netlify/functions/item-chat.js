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

const { getJSON, updateJSON } = require("./lib/github");
const {
  mondayLookup,
  updateMondayColumns,
  STATUS_COLUMN,
  PEOPLE_COLUMN,
  BOARD_LABEL_IDS,
  buildColumnValues,
  assignedToLine,
  swapUpdateBodyMentions,
  resolvePayloadFlags,
  checkUpdateBodySubstance,
  enforceSentInvariant,
} = require("./lib/monday");

const ANTHROPIC_MODEL = "claude-sonnet-4-5"; // check docs.claude.com/en/docs/about-claude/models if this starts erroring
const QUEUE_PATH = "checks/draft-queue.json";
const EMPTY = { updatedAt: null, items: [] };

// Thrown inside an updateJSON mutate callback to abort the write without
// retrying (item gone, or the drafted/edited fields didn't validate) --
// anything else thrown (a real ConflictError included) is retried/propagated
// by updateJSON itself.
class ToolAbort extends Error {}

// DRAFTING_RULES is tool-name-agnostic on purpose: it's shared verbatim with
// ops-chat.js (the global widget, which drafts brand-new cards under its own
// tool names) so the board IDs, client group IDs, format rules, priority
// rubric, and assignment enforcement can never drift between the two
// assistants. Each consumer's own SYSTEM_RULES wraps this with its own
// framing + "Your tools" section naming its own specific tools.
const DRAFTING_RULES = `## Two different "status" concepts -- don't confuse them
1. **Dashboard status** (a card's workflow state in the queue: ready / confirm
   / done / ignored / sent). A freshly drafted item starts as "ready" (a real
   payload exists, not yet sent to Monday) -- "sent" only happens once the
   real Send action has actually fired an API call to Monday.
2. **Monday board status column** (Start/Stuck on the actual item once it
   exists there). This is set automatically from blocked/needsNaz -- see
   below -- nobody sets it directly.

## Priority (every item has this -- always set it when drafting or editing)
Integer 1-5, 1 = most urgent. Use this rubric:
- 1 = blocker or long external lead time (nothing else can proceed until this
  moves, or it depends on a slow third party)
- 2 = time-sensitive (real deadline or client waiting, but not fully blocking)
- 3 = normal (default, no particular urgency)
- 4 = low (nice to get to, no pressure)
- 5 = FYI only (informational, no real action needed)
Include your best priority judgment every time -- don't leave it stale after
a change that shifts urgency (e.g. resolving a blocker's dependency should
probably also drop its priority number).

## Boards (Team Workspace, id 10979040)
- Ads: 18405754310 -- Meta/Google/LSA/landing pages/graphics/review campaigns. Media buying only.
- Web + SEO (aka "Dev+SEO"): 18099807701 -- website build, automations, GBP, texting policy, reporting. NOT CRM/GHL work.
- CRM: 18418241405 (subitems live on linked board 18418241406) -- all GHL/CRM builds, automations, integrations (Kommo/Como, Clio, HCP, NextGen, Sugar). Owned by Ahmed Memon + Ali Shaheer.
- Video: 18100257069 -- reopened 2026-07-21 (previously "DO NOT USE," that's stale, ignore any older copy of this rule you find). Genuine standalone video production/content (shoots, edits, YouTube uploads) goes here, default assignee Sohib alone. Campaign creative that serves a specific live ad still folds into that Ads item instead, same as before.

## IMPORTANT: a subitem's parent lives on ONE board -- board and parentItemId must never disagree
A subitem (parentItemId set) belongs to whatever board its PARENT item is actually on. If you are changing an existing item/subitem's board (not drafting fresh), and it currently has a parentItemId, moving it to a different board almost always means it can no longer be that same parent's subitem -- the old parent lives on the old board, not the new one. When a board change is requested on something that's a subitem: either (a) find/create the equivalent parent workstream on the NEW board and re-point parentItemId there, or (b) if there's no sensible parent on the new board, convert it to a plain top-level item instead (clear parentItemId) and say so explicitly, or (c) ask Naz which he wants rather than silently leaving a stale parentItemId that now points at an item on a board this one no longer lives on. Never leave board and parentItemId pointing at two different boards at once -- that's a broken state, not a valid one.

## Client group IDs (Ads / Web+SEO / CRM / Video)
Full audit 2026-07-22 -- every client below now has a real, live-confirmed group on all 4 boards. No more "verify before writing" guesses; these were checked directly against each board's live group list.
- Maadi Law: group_mm51vdbk / group_mm51tkzh / group_mm5112vv / group_mm5064vm
- MedStation: group_mm516qss / group_mm51nc9h / group_mm512p9w / group_mm5gq0cw
- Quality HVAC: group_mm23tg6s / group_mm231wbb / group_mm231wbb / group_mm2660b4 (CRM and Web+SEO share an id -- confirmed coincidental, not a bug)
- Full Smile: group_mkxdznat / group_mkxdmhbz / group_mkxdmhbz / group_mkxd24va (CRM and Web+SEO share an id -- confirmed coincidental)
- Justice Consumer Law: group_mkqxyga2 / group_mkqxyga2 / group_mm5gdrn3 / group_mkqxyga2
- Liferun: group_mkwj8zze / group_mkwj9a1c / group_mkwj9a1c / group_mkwj5qjb (CRM and Web+SEO share an id -- confirmed coincidental)
- BillyDoe Meats: group_mm2dt8f / group_mm2dqm7n / group_mm5gt78e / group_mm2ddrwm
- Vous Physique: group_mm22cd1z / group_mm231372 / group_mm5gyktb / group_mm2pyqs3
- Steel Round Bars: group_mm5gmpwf / group_mkqxskcn / group_mkqxskcn / group_mkqxskcn (Ads group recreated 2026-07-22, its old one had vanished from the live board)
- Flow Company (internal): group_mkwjedjg / group_mkwjem1v / group_mm5g4pdh / group_mkwj30hd
If the client or its group id isn't listed here or you're unsure it's current, look it up on Monday rather than guessing -- group IDs can change, and this table has gone stale before (missed two board additions in a row -- always cross-check lib/monday.js's CLIENT_GROUPS, the real source of truth, if anything here looks off).

## MANDATORY board audit before drafting anything new
Before drafting a new item, subitem, or update, you MUST look up the relevant
board (and client group, when known) to check whether a parent item, existing
subitem, or duplicate already exists for this client's workstream. Never
guess an existingItemId or parentItemId -- look it up. One good lookup is
usually enough; don't loop forever, but don't skip it either.

## Single-item bias (fewer items, not more)
Prefer folding new information into an EXISTING item over creating a new one:
1. If a parent item already exists for this workstream, draft a subitem
   against it rather than a new top-level item.
2. If this is just new information/confirmation about work already tracked,
   post an update onto the existing item instead (create nothing new).
3. Only create a new top-level item when this is a genuinely new workstream
   with no existing parent on the board.
Less is more -- one sequenced workflow is one item with steps in the update,
not several items.

## Update format (§7) -- updateBody MUST follow this exactly
1. Open with "<p>Salam,</p>" -- nothing else, no @-tag at the start.
2. Body as "<ul><li>...</li></ul>" bullets. Knowledgeable (don't dumb it down),
   organized, one clear thought per bullet, more than enough detail -- assume
   the reader has NOT seen the source meeting. A single generic sentence
   ("client wants the lead form fixed") is NEVER an acceptable updateBody, no
   matter how small the item looks. Always write MULTIPLE bullets covering,
   at minimum:
   - **Context**: what happened and why this is being drafted, in enough
     detail that someone who never saw the source meeting/message understands
     the situation, not just the headline.
   - **The actual deliverable(s) or step(s)**, specific enough that the
     assignee can start executing without a follow-up question.
   - **Dependencies/constraints**: what this is waiting on, what it depends
     on, what NOT to touch or change. If there are genuinely none, say so
     explicitly ("No dependencies -- can start immediately") rather than
     dropping the point.
   - **Done/success criterion**: what "finished" looks like for this item --
     the same "done = ___" test used to decide whether something is a real
     task at all.
   If the source content is genuinely thin, that's a sign to ask a follow-up
   question (or look it up on Monday for more context) rather than drafting a
   thin one-line update. This is a HARD gate, not just this instruction:
   drafting and the real send both run a code-level check (at least 2
   distinct lines with real detail, not just enough bullets to game the
   count) and will reject a too-thin updateBody with an error instead of
   saving/sending it -- if that happens, don't just resubmit the same
   content, actually add the missing context/goal.
3. Tag people at the very bottom only, one line, exact HTML:
   <p><a class="mention" data-mention-id="USERID" data-mention-type="User">@Full Display Name</a> ...</p>
4. NEVER use em dashes (—) or en dashes (–). Avoid hyphens outside canonical terms.
5. itemName: 2-3 words max, lead with the noun or action verb. No articles.
6. Bold (<strong>) action verbs, deadlines, and constraints.
7. HTML only, no markdown.

## Assignment is automatic and server-enforced -- nobody sets columnValues by hand
Status and people columns are always derived server-side from boardId +
blocked + needsNaz, using fixed default assignees per board:
- Ads board: Khurram Jamil + Ads Team
- Web+SEO board: Muhammad Hashir Faiz + Zayan Faiz
- CRM board: Ahmed Memon + Ali Shaheer
You cannot hand-pick a single person off that pair, or tag anyone outside it --
if asked for someone not on the fixed list for that board, say so rather than
inventing a workaround. Do NOT tag Naz or Sohib by default on ANY board. Only
treat needsNaz as true as a deliberate judgment call when the task is
genuinely complex or high-stakes enough to need Naz directly involved -- never
as a default, and never just because someone asked a question in chat. Status
defaults to Start. Only treat blocked as true if this is genuinely blocked on
a client or 3rd party (sets status to Stuck instead, on the Monday board
status column -- not the dashboard status). Drafting a subitem also needs
boardId (not used in the mutation itself, but required so the right default
assignees can be applied).

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
Leave timeline blank unless a real deadline is named.`;

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

${DRAFTING_RULES}

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

// mondayLookup now lives in lib/monday.js (imported above) -- shared verbatim
// with ops-chat.js's own monday_lookup tool, so both hit the exact same query.

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

// STATUS_COLUMN/PEOPLE_COLUMN/BOARD_LABEL_IDS/buildColumnValues/assignedToLine/
// resolvePayloadFlags all now live in lib/monday.js (imported above) -- it's
// the single enforcement point shared with sendQueueItemToMonday, so a
// draft's status/people are computed identically whether it's resolved here
// or sent there, and never drift out of sync between the two.

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

  // Same hard gate sendQueueItemToMonday enforces right before it actually
  // fires anything -- checked here too so a thin draft gets rejected back
  // into the chat immediately (with a concrete reason) instead of only
  // failing much later when Naz clicks Send.
  const substanceError = checkUpdateBodySubstance(input.updateBody);
  if (substanceError) return { error: substanceError };

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

  // boardId/blocked/needsNaz are stored explicitly (not just baked into
  // columnValues) so sendQueueItemToMonday can recompute status/people fresh
  // at send time from these, rather than trusting the columnValues blob below
  // (which is kept only as a human-readable preview for the dashboard note).
  const payload = {
    mode: input.mode,
    itemName: input.itemName,
    boardId: input.boardId,
    blocked: !!input.blocked,
    needsNaz: !!input.needsNaz,
    columnValues,
    updateBody: input.updateBody,
  };
  if (input.mode === "create_item") {
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
    const oldBoardId = (item.payload && item.payload.boardId) || BOARD_LABEL_IDS[item.board];
    const boardId = input.boardId || oldBoardId;
    if (!boardId) return { error: "need a boardId to set or change assignees on this item -- ask Naz which board it belongs to" };
    const boardActuallyChanged = !!(oldBoardId && boardId !== oldBoardId);

    // Preserve whichever of blocked/needsNaz isn't being touched right now --
    // resolvePayloadFlags reads the explicit fields if present, falling back
    // to reverse-deriving from a baked columnValues blob for older drafts --
    // so e.g. changing only priority never silently resets an existing
    // Stuck/needsNaz state.
    const currentFlags = item.payload ? resolvePayloadFlags(item.payload) : { blocked: false, needsNaz: false };
    const blocked = input.blocked !== undefined ? !!input.blocked : currentFlags.blocked;
    const needsNaz = input.needsNaz !== undefined ? !!input.needsNaz : currentFlags.needsNaz;

    let columnValues;
    try {
      columnValues = buildColumnValues(boardId, blocked, needsNaz);
    } catch (err) {
      return { error: String(err) };
    }

    // update_only payloads don't carry status/people (the real item they
    // point at already has its own from whenever it was created), so only
    // rewrite the payload for create_item/create_subitem drafts.
    if (item.payload && item.payload.mode !== "update_only") {
      const existingCV = item.payload.columnValues;
      const updateBody = swapUpdateBodyMentions(item.payload.updateBody, columnValues[PEOPLE_COLUMN].personsAndTeams);
      const updatedPayload = { ...item.payload, boardId, blocked, needsNaz, columnValues, updateBody };

      // Same fix as queue.js's applyBoardReassignment -- a subitem's board is
      // dictated entirely by its parent (create_subitem only ever sends
      // parent_item_id to Monday, never payload.boardId), so an actual board
      // change here can't keep this a valid subitem of its old parent. Detach
      // it into a plain top-level item rather than leaving board and
      // parentItemId disagreeing.
      let detachedNote = null;
      if (boardActuallyChanged && item.payload.mode === "create_subitem" && item.payload.parentItemId) {
        updatedPayload.mode = "create_item";
        delete updatedPayload.parentItemId;
        delete updatedPayload.parentItemName;
        const oldParentLabel = item.payload.parentItemName || `#${item.payload.parentItemId}`;
        detachedNote = `Detached from its parent (was a subitem of ${oldParentLabel}) -- that parent lives on the old board. Now a standalone item -- re-parent it if it should be a subitem of something on the new board instead.`;
      }

      patch.payload = updatedPayload;

      const assigned = assignedToLine(columnValues[PEOPLE_COLUMN].personsAndTeams);
      const priorAssigned = existingCV ? assignedToLine(existingCV[PEOPLE_COLUMN]?.personsAndTeams || []) : null;
      const noteBase = (priorAssigned && item.note && item.note.includes(priorAssigned))
        ? item.note.replace(priorAssigned, "").replace(/\s*\/\s*$/, "").trim()
        : item.note;
      patch.note = [noteBase, assigned, detachedNote].filter(Boolean).join(" / ");
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

// Shared by this file's own edit_item tool AND ops-chat.js's global
// edit_queue_item tool -- one retry-safe write path (buildEditFields'
// validation + enforceSentInvariant + updateJSON's retry-on-409 + the live
// Monday column push), so the global assistant never gets a second, looser
// copy of the same logic.
async function editQueueItem(id, input) {
  try {
    let liveUpdate = null;
    const written = await updateJSON(QUEUE_PATH, (data) => {
      const idx = data.items.findIndex((it) => it.id === id);
      if (idx === -1) throw new ToolAbort(`item ${id} no longer exists`);
      const built = buildEditFields(data.items[idx], input);
      if (built.error) throw new ToolAbort(built.error);
      // enforceSentInvariant: a real Monday item existing always wins over
      // whatever status this edit asked for.
      data.items[idx] = enforceSentInvariant({ ...data.items[idx], ...built.patch, updatedAt: new Date().toISOString() });
      data.updatedAt = new Date().toISOString();
      liveUpdate = built.liveUpdate || null; // last attempt's wins -- only the write that actually lands matters
      return data;
    }, `item-chat: ${id} edited`, { fallback: EMPTY });
    const item = written.items.find((it) => it.id === id);

    if (liveUpdate) {
      try {
        await updateMondayColumns(liveUpdate.boardId, liveUpdate.itemId, liveUpdate.columnValues);
      } catch (err) {
        // The local edit already saved -- a failed live push is a separate,
        // non-fatal problem the caller should surface, not fail the whole edit on.
        return { ok: true, item, warning: `saved locally but failed to update the live Monday item: ${String(err)}` };
      }
    }
    return { ok: true, item };
  } catch (err) {
    return { error: err instanceof ToolAbort ? err.message : String(err) };
  }
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
            // updateJSON re-reads fresh and re-runs this on a 409 (another
            // card's edit, or the automation, colliding on the same sha) --
            // so a "no longer exists" / build error found on the LATEST read
            // is what actually aborts the tool call, not a stale first read.
            try {
              const written = await updateJSON(QUEUE_PATH, (data) => {
                const idx = data.items.findIndex((it) => it.id === id);
                if (idx === -1) throw new ToolAbort(`item ${id} no longer exists`);
                if (tu.input.action === "ignore") {
                  const priority = tu.input.priority !== undefined ? clampPriority(tu.input.priority) : (Number.isFinite(data.items[idx].priority) ? data.items[idx].priority : 3);
                  data.items[idx] = { ...data.items[idx], status: "ignored", priority, updatedAt: new Date().toISOString() };
                } else {
                  const built = buildResolvedFields(data.items[idx], tu.input);
                  if (built.error) throw new ToolAbort(built.error);
                  data.items[idx] = { ...data.items[idx], ...built.titleUpdate, status: "ready", payload: built.payload, updatedAt: new Date().toISOString() };
                }
                data.updatedAt = new Date().toISOString();
                return data;
              }, `item-chat: ${id} resolved (${tu.input.action === "ignore" ? "ignore" : tu.input.mode})`, { fallback: EMPTY });
              changed = true;
              changedItem = written.items.find((it) => it.id === id);
              result = { ok: true };
            } catch (err) {
              result = { error: err instanceof ToolAbort ? err.message : String(err) };
            }
          } else if (tu.name === "edit_item") {
            result = await editQueueItem(id, tu.input);
            if (result.ok) { changed = true; changedItem = result.item; }
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

// Exported so ops-chat.js's draft_new_item tool reuses the exact same
// drafting logic and rules (mandatory board audit prose, priority rubric,
// §7 format, server-enforced buildColumnValues, the checkUpdateBodySubstance
// gate) instead of a third copy of any of it. buildResolvedFields itself
// only reads item.priority as a fallback, so it works unmodified against a
// synthetic {} "item" when drafting a brand-new card from scratch.
exports.DRAFTING_RULES = DRAFTING_RULES;
exports.buildResolvedFields = buildResolvedFields;
exports.validatePayload = validatePayload;
exports.htmlToPlainText = htmlToPlainText;
exports.clampPriority = clampPriority;
exports.editQueueItem = editQueueItem;
