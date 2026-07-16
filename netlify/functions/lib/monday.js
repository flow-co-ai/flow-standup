// Payload modes supported by sendQueueItemToMonday:
//   create_item    (original) -- needs boardId, groupId, itemName
//   create_subitem             -- needs parentItemId, itemName (boardId derived if missing)
//   update_only                -- needs existingItemId, just posts the update, creates nothing
//
// Status/people columns for create_item/create_subitem are ALWAYS computed
// here at send time via buildColumnValues() -- never trusted from whatever
// payload.columnValues happens to contain. This is the single enforcement
// point shared with item-chat.js (which imports these from here rather than
// keeping its own copy) -- drafts authored anywhere (item-chat.js, the
// fireflies-monday-watch automation, a hand-edited queue entry) all get the
// same board-scoped default assignees and Start/Stuck status, with no way to
// silently end up empty.

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

// Shared read pattern for the mandatory board audit -- used by item-chat.js's
// monday_lookup tool and ops-chat.js's monday_lookup tool alike, so both hit
// the exact same query shape (never a second, slightly-different copy of it).
// Always a live call, no caching layer anywhere in front of it.
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

// Drills into ONE item for full detail monday_lookup doesn't carry: its own
// posted updates, AND (critically) each of its subitems' OWN updates too --
// a parent item's status often looks stale/unstarted while the real recent
// activity (a fix actually going live, a bug actually getting closed out) is
// posted on a specific subitem, not the parent. Two queries, both using the
// same plain items(ids:) shape (subitems are themselves real items with
// their own ids) rather than assuming updates nests cleanly inside a
// subitems selection -- always a live call, same as mondayLookup.
async function mondayItemDetail(itemId) {
  if (!itemId) throw new Error("monday_item_detail needs itemId");
  const data = await mondayGraphQL(
    `query($itemIds: [ID!]) {
       items(ids: $itemIds) {
         id
         name
         column_values { id text }
         updates(limit: 25) { id body creator { name } created_at }
         subitems { id name column_values { id text } }
       }
     }`,
    { itemIds: [itemId] }
  );
  const item = data?.items?.[0];
  if (!item) throw new Error(`monday_item_detail: no item found for id ${itemId} -- double check the id`);

  const subitemIds = (item.subitems || []).map((s) => s.id);
  if (subitemIds.length) {
    const subData = await mondayGraphQL(
      `query($itemIds: [ID!]) { items(ids: $itemIds) { id updates(limit: 25) { id body creator { name } created_at } } }`,
      { itemIds: subitemIds }
    );
    const updatesById = new Map((subData?.items || []).map((s) => [s.id, s.updates || []]));
    item.subitems = item.subitems.map((s) => ({ ...s, updates: updatesById.get(s.id) || [] }));
  }

  return item;
}

const STATUS_COLUMN = "color_mkwb1trm";
const PEOPLE_COLUMN = "multiple_person_mkwb5f2e";
const NAZ_USER_ID = 70062990;

// Board-scoped default assignees (Naz, 2026-07-15): never tag Naz/Sohib by
// default on any board -- only added via a deliberate needsNaz flag, never a
// default. Enforced here in code rather than just requested in a system
// prompt, so it can't be silently skipped or omitted by whatever authored
// the draft.
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

// Maps the item.board label (as stored on the queue item, e.g. "CRM") to a
// numeric boardId -- needed for payloads that only carry the label, not a
// numeric id (older/externally-authored drafts, or create_subitem payloads
// drafted before boardId was stored on them explicitly).
const BOARD_LABEL_IDS = {
  Ads: "18405754310",
  "Web+SEO": "18099807701",
  "Dev+SEO": "18099807701",
  CRM: "18418241405",
};

