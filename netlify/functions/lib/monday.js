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

const { getJSON, putJSON, updateJSON } = require("./github");
const { textSimilarity, SIMILARITY_DUP_THRESHOLD, COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD } = require("./textSimilarity");

const ANTHROPIC_MODEL = "claude-sonnet-4-5"; // check docs.claude.com/en/docs/about-claude/models if this starts erroring

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

// Powers the Draft Queue's per-card destination picker (site/addon.js) --
// the top-level items in a board+group, each with its own subitems'
// id/name, so the UI can offer both levels as a "Subitem of..."/"Update
// on..." target without a second round trip per item. Deliberately NOT
// mondayItemDetail's shape (updates + full column_values per item AND per
// subitem) -- that's a real cost across a whole group's worth of items when
// all this needs is id+name two levels deep. Same board+group query shape
// as mondayLookup, just a lighter selection.
// includeUpdates is opt-in (default false, what the destination picker
// uses) -- the dedup-audit caller (findLikelyDuplicate) is the only one
// that needs comment text, and asking Monday for it unconditionally would
// cost every picker fetch a field it never reads. Subitems' OWN updates
// need a SEPARATE batched query (same reason mondayItemDetail below
// doesn't nest updates inside its own subitems selection -- not assumed to
// nest cleanly), but it's still just one extra call for the WHOLE group,
// not per item.
async function mondayGroupItemsWithSubitems(boardId, groupId, { includeUpdates = false } = {}) {
  if (!boardId || !groupId) throw new Error("mondayGroupItemsWithSubitems needs boardId and groupId");
  const updatesField = includeUpdates ? "updates(limit: 5) { body }" : "";
  const data = await mondayGraphQL(
    `query($boardId: [ID!], $groupId: [String]) {
       boards(ids: $boardId) {
         groups(ids: $groupId) {
           items_page(limit: 100) { items { id name ${updatesField} subitems { id name } } }
         }
       }
     }`,
    { boardId: [boardId], groupId: [groupId] }
  );
  const board = data?.boards?.[0];
  if (!board) throw new Error(`mondayGroupItemsWithSubitems: no board found for boardId ${boardId} -- double check the id`);
  const group = board.groups?.[0];
  if (!group) throw new Error(`mondayGroupItemsWithSubitems: no group found for groupId ${groupId} on board ${boardId} -- the id may be wrong or have changed`);
  const rawItems = group.items_page?.items || [];
  let items = rawItems.map((it) => ({
    id: it.id,
    name: it.name,
    updates: it.updates || [],
    subitems: (it.subitems || []).map((s) => ({ id: s.id, name: s.name })),
  }));

  if (includeUpdates) {
    const subitemIds = items.flatMap((it) => it.subitems.map((s) => s.id));
    if (subitemIds.length) {
      const subData = await mondayGraphQL(
        `query($itemIds: [ID!]) { items(ids: $itemIds) { id updates(limit: 5) { body } } }`,
        { itemIds: subitemIds }
      );
      const updatesById = new Map((subData?.items || []).map((s) => [s.id, s.updates || []]));
      items = items.map((it) => ({
        ...it,
        subitems: it.subitems.map((s) => ({ ...s, updates: updatesById.get(s.id) || [] })),
      }));
    }
  }

  return items;
}

// Drills into ONE item for full detail monday_lookup doesn't carry: its own
// posted updates, AND (critically) each of its subitems' OWN updates too --
// a parent item's status often looks stale/unstarted while the real recent
// activity (a fix actually going live, a bug actually getting closed out) is
// posted on a specific subitem, not the parent. Two queries, both using the
// same plain items(ids:) shape (subitems are themselves real items with
// their own ids) rather than assuming updates nests cleanly inside a
// subitems selection -- always a live call, same as mondayLookup.
// creator_id/viewers on updates and board{id} on subitems (2026-08-03) are
// additive fields for inbox-live.js's read/reply state -- nothing else here
// reads them, existing consumers (ops-chat.js) are unaffected.
// replies (2026-08-15): the whole repo used to never request them, so an
// existing reply thread was invisible everywhere this pulls updates --
// including to the item-chat.js assistant, which is exactly why it could
// only ever post a brand-new top-level comment instead of answering inside
// an existing thread.
const UPDATE_FIELDS = "id body creator { name } creator_id created_at viewers { user_id } replies { id body creator { name } created_at }";

