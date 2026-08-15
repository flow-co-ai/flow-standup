// POST { id, message, history } -> per-item chatbot for one Draft Queue card.
// General edit assistant for that one card: it can just reply conversationally,
// or act via two tools -- resolve_item (draft/rewrite the real Monday payload:
// mode, itemName, updateBody, board/group/parent) and edit_item (lightweight
// patch: title, note, priority, dashboard status, or board-scoped reassignment).
// Either tool writes straight onto checks/draft-queue.json on the state branch
// (edit_item also pushes a live Monday column update if the item already has a
// mondayItemId) -- no waiting for the next fireflies-monday-watch run.
//
// SYSTEM_RULES wraps DRAFTING_RULES (loaded from rules/drafting-rules.md,
// see below) with this tool's own framing + "Your tools" section.

const fs = require("fs");
const path = require("path");
const { getJSON, updateJSON } = require("./lib/github");
const { formatPastDecisionsBlock } = require("./lib/pastDecisions");
const {
  mondayLookup,
  mondayItemNameAndParent,
  mondayItemDetail,
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
//
// Loaded from rules/drafting-rules.md (2026-08-15) -- previously a hand-
// copied template literal here, which drifted from monday-automation.md's
// own copy of the same rules repeatedly (stale assignee data, a rule
// documented there but never implemented here, mismatched audit-scope
// wording). rules/drafting-rules.md is now the ONE hand-authored copy;
// the scheduled automation (SKILL.md) fetches the same file live from
// GitHub's raw-content API instead of reading its own separate prose.
// netlify.toml's [functions].included_files MUST list this path or Netlify
// bundles nothing for it -- readFileSync then throws (not a silent empty
// string) so a bad deploy fails loudly at cold start, not with blank rules.
const DRAFTING_RULES_PATH = path.join(__dirname, "..", "..", "rules", "drafting-rules.md");
const DRAFTING_RULES = (() => {
  const raw = fs.readFileSync(DRAFTING_RULES_PATH, "utf-8");
  // First line is a "<!-- rules-version: YYYY-MM-DD -->" stamp -- for git
  // history/version tracking, not part of what the model should read.
  const text = raw.replace(/^<!--.*?-->\s*/, "").trim();
  if (!text) {
    throw new Error(`DRAFTING_RULES loaded empty from ${DRAFTING_RULES_PATH} -- check netlify.toml's included_files`);
  }
  return text;
})();

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
- look things up on Monday first (monday_lookup, monday_item_detail) whenever
  you need context, regardless of the card's current status

Never guess: use monday_lookup/monday_item_detail or ask a specific follow-up
question rather than resolving or editing on a guess. In particular, before
telling Naz something already exists on Monday, is already handled, or isn't
logged anywhere -- call monday_item_detail on the specific item first.
monday_lookup only returns item NAMES and column values; the real answer to
"is this already there" is very often sitting in an update or a reply on an
existing thread, which monday_lookup cannot see at all. Answering from names
alone is exactly how this has argued with Naz over something that was, in
fact, already logged as a comment.

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
- monday_item_detail(itemId): full detail on ONE item by id -- its own posted
  updates (with reply threads), its subitems, and each subitem's own updates.
  This is the tool that actually answers "does this already exist" or "is
  this already logged" -- monday_lookup cannot see updates or replies at all.
  Call it on the specific item (this card's existingItemId/mondayItemId, or
  whatever monday_lookup surfaced) before asserting either way.
- resolve_item(...): call this to draft a NEW Monday payload, or fully rewrite
  an existing one (new itemName/updateBody/mode/etc). Two shapes:
  - action: "ignore" -- no Monday action needed (duplicate, informational only,
    already handled elsewhere). No other fields required.
  - action: "draft" -- provide mode (create_item | create_subitem | update_only),
    the fields that mode needs, updateBody in the §7 format above (almost
    always include one), priority (rubric above), and blocked/needsNaz if
    either genuinely applies. For update_only specifically, if Naz wants this
    posted as a reply on a specific existing update (found via
    monday_item_detail) rather than a new top-level comment, pass its id as
    parentUpdateId.
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
    name: "monday_item_detail",
    description:
      "Full detail on one Monday item by id: its column values, its own posted updates (including reply threads on each), its subitems, AND each subitem's own posted updates. Call this BEFORE claiming something does or doesn't already exist on Monday, or that work is or isn't already logged -- monday_lookup's item names alone are not enough to answer that; the real answer is often in an update or a reply, not the item name or status column. Always a fresh, live call.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
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
        parentUpdateId: { type: "string", description: "update_only only. Post updateBody as a reply on this existing update's thread (found via monday_item_detail) instead of a new top-level comment. Omit for a new top-level comment." },
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
async function buildResolvedFields(item, input) {
  const validationError = validatePayload(input.mode, input);
  if (validationError) return { error: validationError };

  // Monday doesn't support subitems of subitems. Confirmed live 2026-08-04:
  // the model correctly noted this limitation in its own reply, then set
  // parentItemId to a subitem's id anyway and reported success -- the
  // invalid payload only surfaced later as a 403 USER_UNAUTHORIZED at actual
  // send time. Check live, once, here -- the one place both item-chat.js's
  // resolve_item and ops-chat.js's draft_new_item build a create_subitem
  // payload -- so this can't be silently skipped by either caller.
  if (input.mode === "create_subitem" && input.parentItemId) {
    try {
      const parentInfo = await mondayItemNameAndParent(input.parentItemId);
      if (parentInfo.parentItem) {
        return {
          error: `"${parentInfo.name}" (id ${input.parentItemId}) is itself a subitem of "${parentInfo.parentItem.name}" -- Monday doesn't support subitems of subitems. Draft this as a top-level item instead (mode: "create_item"), or as a subitem of "${parentInfo.parentItem.name}" (id ${parentInfo.parentItem.id}) if that fits the workstream better.`,
        };
      }
    } catch (err) {
      // Live lookup failed (bad id, transient network issue) -- don't block
      // an otherwise-valid draft on an unrelated Monday hiccup. If
      // parentItemId is genuinely wrong, sendQueueItemToMonday's own
      // create_subitem call still surfaces that clearly at send time.
      console.error(`buildResolvedFields: couldn't verify parentItemId ${input.parentItemId} isn't itself a subitem:`, err);
    }
  }

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
    const payload = { mode: "update_only", existingItemId: input.existingItemId, updateBody: input.updateBody };
    // Reply-to-an-existing-thread instead of a new top-level comment -- set
    // by the destination picker's "reply to" step, or by the model itself
    // when Naz points it at a specific existing update via monday_item_detail.
    // Honored by sendQueueItemToMonday's create_update call (parent_id).
    if (input.parentUpdateId) payload.parentUpdateId = input.parentUpdateId;
    // Same live lookup queue.js's resolveMissingMondayNames does for
    // backfill -- needed here too since that backfill only runs on a full
    // page GET, and the frontend patches the card straight from this
    // response, not from a subsequent queue reload.
    try {
      const info = await mondayItemNameAndParent(input.existingItemId);
      payload.itemName = info.name;
      if (info.parentItem) {
        payload.parentItemId = info.parentItem.id;
        payload.parentItemName = info.parentItem.name;
      }
    } catch (err) {
      console.error(`buildResolvedFields: couldn't resolve Monday name for existingItemId ${input.existingItemId}:`, err);
    }

    // Carries its own assignee data explicitly, same as create_item/
    // create_subitem below -- update_only still only ever posts a comment at
    // send time (no column mutation), this is just so nothing downstream has
    // to reverse-derive assignees from updateBody's plain-text/mention line
    // the way the 2026-08-13 mention-chip backfill had to.
    const boardId = input.boardId || (item.payload && item.payload.boardId) || BOARD_LABEL_IDS[item.board];
    if (boardId) {
      try {
        const blocked = !!input.blocked;
        const needsNaz = !!input.needsNaz;
        payload.boardId = boardId;
        payload.blocked = blocked;
        payload.needsNaz = needsNaz;
        payload.columnValues = buildColumnValues(boardId, blocked, needsNaz);
      } catch (err) {
        console.error(`buildResolvedFields: couldn't build columnValues for update_only existingItemId ${input.existingItemId}:`, err);
      }
    }

    return {
      payload,
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

    const system = SYSTEM_RULES + "\n" + itemContext + formatPastDecisionsBlock(data.items);

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
          } else if (tu.name === "monday_item_detail") {
            result = await mondayItemDetail(tu.input.itemId);
          } else if (tu.name === "resolve_item") {
            // updateJSON re-reads fresh and re-runs this on a 409 (another
            // card's edit, or the automation, colliding on the same sha) --
            // so a "no longer exists" / build error found on the LATEST read
            // is what actually aborts the tool call, not a stale first read.
            try {
              const written = await updateJSON(QUEUE_PATH, async (data) => {
                const idx = data.items.findIndex((it) => it.id === id);
                if (idx === -1) throw new ToolAbort(`item ${id} no longer exists`);
                if (tu.input.action === "ignore") {
                  const priority = tu.input.priority !== undefined ? clampPriority(tu.input.priority) : (Number.isFinite(data.items[idx].priority) ? data.items[idx].priority : 3);
                  data.items[idx] = { ...data.items[idx], status: "ignored", priority, updatedAt: new Date().toISOString() };
                } else {
                  const built = await buildResolvedFields(data.items[idx], tu.input);
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

    // Persisted so a card's conversation survives a page reload -- the
    // frontend only ever kept this in memory before. Separate write from
    // whatever resolve_item/edit_item already did this turn (or nothing, on
    // a plain Q&A turn), since it needs to happen on every message
    // regardless. Capped so a very chatty card can't grow
    // checks/draft-queue.json without bound.
    const chatHistory = [
      ...(history || []),
      { role: "user", content: message },
      { role: "assistant", content: finalText || "(no reply)" },
    ].slice(-40);
    try {
      await updateJSON(QUEUE_PATH, (fresh) => {
        const i = fresh.items.findIndex((it) => it.id === id);
        if (i !== -1) fresh.items[i] = { ...fresh.items[i], chatHistory, updatedAt: new Date().toISOString() };
        return fresh;
      }, `item-chat: persist chat history for ${id}`, { fallback: EMPTY });
    } catch (err) {
      console.error(`item-chat: failed to persist chat history for ${id}:`, err);
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