// Client -> group id per board. Promoted from the "Client group IDs" prose
// table in item-chat.js's DRAFTING_RULES into real structured data (Naz,
// 2026-07-16): a "status of X" question needs every one of a client's items
// on a board, and a keyword search over item NAMES misses items whose name
// doesn't happen to mention the topic -- confirmed live: Full Smile's
// "Duplicate Contacts" item (containing the actual recent fix updates for
// what was reported as a DigitalOcean/GHL bug) doesn't have "DigitalOcean"
// anywhere in its name, only in the update bodies posted on it. Group-scoped
// enumeration (list everything in this client's group, no keyword filter)
// is the only reliable way to not miss it. null means no group exists yet on
// that board. Same "verify before writing" caveat as the prose table applies
// to any WRITE path (a few boards share a group id with another board's,
// unconfirmed) -- reads here are best-effort and low-risk if slightly off.
const CLIENT_GROUPS = {
  "Maadi Law": { Ads: "group_mm51vdbk", "Web+SEO": "group_mm51tkzh", CRM: "group_mm5112vv" },
  MedStation: { Ads: "group_mm516qss", "Web+SEO": "group_mm51nc9h", CRM: "group_mm512p9w" },
  "Quality HVAC": { Ads: "group_mm23tg6s", "Web+SEO": "group_mm231wbb", CRM: "group_mm231wbb" },
  "Full Smile": { Ads: "group_mkxdznat", "Web+SEO": "group_mkxdmhbz", CRM: "group_mkxdmhbz" },
  "Justice Consumer Law": { Ads: "group_mkqxyga2", "Web+SEO": "group_mkqxyga2", CRM: null },
  Liferun: { Ads: "group_mkwj8zze", "Web+SEO": "group_mkwj9a1c", CRM: "group_mkwj9a1c" },
  "BillyDoe Meats": { Ads: "group_mm2dt8f", "Web+SEO": "group_mm2dqm7n", CRM: null },
  "Vous Physique": { Ads: "group_mm22cd1z", "Web+SEO": "group_mm231372", CRM: null },
  "Steel Round Bars": { Ads: "group_mkqxskcn", "Web+SEO": "group_mkqxskcn", CRM: "group_mkqxskcn" },
  "Flow Company": { Ads: "group_mkwjedjg", "Web+SEO": "group_mkwjem1v", CRM: null },
};

const BOARD_ORDER = ["Ads", "Web+SEO", "CRM"];

// Everything a client has across all 3 boards, group-scoped (no keyword
// filter, so nothing gets missed by naming) -- the primary tool for "what's
// the status of X for client Y" questions. One call replaces 3 manual
// per-board monday_lookup calls, so a board can't get silently skipped.
async function mondayClientOverview(client) {
  const groups = CLIENT_GROUPS[client];
  if (!groups) {
    const known = Object.keys(CLIENT_GROUPS).join(", ");
    throw new Error(`monday_client_overview: "${client}" isn't a recognized client. Known clients: ${known}. Check spelling/casing, or use monday_search_all_boards if this is a new/unlisted client.`);
  }
  return Promise.all(
    BOARD_ORDER.map(async (board) => {
      const groupId = groups[board];
      if (!groupId) return { board, items: [], note: "no group on this board for this client" };
      try {
        const items = await mondayLookup({ boardId: BOARD_LABEL_IDS[board], groupId });
        return { board, items };
      } catch (err) {
        return { board, items: [], error: String(err) };
      }
    })
  );
}

// Keyword search across all 3 real boards at once (Ads/Web+SEO/CRM, never
// Video) -- for when the client isn't known yet, or as a supplementary check
// alongside monday_client_overview. Board-wide (unscoped) per board, so it
// can still miss an item whose name/columns don't mention the term -- prefer
// monday_client_overview once the client is known.
async function mondaySearchAllBoards(searchTerm) {
  return Promise.all(
    BOARD_ORDER.map(async (board) => {
      try {
        const items = await mondayLookup({ boardId: BOARD_LABEL_IDS[board], searchTerm });
        return { board, items };
      } catch (err) {
        return { board, items: [], error: String(err) };
      }
    })
  );
}

// Reverse of BOARD_LABEL_IDS -- Web+SEO and Dev+SEO share an id, and Web+SEO
// is listed first, so that's the canonical label returned for it.
function boardLabelForId(boardId) {
  const entry = Object.entries(BOARD_LABEL_IDS).find(([, id]) => id === boardId);
  return entry ? entry[0] : null;
}

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

// Blocked/needsNaz are the real source of truth once stored as explicit
// top-level payload fields (set by item-chat.js's resolve_item/edit_item).
// For drafts that predate that (or came from outside item-chat.js entirely)
// and only ever got a baked columnValues blob, fall back to reverse-deriving
// blocked/needsNaz from it so old drafts don't regress to plain defaults.
function resolvePayloadFlags(payload) {
  if (payload.blocked !== undefined || payload.needsNaz !== undefined) {
    return { blocked: !!payload.blocked, needsNaz: !!payload.needsNaz };
  }
  const cv = payload.columnValues;
  if (!cv) return { blocked: false, needsNaz: false };
  const blocked = cv[STATUS_COLUMN]?.label === "Stuck";
  const needsNaz = (cv[PEOPLE_COLUMN]?.personsAndTeams || []).some((p) => p.id === NAZ_USER_ID);
  return { blocked, needsNaz };
}

// A single-generic-sentence updateBody has reached the Ads Team twice now --
// this makes it structurally impossible to send one, rather than relying on
// whichever model drafted it to remember to do better. Splits updateBody into
// its block-level lines (same boundaries as item-chat.js's note preview),
// drops the mandatory "Salam," opener and the trailing mention-chip line
// (neither is real content), and requires at least MIN_CONTENT_LINES distinct
// lines with real detail in them -- roughly a problem/context line and a
// goal/done line, however they're phrased -- not just enough bullets to game
// the count with filler.
const MIN_CONTENT_LINES = 2;
const MIN_LINE_WORDS = 5;
const MIN_TOTAL_WORDS = 20;