async function mondayItemDetail(itemId) {
  if (!itemId) throw new Error("monday_item_detail needs itemId");
  const data = await mondayGraphQL(
    `query($itemIds: [ID!]) {
       items(ids: $itemIds) {
         id
         name
         column_values { id text }
         updates(limit: 25) { ${UPDATE_FIELDS} }
         subitems { id name board { id } column_values { id text } }
       }
     }`,
    { itemIds: [itemId] }
  );
  const item = data?.items?.[0];
  if (!item) throw new Error(`monday_item_detail: no item found for id ${itemId} -- double check the id`);

  const subitemIds = (item.subitems || []).map((s) => s.id);
  if (subitemIds.length) {
    const subData = await mondayGraphQL(
      `query($itemIds: [ID!]) { items(ids: $itemIds) { id updates(limit: 25) { ${UPDATE_FIELDS} } } }`,
      { itemIds: subitemIds }
    );
    const updatesById = new Map((subData?.items || []).map((s) => [s.id, s.updates || []]));
    item.subitems = item.subitems.map((s) => ({ ...s, updates: updatesById.get(s.id) || [] }));
  }

  return item;
}

// Minimal lookup for queue.js's backfill of a draft-queue item/parent name
// that's only known by numeric id (an update_only payload's existingItemId,
// or a create_subitem/update_only payload's parentItemId) -- deliberately
// NOT mondayItemDetail's full {updates, subitems} pull, which would be
// wasteful for "just get the name (and, if it's a subitem, its parent's
// name too)".
async function mondayItemNameAndParent(itemId) {
  if (!itemId) throw new Error("mondayItemNameAndParent needs itemId");
  const data = await mondayGraphQL(
    `query($itemIds: [ID!]) { items(ids: $itemIds) { id name parent_item { id name } } }`,
    { itemIds: [itemId] }
  );
  const item = data?.items?.[0];
  if (!item) throw new Error(`mondayItemNameAndParent: no item found for id ${itemId}`);
  return { id: item.id, name: item.name, parentItem: item.parent_item ? { id: item.parent_item.id, name: item.parent_item.name } : null };
}

const STATUS_COLUMN = "color_mkwb1trm";
const PEOPLE_COLUMN = "multiple_person_mkwb5f2e";
const NAZ_USER_ID = 70062990;

