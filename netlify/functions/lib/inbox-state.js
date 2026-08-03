// netlify/functions/lib/inbox-state.js -- JS mirror of inbox_state.py's
// four-state read/reply logic (that file's _thread_state / OUR_MONDAY_USER_IDS
// / STATE_* constants), used by the batch generate.py pipeline to write
// site/inbox.json. This file is the SAME logic for inbox-live.js's live-query
// path. KEEP THESE TWO IN SYNC BY HAND -- there is no shared build step across
// the Python/Node boundary (same "keep in sync by hand" pattern item-chat.js
// already uses for its DRAFTING_RULES vs monday-automation.md). If you change
// the state derivation here, mirror the change in
// /Users/naz/Desktop/flow-standup/inbox_state.py's _thread_state, and
// vice versa.

const OUR_MONDAY_USER_IDS = new Set(["70062990", "69662034"]); // Nacer Amrouch, Sohib Boundaoui

const STATE_READ_NOT_REPLIED = "read_not_replied";
const STATE_UNREAD_NOT_REPLIED = "unread_not_replied";
const STATE_UNREAD_TEAM_REPLIED = "unread_team_replied";
const STATE_REPLIED_AWAITING_TEAM = "replied_awaiting_team";

const STATE_LABELS = {
  [STATE_READ_NOT_REPLIED]: "Read, not replied",
  [STATE_UNREAD_NOT_REPLIED]: "Not read, not replied",
  [STATE_UNREAD_TEAM_REPLIED]: "Not read, team has replied",
  [STATE_REPLIED_AWAITING_TEAM]: "Replied, no response yet",
};

// Mirrors fetch_monday.py's _extract_updates_full: normalizes raw Monday
// updates (as returned by the extended mondayItemDetail query -- creator_id +
// viewers are additive fields added there for this) into
// {update_id, created_at, creator_id, creator_name, viewer_ids}, sorted
// newest-first (Monday's API doesn't guarantee update order).
function normalizeUpdates(rawUpdates) {
  const out = (rawUpdates || []).map((u) => ({
    update_id: u.id != null ? String(u.id) : null,
    created_at: u.created_at || "",
    creator_id: u.creator_id != null ? String(u.creator_id) : null,
    creator_name: (u.creator && u.creator.name) || "Unknown",
    viewer_ids: (u.viewers || []).map((v) => String(v.user_id)).filter(Boolean),
  }));
  out.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return out;
}

// Direct port of inbox_state.py's _thread_state. Returns {state, latest}, or
// null if the item has no updates at all.
function threadState(updatesFull) {
  if (!updatesFull.length) return null;
  const latest = updatesFull[0];
  if (OUR_MONDAY_USER_IDS.has(latest.creator_id)) {
    return { state: STATE_REPLIED_AWAITING_TEAM, latest };
  }
  const readByUs = latest.viewer_ids.some((uid) => OUR_MONDAY_USER_IDS.has(uid));
  if (readByUs) {
    return { state: STATE_READ_NOT_REPLIED, latest };
  }
  const weRepliedBefore = updatesFull.slice(1).some((u) => OUR_MONDAY_USER_IDS.has(u.creator_id));
  if (weRepliedBefore) {
    return { state: STATE_UNREAD_TEAM_REPLIED, latest };
  }
  return { state: STATE_UNREAD_NOT_REPLIED, latest };
}

function mondayUrl(boardId, itemId) {
  return boardId && itemId ? `https://flowcompany.monday.com/boards/${boardId}/pulses/${itemId}` : null;
}

function buildEntry(item, boardLabel, boardId, parentItemId) {
  const result = threadState(normalizeUpdates(item.updates));
  if (!result) return null;
  const { state, latest } = result;
  return {
    monday_item_id: String(item.id),
    item_name: item.name,
    board: boardLabel,
    parent_item_id: parentItemId,
    url: mondayUrl(boardId, item.id),
    state,
    state_label: STATE_LABELS[state],
    latest_update: {
      update_id: latest.update_id,
      created_at: latest.created_at,
      creator_name: latest.creator_name,
      is_ours: OUR_MONDAY_USER_IDS.has(latest.creator_id),
    },
  };
}

// overview: mondayClientOverview(client)'s own return shape,
// [{board, items, error?, note?}]. Each item already carries its own
// subitems, each with its own board{id} (CRM subitems live on a linked
// board -- never assume it matches the parent's board id, ask Monday
// directly, same as fetch_monday.py does).
function buildLiveInboxEntries(overview, boardLabelIds) {
  const entries = [];
  for (const { board: boardLabel, items } of overview || []) {
    const boardId = boardLabelIds[boardLabel];
    for (const item of items || []) {
      if (item.error) continue; // mondayItemDetail failed for this one item -- skip it, don't fail the whole client
      const entry = buildEntry(item, boardLabel, boardId, null);
      if (entry) entries.push(entry);
      for (const sub of item.subitems || []) {
        const subBoardId = (sub.board && sub.board.id) || boardId;
        const subEntry = buildEntry(sub, boardLabel, subBoardId, String(item.id));
        if (subEntry) entries.push(subEntry);
      }
    }
  }
  return entries;
}

module.exports = { buildLiveInboxEntries, STATE_LABELS, OUR_MONDAY_USER_IDS };