function updateBodyContentLines(html) {
  if (!html) return [];
  const text = html
    .replace(/<li[^>]*>/gi, "")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^salam,?$/i.test(l)) // the mandatory §7 opener, not content
    .filter((l) => !/^@/.test(l)); // a mention-chip-only line, not content
}

// Returns an error string if updateBody is too thin to actually send, or null
// if it clears the bar. This is the real gate -- it runs in code, at the last
// moment before anything fires to Monday, regardless of what the model
// intended or how thorough its system prompt says to be.
function checkUpdateBodySubstance(updateBody) {
  const lines = updateBodyContentLines(updateBody);
  const substantive = lines.filter((l) => l.split(/\s+/).filter(Boolean).length >= MIN_LINE_WORDS);
  const totalWords = substantive.reduce((n, l) => n + l.split(/\s+/).filter(Boolean).length, 0);
  if (substantive.length < MIN_CONTENT_LINES || totalWords < MIN_TOTAL_WORDS) {
    return `updateBody is too thin to send (${substantive.length} substantive line(s), ${totalWords} words) -- needs at least ${MIN_CONTENT_LINES} real points with actual detail (e.g. a problem/context line and a goal/done line), not a single generic sentence.`;
  }
  return null;
}

// Standing invariant: a real Monday item existing (mondayItemId set) always
// wins over whatever dashboard status was otherwise about to be written --
// "undo," an edit_item status change, or any other patch can never leave an
// item claiming to be un-sent when a real send already happened. Called at
// every known write point (queue.js's PATCH, item-chat.js's edit_item) right
// before the item is persisted, so this can't silently drift again.
function enforceSentInvariant(item) {
  if (item.mondayItemId && item.status !== "sent") {
    return { ...item, status: "sent" };
  }
  return item;
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
  // The hard content gate: nothing fires to Monday -- no item, no update --
  // until updateBody clears the substance bar. Runs here unconditionally, on
  // every mode, regardless of whether the payload came from item-chat.js's
  // own (already-checked) resolve_item or from anywhere else.
  const substanceError = checkUpdateBodySubstance(payload.updateBody);
  if (substanceError) return { error: substanceError };

  const mode = payload.mode || "create_item"; // default for any older payloads without a mode field
  let resultItemId;

  try {
    if (mode === "create_item" || mode === "create_subitem") {
      // boardId can come from the payload itself, or (for older/externally
      // authored drafts that never stored one) from the item's board label --
      // either way, this determines the ONLY status/people columns that get
      // sent, computed fresh below, never read from payload.columnValues.
      const boardId = payload.boardId || BOARD_LABEL_IDS[item.board];
      if (!boardId) {
        return { error: `can't determine which board's team this belongs to -- no boardId on the payload and "${item.board}" isn't a recognized board label` };
      }
      const { blocked, needsNaz } = resolvePayloadFlags(payload);
      let columnValues;
      try {
        columnValues = buildColumnValues(boardId, blocked, needsNaz);
      } catch (err) {
        return { error: String(err) };
      }

      if (mode === "create_item") {
        if (!payload.groupId || !payload.itemName) {
          return { error: "create_item payload missing groupId/itemName" };
        }
        const created = await mondayGraphQL(
          `mutation($board: ID!, $group: String!, $name: String!, $cols: JSON) {
             create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cols) { id }
           }`,
          { board: boardId, group: payload.groupId, name: payload.itemName, cols: JSON.stringify(columnValues) }
        );
        resultItemId = created.create_item.id;
      } else {
        if (!payload.parentItemId || !payload.itemName) {
          return { error: "create_subitem payload missing parentItemId/itemName" };
        }
        const created = await mondayGraphQL(
          `mutation($parent: ID!, $name: String!, $cols: JSON) {
             create_subitem(parent_item_id: $parent, item_name: $name, column_values: $cols) { id }
           }`,
          { parent: payload.parentItemId, name: payload.itemName, cols: JSON.stringify(columnValues) }
        );
        resultItemId = created.create_subitem.id;
      }
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

module.exports = {
  mondayGraphQL,
  mondayLookup,
  mondayItemDetail,
  mondayClientOverview,
  mondaySearchAllBoards,
  sendQueueItemToMonday,
  updateMondayColumns,
  STATUS_COLUMN,
  PEOPLE_COLUMN,
  NAZ_USER_ID,
  BOARD_ASSIGNEES,
  USER_NAMES,
  BOARD_LABEL_IDS,
  boardLabelForId,
  CLIENT_GROUPS,
  buildColumnValues,
  assignedToLine,
  resolvePayloadFlags,
  checkUpdateBodySubstance,
  enforceSentInvariant,
};