// Board-scoped default assignees (Naz, 2026-07-15): never tag Naz/Sohib by
// default on any board -- only added via a deliberate needsNaz flag, never a
// default. Enforced here in code rather than just requested in a system
// prompt, so it can't be silently skipped or omitted by whatever authored
// the draft.
// EXCEPTION (Naz, 2026-07-21): the Video board is Sohib's own -- he IS the
// default tag there, not an opt-in needsNaz addition. This is the one board
// where that's deliberate, not a bug to "fix" back to the no-Sohib default.
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
  "18100257069": [ // Video: Sohib Boundaoui (deliberate default, see note above)
    { id: 69662034, kind: "person" },
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
  Video: "18100257069", // re-enabled as a real write target 2026-07-21 (Naz) --
  // was previously excluded on purpose ("no Video board" rule from 2026-05-12,
  // see monday-automation.md). Reversed: Naz wants video tasks postable here
  // directly, auto-tagged to Sohib (see BOARD_ASSIGNEES above). Same-day
  // follow-up: also added to BOARD_ORDER below -- initially left out on the
  // assumption this was dashboard-only, but Naz confirmed the automated
  // pipeline (fireflies-monday-watch) and status/search queries should see
  // it too, not just manual dashboard writes.
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
// Video sub-key added 2026-07-21 (Naz) -- pulled live from the actual Video
// board (18100257069, still active, id confirmed via get_board_info) rather
// than guessed. MedStation has no group there (onboarded after this board
// went dormant in May) -- null until Naz confirms one should be created.
// Full audit + gap-fill 2026-07-22 (Naz): every client below now has a real,
// live-confirmed group id on all 4 boards, no nulls and no "unconfirmed"
// guesses left. Ads' "Steel Round Bars" group had gone missing entirely
// (existed as of the 2026-07-10 Tom Sugar correction, gone by 2026-07-22 --
// cause unknown, recreated). CRM's "Justice Consumer Law" group already
// existed live but had never been recorded here (was stored as null).
// CRM's "Billy Doe Meats"/"Vous Physique"/"Flow Company" groups didn't exist
// at all -- created fresh. Ids that are identical across boards for the same
// client (e.g. Full Smile's CRM id matching its Web+SEO id) are coincidental,
// not a bug -- confirmed correct against each board's own live group list,
// not assumed.
const CLIENT_GROUPS = {
  "Maadi Law": { Ads: "group_mm51vdbk", "Web+SEO": "group_mm51tkzh", CRM: "group_mm5112vv", Video: "group_mm5064vm" },
  MedStation: { Ads: "group_mm516qss", "Web+SEO": "group_mm51nc9h", CRM: "group_mm512p9w", Video: "group_mm5gq0cw" },
  "Quality HVAC": { Ads: "group_mm23tg6s", "Web+SEO": "group_mm231wbb", CRM: "group_mm231wbb", Video: "group_mm2660b4" },
  "Full Smile": { Ads: "group_mkxdznat", "Web+SEO": "group_mkxdmhbz", CRM: "group_mkxdmhbz", Video: "group_mkxd24va" },
  "Justice Consumer Law": { Ads: "group_mkqxyga2", "Web+SEO": "group_mkqxyga2", CRM: "group_mm5gdrn3", Video: "group_mkqxyga2" }, // CRM group existed live, never recorded until 2026-07-22
  Liferun: { Ads: "group_mkwj8zze", "Web+SEO": "group_mkwj9a1c", CRM: "group_mkwj9a1c", Video: "group_mkwj5qjb" },
  "Billy Doe Meats": { Ads: "group_mm2dt8f", "Web+SEO": "group_mm2dqm7n", CRM: "group_mm5gt78e", Video: "group_mm2ddrwm" }, // key renamed 2026-07-22 from "BillyDoe Meats" (no space) -- that never matched the real Monday group title or what fireflies-monday-watch actually writes to item.group ("Billy Doe Meats", with space), so every lookup for this client silently failed. Root cause of the live "no known group" alert Naz hit.
  "Steel Round Bars": { Ads: "group_mm5gmpwf", "Web+SEO": "group_mkqxskcn", CRM: "group_mkqxskcn", Video: "group_mkqxskcn" }, // Ads group recreated 2026-07-22, old one had vanished
  "Flow Company": { Ads: "group_mkwjedjg", "Web+SEO": "group_mkwjem1v", CRM: "group_mm5g4pdh", Video: "group_mkwj30hd" }, // CRM group created 2026-07-22
};

const BOARD_ORDER = ["Ads", "Web+SEO", "CRM", "Video"]; // Video added 2026-07-21 (Naz) -- see note above

// Everything a client has across all 3 boards, group-scoped (no keyword
// filter, so nothing gets missed by naming), with FULL DETAIL -- each item's
// own updates plus each of its subitems' updates -- already pulled in for
// every single item in the group, not just ones that look relevant to
// whatever topic was asked about. This is deliberate: judging an item
// "relevant" by name before deciding whether to look closer is exactly the
// gap that misses the one item in the group that doesn't happen to share a
// name with the topic but has the actual current status on it. Making this
// the ONE tool call that returns everything, already fully detailed, is what
// makes that gap structurally impossible rather than a matter of prompting
// the caller to remember to check "every item that looks relevant" -- there
// is no relevance filter here at all, everything comes back detailed.
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
        const detailed = await Promise.all(
          items.map((it) =>
            mondayItemDetail(it.id).catch((err) => ({ id: it.id, name: it.name, error: String(err) }))
          )
        );
        return { board, items: detailed };
      } catch (err) {
        return { board, items: [], error: String(err) };
      }
    })
  );
}

