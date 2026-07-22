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
  "Vous Physique": { Ads: "group_mm22cd1z", "Web+SEO": "group_mm231372", CRM: "group_mm5gyktb", Video: "group_mm2pyqs3" }, // CRM group created 2026-07-22
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

// Shared by send-to-monday.js -- the real network fire behind the send-to-
// Monday button (and its preview confirmation step in addon.js).
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
  const mentionError = checkMentionsAreReal(payload.updateBody);
  if (mentionError) return { error: mentionError };

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
  assignedToLine,
  swapUpdateBodyMentions,
  resolvePayloadFlags,
  checkUpdateBodySubstance,
  checkMentionsAreReal,
  findFakeMentionText,
  enforceSentInvariant,
};