// Strips everything but lowercase letters/digits, so "DigitalOcean",
// "Digital Ocean", and "digital-ocean" all normalize to the same string.
// Used for every text comparison in mondaySearchAllBoards -- item names
// aren't reliably typed/cased consistently, and the search term someone
// types isn't either.
function normalizeForMatch(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const RECENT_ACTIVITY_DAYS = 14;

// Cheap per-board scan: id/name/group/updated_at only -- no column_values,
// no updates. This is the "just check names" pass that's fine to run across
// an entire board without pulling anything expensive. Queries groups()
// unfiltered (every group on the board) with items_page nested inside each
// -- the exact same nesting mondayLookup's groupId branch already uses
// successfully, just without an ids filter, rather than assuming an
// unverified flat group{title} field directly on Item.
async function mondayBoardScan(boardId) {
  const data = await mondayGraphQL(
    `query($boardId: [ID!]) {
       boards(ids: $boardId) {
         groups {
           title
           items_page(limit: 100) { items { id name updated_at } }
         }
       }
     }`,
    { boardId: [boardId] }
  );
  const board = data?.boards?.[0];
  if (!board) throw new Error(`mondayBoardScan: no board found for boardId ${boardId} -- double check the id`);
  const groups = board.groups || [];
  return groups.flatMap((g) => (g.items_page ? g.items_page.items || [] : []).map((it) => ({ ...it, group: g.title })));
}

// Search across all 4 real boards at once (Ads/Web+SEO/CRM/Video -- Video
// added 2026-07-21, previously excluded) for when the client isn't known yet.
// Two tiers, deliberately, to avoid pulling full update history for every
// item on every board just to check names:
//   1. Cheap scan (name/group/updated_at only) across every item on all 4
//      boards. Candidates are anything whose normalized name matches the
//      normalized search term, OR anything touched in the last
//      RECENT_ACTIVITY_DAYS days (a stale item's name not matching is a real
//      signal it's not the one; a recently-touched item might still be the
//      real match even if its name doesn't mention the topic at all, and the
//      cheap pass alone can't see into its update text to know).
//   2. Full detail (mondayItemDetail -- own updates + subitems' updates) only
//      for those candidates, never the whole board. A candidate survives as
//      a real match if its name matched, OR the term actually turns up
//      somewhere in its own or a subitem's update text -- this is where
//      "checks update text, not just titles" actually happens.
// Returns matches (each with board/id/name/group/detail) plus clientsMatched
// (the distinct client/group names among the matches), so the caller can
// tell apart "found it," "found it under 2+ clients, ask which," and "found
// nothing, ask which client."
async function mondaySearchAllBoards(searchTerm) {
  const term = normalizeForMatch(searchTerm);
  const cutoff = Date.now() - RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000;

  const scanned = await Promise.all(
    BOARD_ORDER.map(async (board) => {
      try {
        return { board, items: await mondayBoardScan(BOARD_LABEL_IDS[board]) };
      } catch (err) {
        return { board, items: [], error: String(err) };
      }
    })
  );

  const candidates = [];
  for (const { board, items } of scanned) {
    for (const it of items) {
      const nameMatches = !!term && normalizeForMatch(it.name).includes(term);
      const recentlyActive = !!it.updated_at && new Date(it.updated_at).getTime() >= cutoff;
      if (nameMatches || recentlyActive) {
        candidates.push({ board, id: it.id, name: it.name, group: it.group || null, nameMatches });
      }
    }
  }

  const detailed = await Promise.all(
    candidates.map(async (c) => {
      try {
        return { ...c, detail: await mondayItemDetail(c.id) };
      } catch (err) {
        return { ...c, error: String(err) };
      }
    })
  );

  const matches = detailed.filter((c) => {
    if (c.nameMatches) return true;
    if (!c.detail) return false;
    const ownText = (c.detail.updates || []).map((u) => u.body).join(" ");
    const subText = (c.detail.subitems || []).flatMap((s) => (s.updates || []).map((u) => u.body)).join(" ");
    return normalizeForMatch(ownText + " " + subText).includes(term);
  });

  const clientsMatched = [...new Set(matches.map((m) => m.group).filter(Boolean))];
  return { matches, clientsMatched };
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

// A subitem is a real item living on a SEPARATE board Monday auto-creates
// per parent board (e.g. Web+SEO's own subitems board, confirmed live
// 2026-08-04: 18099807884, "Subitems of Web + SEO") -- its status/people
// column ids are NOT the same as STATUS_COLUMN/PEOPLE_COLUMN above, which
// belong to the PARENT board. Sending those parent-board ids in a
// create_subitem's column_values doesn't apply to the right board at all --
// root cause of a live 403 USER_UNAUTHORIZED. Discovered by finding the
// parent board's own "subtasks"-type column (its settings_str.boardIds
// names the linked subitems board), then reading THAT board's own columns.
// Cached in-memory per parent board id (schema doesn't change at runtime,
// no TTL needed) -- same per-warm-container caching pattern as
// inbox-live.js's 45s cache, just without an expiry since there's nothing
// here that goes stale.
const _subitemsColumnCache = new Map(); // parentBoardId -> { subitemsBoardId, statusColumnId, peopleColumnId }

async function getSubitemsColumnIds(parentBoardId) {
  if (_subitemsColumnCache.has(parentBoardId)) return _subitemsColumnCache.get(parentBoardId);

  const boardData = await mondayGraphQL(
    `query($boardId: [ID!]) { boards(ids: $boardId) { columns { id type settings_str } } }`,
    { boardId: [parentBoardId] }
  );
  const subtasksCol = (boardData?.boards?.[0]?.columns || []).find((c) => c.type === "subtasks");
  if (!subtasksCol) throw new Error(`board ${parentBoardId} has no subitems ("subtasks") column -- can't resolve its subitems board`);

  let subitemsBoardId;
  try {
    subitemsBoardId = String(JSON.parse(subtasksCol.settings_str).boardIds[0]);
  } catch (err) {
    throw new Error(`board ${parentBoardId}'s subitems column settings couldn't be parsed: ${err}`);
  }

  const subBoardData = await mondayGraphQL(
    `query($boardId: [ID!]) { boards(ids: $boardId) { columns { id type } } }`,
    { boardId: [subitemsBoardId] }
  );
  const subColumns = subBoardData?.boards?.[0]?.columns || [];
  // Not every subitems board has both -- e.g. Video's ("Subitems of Video",
  // 18100257245) has no status-type column at all. null here means "skip
  // setting this column," not an error.
  const statusColumnId = (subColumns.find((c) => c.type === "status") || {}).id || null;
  const peopleColumnId = (subColumns.find((c) => c.type === "people") || {}).id || null;

  const result = { subitemsBoardId, statusColumnId, peopleColumnId };
  _subitemsColumnCache.set(parentBoardId, result);
  return result;
}

// Mirrors buildColumnValues' shape/label logic but targets the REAL subitems
// board's discovered column ids instead of the parent board's -- omits any
// column that board doesn't have (see getSubitemsColumnIds' Video note).
function buildSubitemColumnValues(personsAndTeams, blocked, subitemsColumnIds) {
  const cols = {};
  if (subitemsColumnIds.statusColumnId) {
    cols[subitemsColumnIds.statusColumnId] = { label: blocked ? "Stuck" : "Start" };
  }
  if (subitemsColumnIds.peopleColumnId) {
    cols[subitemsColumnIds.peopleColumnId] = { personsAndTeams };
  }
  return cols;
}

function assignedToLine(personsAndTeams) {
  return `Assigned to: ${personsAndTeams.map((p) => USER_NAMES[p.id] || `user ${p.id}`).join(", ")}`;
}

// Builds the §7-format trailing mention-chip line for a set of assignees --
// same shape as the one item-chat.js's drafting instructions specify
// (`<p><a class="mention" data-mention-id="USERID" ...>@Name</a> ...</p>`).
function mentionChipLine(personsAndTeams) {
  const chips = personsAndTeams
    .map((p) => `<a class="mention" data-mention-id="${p.id}" data-mention-type="User">@${USER_NAMES[p.id] || `user ${p.id}`}</a>`)
    .join(" ");
  return `<p>${chips}</p>`;
}

// Board/assignee changes (the dashboard's board dropdown via queue.js's
// applyBoardReassignment, or a chat-driven boardId change via item-chat.js's
// buildEditFields) recompute columnValues' People column and the separate
// "note" display line, but until this existed, never touched the ACTUAL
// mention-chip HTML inside updateBody -- so the item's People column would
// correctly show the new team while the update/comment text posted to
// Monday still @-tagged and notified the OLD team (confirmed live 2026-07-21:
// switching a Maadi Law card from Ads to CRM left "@Ads Team @Khurram Jamil"
// sitting in the update text, correct-looking People column notwithstanding).
// Strips every real mention anchor found anywhere in updateBody (there's
// only ever meant to be the one trailing line's worth per §7, but this is
// robust to however many individual <a> tags make it up, and to any stray
// whitespace/empty <p> left behind) and appends one fresh trailing line
// built from the new assignees.
function swapUpdateBodyMentions(updateBody, personsAndTeams) {
  if (!updateBody) return updateBody;
  const stripped = updateBody
    .replace(/<a[^>]*class="mention"[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/Assigned to:\s*[^<]*/gi, "")
    .replace(/<p>\s*<\/p>/gi, "")
    .replace(/(\s*&nbsp;\s*)+$/gi, "")
    .trimEnd();
  return `${stripped}${mentionChipLine(personsAndTeams)}`;
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

// A typed "@Hashir" or "@Muhammad Hashir Faiz" in updateBody is plain text --
// Monday never fires a notification or renders a chip for it, it just posts
// as literal characters (see §7's mention-chip HTML format). Strips out real
// mention anchors first (their own visible text also starts with "@", that's
// not what this is checking for), then looks for anything still starting
// with "@" followed by name-shaped text in what's left.
function findFakeMentionText(html) {
  if (!html) return [];
  const withoutRealMentions = String(html).replace(/<a[^>]*class="mention"[^>]*>[\s\S]*?<\/a>/gi, " ");
  const plainText = withoutRealMentions
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
  const matches = plainText.match(/@[A-Za-z][A-Za-z'.]*(?:\s+[A-Z][A-Za-z'.]*){0,3}/g) || [];
  return matches.map((m) => m.trim());
}

// Same "real gate in code, at the last moment" pattern as
// checkUpdateBodySubstance -- runs unconditionally in sendQueueItemToMonday,
// regardless of whether updateBody was drafted by the automation, edited via
// the dashboard's mention picker, or typed by hand anywhere else. Returns an
// error string naming exactly what looked like a fake mention, or null.
function checkMentionsAreReal(updateBody) {
  const fake = findFakeMentionText(updateBody);
  if (fake.length) {
    return `updateBody has "${fake.join('", "')}" typed as plain text, not a real Monday mention -- Monday won't notify anyone or render a chip for it. Use the @ picker to insert a real mention instead of typing it.`;
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

// Expands a too-thin updateBody using only what's already on the card --
// itemName, note, sourceLabel, board, group, and the current updateBody
// itself -- never inventing new facts. Existing mention chips (if any) are
// preserved verbatim; the model is told not to touch them. One attempt,
// called once from sendQueueItemToMonday right where the hard content gate
// would otherwise be a dead end -- the caller re-runs checkUpdateBodySubstance
// on the result and falls back to the original error if it's still thin, or
// if this call itself throws.
async function repairUpdateBody(item) {
  const payload = item.payload;
  const system = `You expand a too-thin Monday.com update draft into a real one, using ONLY the context given -- never inventing facts, deadlines, names, or people that aren't already present.
Rules for the output:
1. Open with "<p>Salam,</p>" -- nothing else, no @-tag at the start.
2. Body as "<ul><li>...</li></ul>" bullets, organized, one clear thought per bullet, covering at minimum: context (what happened and why this is being drafted), the actual deliverable/step, dependencies/constraints (say "No dependencies -- can start immediately" if genuinely none), and a done/success criterion.
3. If the current updateBody ends with a mention-chip line (one or more <a class="mention" ...>@Name</a> tags inside a <p>), copy that line EXACTLY as-is, unchanged, to the end of your output. Do not add, remove, reword, or re-tag anything in it.
4. Never use em dashes (—) or en dashes (–).
5. HTML only, no markdown.
Return ONLY the finished updateBody HTML -- no preamble, no explanation, no code fences.`;
  const user = `itemName: ${payload.itemName || item.title || "(untitled)"}
board: ${item.board || "n/a"}
client group: ${item.group || "n/a"}
source: ${item.sourceLabel || item.source || "n/a"}
note: ${item.note || ""}
current updateBody (too thin -- expand it, don't invent new substance):
${payload.updateBody || ""}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
  });
  const msg = await res.json();
  if (!res.ok || msg.type === "error") throw new Error(`repairUpdateBody: Anthropic error: ${JSON.stringify(msg.error || msg)}`);
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) throw new Error("repairUpdateBody: empty response");
  return text;
}

// Plain-text for a fuzzy-match comparison, not a display preview (that's
// item-chat.js's htmlToPlainText, which keeps block-boundary " / "
// separators) -- a mention anchor's visible @Name text is kept (it's real
// content for similarity purposes), everything else is just tag noise.
function stripHtmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<a[^>]*class="mention"[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// The pre-send dedup audit. item.mondayItemId (checked above, in
// sendQueueItemToMonday) only catches OUR OWN prior send -- it says nothing
// about work Sohib or Naz created by hand on Monday after this card was
// drafted (drafts can sit for days), and the one-time board audit at draft
// time only ever compared item NAMES, never update/comment text, so work
// logged as a comment on an existing item was invisible to it. This re-
// checks live, right before firing, and looks at both dimensions.
//
// Returns null (nothing found, or the audit itself couldn't run -- an audit
// failure is never a reason to block a real send) or
// { id, name, isSubitem, score, matchedOn } naming the single best-scoring
// live match.
//
// Threshold choice mirrors generate.py's own corroboration logic (see
// textSimilarity.js): SIMILARITY_DUP_THRESHOLD (0.6) is the bar for a plain
// name-vs-name comparison, same as generate.py's default "same client,
// compare text" path. COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD (0.45,
// the lower floor generate.py reserves for comparisons with independent
// corroborating evidence beyond text alone) applies whenever the drafted
// content is being matched against a LIVE UPDATE's text rather than a bare
// name -- finding your own drafted substance already echoed in an existing
// comment (on the exact item for update_only, or anywhere in the scoped
// group for create_item/create_subitem) is itself that independent
// evidence, the same role generate.py's source+date+who triple plays.
async function findLikelyDuplicate(item, payload) {
  try {
    const mode = payload.mode || "create_item";
    const draftedBody = stripHtmlToText(payload.updateBody);

    if (mode === "update_only") {
      if (!payload.existingItemId) return null;
      let detail;
      try {
        detail = await mondayItemDetail(payload.existingItemId);
      } catch {
        // Not a duplicate-warning case -- the mode dispatch below still
        // tries the real send and surfaces a normal error if the id is
        // genuinely gone.
        return null;
      }
      if (!draftedBody) return null;
      let best = null;
      for (const u of detail.updates || []) {
        const score = textSimilarity(draftedBody, stripHtmlToText(u.body));
        if (score >= COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
          best = { id: detail.id, name: detail.name, isSubitem: false, score, matchedOn: "an existing update on this item" };
        }
      }
      return best;
    }

    // create_item / create_subitem
    const boardId = payload.boardId || BOARD_LABEL_IDS[item.board];
    if (!boardId) return null;
    const boardLabel = boardLabelForId(boardId);
    const groupId = boardLabel ? (CLIENT_GROUPS[item.group] || {})[boardLabel] : null;
    if (!groupId) return null; // can't scope the audit -- not a reason to block the send

    let candidates;
    try {
      candidates = await mondayGroupItemsWithSubitems(boardId, groupId, { includeUpdates: true });
    } catch (err) {
      console.error(`sendQueueItemToMonday: duplicate audit lookup failed for ${item.id}:`, err);
      return null;
    }

    const draftedName = payload.itemName || "";
    let best = null;
    const consider = (c, isSubitem) => {
      if (draftedName) {
        const score = textSimilarity(draftedName, c.name);
        if (score >= SIMILARITY_DUP_THRESHOLD && (!best || score > best.score)) {
          best = { id: c.id, name: c.name, isSubitem, score, matchedOn: "its name" };
        }
      }
      if (draftedBody) {
        for (const u of c.updates || []) {
          const score = textSimilarity(draftedBody, stripHtmlToText(u.body));
          if (score >= COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
            best = { id: c.id, name: c.name, isSubitem, score, matchedOn: "an existing update" };
          }
        }
      }
    };
    for (const c of candidates) {
      consider(c, false);
      for (const s of c.subitems || []) consider(s, true);
    }
    return best;
  } catch (err) {
    console.error(`sendQueueItemToMonday: duplicate audit failed for ${item.id}:`, err);
    return null;
  }
}

// §22c, never actually implemented until now (found 2026-08-14 auditing
// DRAFTING_RULES against monday-automation.md): a parent item with subitems
// is a workstream container, not a discrete deliverable -- it never
// "completes," individual subitems do -- so it should read Ongoing, not
// Start. buildColumnValues has only ever set Start/Stuck; this is the one
// place a subitem actually gets created for real, so it's the one place
// this can be enforced without guessing later whether some other item
// already has subitems. Skips a parent that's Done (matches §22c) or Stuck
// (§22c's own explicit exception -- a parent Stuck because the whole
// workstream is genuinely blocked shouldn't silently un-stick just because
// one more subitem showed up). Never fatal to the send -- the subitem
// already exists for real by the time this runs.
async function ensureParentOngoing(parentItemId, boardId) {
  const data = await mondayGraphQL(
    `query($itemIds: [ID!]) { items(ids: $itemIds) { id column_values(ids: ["${STATUS_COLUMN}"]) { text } } }`,
    { itemIds: [parentItemId] }
  );
  const current = data?.items?.[0]?.column_values?.[0]?.text;
  if (current === "Done" || current === "Stuck") return;
  await updateMondayColumns(boardId, parentItemId, { [STATUS_COLUMN]: { label: "Ongoing" } });
}

// Shared by send-to-monday.js -- the real network fire behind the send-to-
// Monday button (and its preview confirmation step in addon.js).
async function sendQueueItemToMonday(id, { force = false } = {}) {
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
  // own (already-checked) resolve_item or from anywhere else. A failure here
  // used to be a dead end; now it's one repair attempt (never looped) before
  // giving up with the original error.
  let substanceError = checkUpdateBodySubstance(payload.updateBody);
  if (substanceError) {
    let repairedBody = null;
    try {
      repairedBody = await repairUpdateBody(item);
    } catch (err) {
      console.error(`sendQueueItemToMonday: repairUpdateBody failed for ${id}:`, err);
    }
    if (repairedBody && !checkUpdateBodySubstance(repairedBody)) {
      payload.updateBody = repairedBody;
      substanceError = null;
      // Persisted so the expanded body shows on the card afterward instead
      // of only living in-memory for this one send -- a separate write from
      // the "mark as sent" write below, since that one only fires once the
      // real Monday item/update actually exists.
      try {
        await updateJSON(QUEUE_PATH, (fresh) => {
          const i = fresh.items.findIndex((it) => it.id === id);
          if (i !== -1 && fresh.items[i].payload) {
            fresh.items[i] = {
              ...fresh.items[i],
              payload: { ...fresh.items[i].payload, updateBody: repairedBody },
              updatedAt: new Date().toISOString(),
            };
          }
          return fresh;
        }, `auto-repair thin updateBody for ${id}`, { fallback: { updatedAt: null, items: [] } });
      } catch (err) {
        console.error(`sendQueueItemToMonday: failed to persist repaired updateBody for ${id}:`, err);
      }
    }
  }
  if (substanceError) return { error: substanceError };
  const mentionError = checkMentionsAreReal(payload.updateBody);
  if (mentionError) return { error: mentionError };

  // Warning gate, not a hard block like the mondayItemId guard above --
  // `force` (from the preview modal's "send anyway") skips straight past
  // this for the false-positive case, same as every other check up here
  // still applies either way.
  if (!force) {
    const duplicate = await findLikelyDuplicate(item, payload);
    if (duplicate) {
      const pct = Math.round(duplicate.score * 100);
      return {
        error: `possible duplicate: "${duplicate.name}" (Monday ${duplicate.isSubitem ? "subitem" : "item"} ${duplicate.id}) looks ${pct}% similar, matched on ${duplicate.matchedOn} -- if this is a false positive, send anyway from the preview.`,
        duplicate,
      };
    }
  }

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
        // NOT the parent-board columnValues computed above -- a subitem
        // lives on a separate linked board with its own column ids (see
        // getSubitemsColumnIds). Create bare, then push status/people via a
        // follow-up column update once the subitem's real board is known.
        // Confirmed live 2026-08-04: passing the parent board's column ids
        // here caused a 403 USER_UNAUTHORIZED on create_subitem.
        const created = await mondayGraphQL(
          `mutation($parent: ID!, $name: String!) { create_subitem(parent_item_id: $parent, item_name: $name) { id } }`,
          { parent: payload.parentItemId, name: payload.itemName }
        );
        resultItemId = created.create_subitem.id;

        try {
          const subitemsColumnIds = await getSubitemsColumnIds(boardId);
          const subitemColumnValues = buildSubitemColumnValues(columnValues[PEOPLE_COLUMN].personsAndTeams, blocked, subitemsColumnIds);
          if (Object.keys(subitemColumnValues).length) {
            await updateMondayColumns(subitemsColumnIds.subitemsBoardId, resultItemId, subitemColumnValues);
          }
        } catch (err) {
          // The subitem already exists for real at this point -- a failed
          // status/people push is a separate, non-fatal problem (surfaced in
          // logs, not failed back to the caller), not a reason to treat the
          // whole send as failed (that would risk a retry creating a
          // genuine duplicate subitem).
          console.error(`sendQueueItemToMonday: subitem ${resultItemId} created but status/people push failed:`, err);
        }

        try {
          await ensureParentOngoing(payload.parentItemId, boardId);
        } catch (err) {
          console.error(`sendQueueItemToMonday: failed to set parent ${payload.parentItemId} to Ongoing:`, err);
        }
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
      // parentUpdateId (only ever set on an update_only payload, via
      // buildResolvedFields/the destination picker's reply-to-update step)
      // posts this as a reply on an existing thread instead of a new
      // top-level comment -- Monday's own parent_id argument on the same
      // mutation, nothing update_only-specific about the call itself.
      await mondayGraphQL(
        `mutation($item: ID!, $body: String!, $parentId: ID) { create_update(item_id: $item, body: $body, parent_id: $parentId) { id } }`,
        { item: resultItemId, body: payload.updateBody, parentId: payload.parentUpdateId || null }
      );
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
  mondayGroupItemsWithSubitems,
  mondayItemDetail,
  mondayItemNameAndParent,
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
  getSubitemsColumnIds,
  buildSubitemColumnValues,
  assignedToLine,
  swapUpdateBodyMentions,
  resolvePayloadFlags,
  checkUpdateBodySubstance,
  checkMentionsAreReal,
  findFakeMentionText,
  enforceSentInvariant,
};
