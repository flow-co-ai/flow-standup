// This reuses whatever passcode mechanism the page already has for the
// checkmark feature — swap FO_PASSCODE() for however that value is already
// available in your existing app.js instead of prompting a second time.
function FO_PASSCODE() {
  return localStorage.getItem("flowops-passcode") || "";
}
function foHeaders() {
  return { "content-type": "application/json", "X-Ops-Key": FO_PASSCODE() };
}
function foEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const ACTIVE_STATUSES = ["ready", "confirm"];
// "sent" gets its own section (Mondayed) -- it's a real, external side effect,
// not just a local bookkeeping state like done/ignored, so it's worth keeping
// visually distinct even though both sections are handled-and-collapsed.
const HANDLED_STATUSES = ["done", "ignored"];
const MONDAYED_STATUSES = ["sent"];
// Neither of these is an actionable draft: "exists" means the Monday item was
// already there so nothing to send, "blocked" means the drafter couldn't
// proceed. They still deserve to be visible so the vocabulary is auditable.
const NOT_DRAFTED_STATUSES = ["blocked", "exists"];
const foSectionExpanded = {
  handled:    false,
  mondayed:   false,
  dismissed:  false,
  notDrafted: false,
  other:      false,
};

// Last-known full queue, kept client-side so button clicks can re-render
// immediately from a local optimistic guess instead of waiting 5-10s on a
// round trip (Monday API calls, GitHub commits) before anything visibly
// changes. Every mutation below patches this in place, re-renders straight
// away, then reconciles with whatever the server actually persisted.
let foItems = [];
let foSelectedId = null;

// Board/group dropdown options -- same source of truth the pipeline itself
// routes with (lib/monday.js's BOARD_LABEL_IDS/CLIENT_GROUPS), returned
// alongside the queue itself so there's no separate fetch/staleness to
// manage. Empty until the first successful foLoadQueue().
let foRouting = { boards: [], boardIds: {}, groupsByClient: {} };

// Pickable Monday targets for the "Subitem of.../Update on..." destination
// picker, keyed by "boardId::groupId" -- fetched lazily (only once a mode
// that needs them is active) and cached client-side so flipping the Send-as
// selector back and forth doesn't refetch. foTargetsCache holds the settled
// result ({targets:[...]} or {error}); foTargetsInFlight holds the in-flight
// promise for a combo that's currently loading, so concurrent renders don't
// fire duplicate requests. A failed fetch is cached too, so a broken combo
// doesn't get hammered on every re-render -- foRetryTargets is the explicit
// way out of that (see foEnsureTargetsFetched).
const foTargetsCache = new Map();
const foTargetsInFlight = new Map();

function foTargetsKey(boardId, groupId) {
  return `${boardId}::${groupId}`;
}

// Same resolution foPatchBoardGroup needs for the routing write -- pulled out
// once so the picker's fetch-scope and the actual routing write can never
// drift into using two different lookups for the same board+group pair.
function foResolveBoardGroupIds(boardName, groupName) {
  const boardId = (foRouting.boardIds || {})[boardName];
  const groupId = ((foRouting.groupsByClient || {})[groupName] || {})[boardName];
  if (!boardId || !groupId) return null;
  return { boardId, groupId };
}

function foGetTargetsSync(boardId, groupId) {
  return foTargetsCache.get(foTargetsKey(boardId, groupId));
}

// A failed fetch is cached too (as {error}), same as a success -- otherwise
// every re-render (foEnsureTargetsFetched runs again on each one, since
// there'd be nothing in either map to short-circuit it) would refire the
// request against Monday immediately, forever, for a combo that keeps
// failing. foRetryTargets is the deliberate way out of that: clears this one
// combo's cache entry and re-fetches, wired to a "retry" link in the error
// state (see foBuildMondayDetails).
function foEnsureTargetsFetched(boardId, groupId) {
  const key = foTargetsKey(boardId, groupId);
  if (foTargetsCache.has(key) || foTargetsInFlight.has(key)) return;
  const promise = fetch(`/.netlify/functions/queue?action=targets&boardId=${encodeURIComponent(boardId)}&groupId=${encodeURIComponent(groupId)}`, { headers: foHeaders() })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { targets: data.targets || [] };
    })
    .catch((err) => ({ error: err && err.message ? err.message : String(err) }))
    .then((result) => {
      foTargetsInFlight.delete(key);
      foTargetsCache.set(key, result);
      // Re-render now that this combo has resolved -- a no-op if the user
      // has since selected a different card or changed mode/board/group.
      foRenderFromItems(foItems);
      return result;
    });
  foTargetsInFlight.set(key, promise);
}

function foRetryTargets(boardId, groupId) {
  foTargetsCache.delete(foTargetsKey(boardId, groupId));
  foEnsureTargetsFetched(boardId, groupId);
  foRenderFromItems(foItems);
}

// Same lazy-fetch + client-cache pattern as the targets cache above, keyed
// by itemId instead of boardId+groupId -- powers "Update on..."'s optional
// second step (reply to a specific existing update instead of a new
// top-level comment).
const foUpdatesCache = new Map();
const foUpdatesInFlight = new Map();

function foGetUpdatesSync(itemId) {
  return foUpdatesCache.get(itemId);
}

function foEnsureUpdatesFetched(itemId) {
  if (foUpdatesCache.has(itemId) || foUpdatesInFlight.has(itemId)) return;
  const promise = fetch(`/.netlify/functions/queue?action=item-updates&itemId=${encodeURIComponent(itemId)}`, { headers: foHeaders() })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { updates: data.updates || [] };
    })
    .catch((err) => ({ error: err && err.message ? err.message : String(err) }))
    .then((result) => {
      foUpdatesInFlight.delete(itemId);
      foUpdatesCache.set(itemId, result);
      foRenderFromItems(foItems);
      return result;
    });
  foUpdatesInFlight.set(itemId, promise);
}

function foRetryUpdates(itemId) {
  foUpdatesCache.delete(itemId);
  foEnsureUpdatesFetched(itemId);
  foRenderFromItems(foItems);
}

// Author + first line + date, so otherwise-similar updates on a busy item
// are actually distinguishable in a plain <option> (no HTML allowed inside
// one, so this has to be one flat string).
function foUpdatePreview(u) {
  const author = (u.creator && u.creator.name) || "someone";
  const text = String(u.body || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  const firstLine = text.length > 50 ? text.slice(0, 50) + "…" : text;
  const date = u.created_at ? new Date(u.created_at).toLocaleDateString() : "";
  return `${author}: ${firstLine || "(empty)"}${date ? " -- " + date : ""}`;
}

// ids currently mid-foPatch(). Rapid clicks on the same card's buttons (e.g.
// mashing a priority arrow) used to fire several overlapping POSTs -- each
// read the same GitHub sha, so every one after the first landed as a 409 and
// got silently rolled back. This blocks the buttons for that card the moment
// the first click fires so there's only ever one write in flight per item.
const foPending = new Set();

function foRenderFromItems(items) {
  // A dismissed prospect keeps whatever status it already had (still
  // 'confirm', typically) -- dismissed is checked FIRST so it never also
  // counts as active just because its status hasn't changed.
  const active     = items.filter(it => !it.mondayItemId && !it.dismissed && ACTIVE_STATUSES.includes(it.status));
  const handled    = items.filter(it => !it.mondayItemId && !it.dismissed && HANDLED_STATUSES.includes(it.status));
  const mondayed   = items.filter(it => it.mondayItemId || MONDAYED_STATUSES.includes(it.status));
  const dismissed  = items.filter(it => it.dismissed && !it.mondayItemId);
  const notDrafted = items.filter(it => !it.mondayItemId && !it.dismissed && NOT_DRAFTED_STATUSES.includes(it.status));

  // Catch-all so no item is ever invisible again. Anything the buckets above
  // didn't claim lands here, with its raw status shown, so a new/unknown
  // status vocabulary can't silently swallow the queue.
  const claimed = new Set(
    [...active, ...handled, ...mondayed, ...dismissed, ...notDrafted].map(it => it.id)
  );
  const other = items.filter(it => !claimed.has(it.id));

  if (foSelectedId && !items.find(it => it.id === foSelectedId)) foSelectedId = null;

  const selectedItem = items.find(it => it.id === foSelectedId) || null;
  const detailHtml = selectedItem ? foRenderDetailPane(selectedItem) : foDetailEmpty();

  document.getElementById("fo-queue-cards").innerHTML = `
    <div class="fo-shell${foSelectedId ? ' fo-detail-visible' : ''}">
      <div class="fo-list">${foRenderListPane(active, handled, mondayed, dismissed, notDrafted, other)}</div>
      <div class="fo-detail">${detailHtml}</div>
    </div>`;
}

function foSelectItem(id) {
  foSelectedId = id || null;
  foRenderFromItems(foItems);
}

// ── passcode gate ─────────────────────────────────────────────────────────────

function foRenderPasscodeGate() {
  return `<div class="fo-passcode-gate">
    <div class="fo-passcode-card">
      <p class="fo-passcode-msg">the draft queue writes to Monday.<br>enter the ops passcode to continue.</p>
      <div class="fo-passcode-row">
        <input type="password" class="fo-passcode-input" id="fo-gate-input" placeholder="passcode"
          onkeydown="if(event.key==='Enter')foGateUnlock()">
        <button class="fo-primary" onclick="foGateUnlock()">unlock</button>
      </div>
      <p class="fo-passcode-error" id="fo-gate-error" hidden></p>
    </div>
  </div>`;
}

function foGateUnlock() {
  const input = document.getElementById("fo-gate-input");
  const val = input?.value.trim();
  if (!val) return;
  localStorage.setItem("flowops-passcode", val);
  foLoadQueue();
}

// ── skeleton + error ──────────────────────────────────────────────────────────

function foRenderSkeleton() {
  const row = '<div class="fo-skel-row"><div class="fo-skel-chip"></div><div class="fo-skel-title"></div><div class="fo-skel-badge"></div></div>';
  return `<div class="fo-shell">
    <div class="fo-list">
      <div class="fo-list-group"><div class="fo-skel-header"></div>${row.repeat(3)}</div>
      <div class="fo-list-group"><div class="fo-skel-header"></div>${row.repeat(2)}</div>
    </div>
    <div class="fo-detail fo-detail-skeleton">
      <div class="fo-skel-det-title"></div>
      <div class="fo-skel-det-body"></div>
    </div>
  </div>`;
}

// ── list pane rendering ───────────────────────────────────────────────────────

function foRenderListPane(active, handled, mondayed, dismissed, notDrafted, other) {
  notDrafted = notDrafted || [];
  other      = other      || [];
  dismissed  = dismissed  || [];

  const activeReal      = active.filter(it => !!it.group);
  const activeProspects = active.filter(it => !it.group);

  let html = '';

  if (activeReal.length) {
    for (const [client, items] of foGroupByClient(activeReal)) {
      const hasHot = items.some(it => foPriority(it) <= 2);
      html += `<div class="fo-list-group">
        <div class="fo-list-group-header">
          <span class="fo-list-client">${foEscape(client)}</span>
          <span class="fo-list-count">${items.length}</span>
          ${hasHot ? '<span class="fo-hot-pill">HOT</span>' : ''}
        </div>
        ${items.map(it => foListRow(it, 'active')).join('')}
      </div>`;
    }
  }

  if (activeProspects.length) {
    html += `<div class="fo-list-group fo-list-prospects">
      <div class="fo-list-group-header"><span class="fo-list-client">Potential clients</span></div>
      ${foGroupByProspect(activeProspects).map(([name, items]) =>
        `<div class="fo-list-prospect-group">
          <div class="fo-list-prospect-label">${foEscape(name)} <span class="fo-list-count">${items.length}</span></div>
          ${items.map(it => foListRow(it, 'active')).join('')}
        </div>`
      ).join('')}
    </div>`;
  }

  // Empty-state only fires when the queue is genuinely empty. Previously it
  // fired when just the active bucket was empty, which was misleading once
  // "blocked"/"exists"/unknown-status items existed but silently rendered
  // nowhere.
  const totalCount = active.length + handled.length + mondayed.length
    + dismissed.length + notDrafted.length + other.length;
  if (!activeReal.length && !activeProspects.length && totalCount === 0) {
    html += `<div class="fo-list-empty">nothing waiting on you.<br>
      <span class="fo-list-empty-sub">${handled.length} handled · ${mondayed.length} mondayed</span>
    </div>`;
  }

  html += foRenderListSection('handled',    'handled',          handled);
  html += foRenderListSection('mondayed',   'mondayed',         mondayed);
  html += foRenderListSection('notDrafted', 'NOT DRAFTED',      notDrafted);
  html += foRenderListSection('dismissed',  'hidden prospects', dismissed);
  html += foRenderListSection('other',      'OTHER',            other);

  return html;
}

function foRenderListSection(key, label, items) {
  const expanded = foSectionExpanded[key];
  return `<div class="fo-list-section">
    <button class="fo-list-section-toggle" onclick="foToggleSection('${key}')">
      ${expanded ? '▾' : '▸'} ${label} (${items.length})
    </button>
    <div class="fo-list-section-body" ${expanded ? '' : 'hidden'}>
      ${items.map(it => foListRow(it, key)).join('')}
    </div>
  </div>`;
}

function foListRow(item, section) {
  const isSelected = item.id === foSelectedId;
  const p = foPriority(item);
  const nameRow = item.payload ? foMondayNameRow(item) : null;
  const title = nameRow ? nameRow.value : (item.sourceLabel || '(untitled)');
  const statusKey = item.status || 'confirm';

  const cls = [
    'fo-list-row',
    isSelected ? 'selected' : '',
    section === 'handled' ? 'fo-row-handled' : '',
    item.isSub ? 'fo-row-sub' : '',
  ].filter(Boolean).join(' ');

  const boardLabel = item.board
    ? `<span class="fo-row-board">${foEscape(item.board)}</span>` : '';
  const unreadDot = item.unread
    ? '<span class="fo-unread-dot" aria-label="unread"></span>' : '';
  const subMarker = item.isSub
    ? '<span class="fo-sub-marker">↳</span>' : '';

  return `<div class="${cls}" data-id="${foEscape(item.id)}" onclick="foSelectItem('${foEscape(item.id)}')">
    <div class="fo-row-left">
      ${subMarker}
      <span class="fo-priority fo-priority-${p}">P${p}</span>
      <span class="fo-row-title">${foEscape(title)}</span>
    </div>
    <div class="fo-row-right">
      ${boardLabel}
      <span class="fo-row-status fo-b-${foEscape(statusKey)}">${foEscape(statusKey)}</span>
      ${unreadDot}
    </div>
  </div>`;
}

// ── detail pane rendering ─────────────────────────────────────────────────────

function foDetailEmpty() {
  return `<div class="fo-detail-empty">no draft selected<br>
    <span>pick an item from the queue to review it</span>
  </div>`;
}

function foRenderDetailPane(item) {
  const pending   = foPending.has(item.id);
  const p         = foPriority(item);
  const statusKey = item.status || 'confirm';
  const nameRow   = item.payload ? foMondayNameRow(item) : null;
  const title     = nameRow ? nameRow.value : (item.sourceLabel || '(untitled)');
  const section   = item.mondayItemId ? 'mondayed'
    : item.dismissed ? 'dismissed'
    : HANDLED_STATUSES.includes(item.status) ? 'handled' : 'active';

  const origin = item.sourceLabel
    ? `<div class="fo-det-origin">${foEscape(item.sourceLabel)}</div>` : '';

  const sendControl = item._sending
    ? `<button class="fo-primary" disabled>sending to monday…</button>`
    : item.mondayItemId
    ? `<span class="fo-muted-label">already sent (item ${foEscape(item.mondayItemId)})</span>`
    : item.payload
    ? `<button class="fo-primary" onmousedown="event.preventDefault()" onclick="foOpenSendPreview('${item.id}')">send to monday</button>`
    : '';

  let actionsHtml;
  if (section === 'mondayed') {
    actionsHtml = `<span class="fo-muted-label">sent to Monday${item.mondayItemId ? ` (item ${foEscape(item.mondayItemId)})` : ''}</span>`;
  } else if (section === 'dismissed') {
    // Parked, not rejected -- a prospect can still convert later, so this is
    // a one-click restore back to the normal Potential Clients list, not an
    // "undo a mistake" action the way Handled's undo is.
    actionsHtml = `<span class="fo-muted-label">hidden from Potential Clients</span>
      <button onclick="foPatch('${item.id}', {dismissed: false, dismissedAt: null})" ${pending ? 'disabled' : ''}>unhide</button>`;
  } else if (section === 'handled') {
    actionsHtml = `${sendControl}
      <button onclick="foPatch('${item.id}', {status:'confirm'})" ${pending ? 'disabled' : ''}>undo</button>`;
  } else {
    // Hiding is only offered for a prospect card (potentialClient set) --
    // ignore/done both carry a real judgment ("not a task" / "handled")
    // that doesn't fit "this business isn't worth a card every week, park
    // it" the way a plain dismiss does, and ignore now requires a reason
    // per the same-shape prompt real drafts use.
    const hideControl = item.potentialClient
      ? `<button onclick="foPatch('${item.id}', {dismissed: true, dismissedAt: new Date().toISOString()})" ${pending ? 'disabled' : ''}>hide prospect</button>`
      : '';
    actionsHtml = `${sendControl}
      <button onclick="foPatch('${item.id}', {status:'done'})" ${pending ? 'disabled' : ''}>mark done</button>
      <button onclick="foOpenIgnorePrompt('${item.id}')" ${pending ? 'disabled' : ''}>ignore</button>
      ${hideControl}`;
  }

  const priorityBlock = section === 'active' ? `
    <div class="fo-det-priority">
      <button class="fo-priority-btn" title="Raise priority" onclick="foBumpPriority('${item.id}',-1)" ${p<=1||pending?'disabled':''}>&#9650;</button>
      <span class="fo-priority fo-priority-${p}">P${p}</span>
      <button class="fo-priority-btn" title="Lower priority" onclick="foBumpPriority('${item.id}',1)" ${p>=5||pending?'disabled':''}>&#9660;</button>
    </div>` : '';

  const ageDays = foItemAgeDays(item);
  const ageBadge = ageDays !== null
    ? `<span class="fo-muted-label" title="Drafted ${foEscape(item.createdAt)}">${ageDays} days old</span>` : '';

  const chatMsgCount = (foItemChat[item.id] || []).length;
  const chatLog = foRenderChatMessages(item.id);

  return `
    <button class="fo-det-back" onclick="foSelectItem(null)">← back</button>
    <div class="fo-det-header">
      ${origin}
      <div class="fo-det-header-row">
        <span class="fo-badge fo-b-${foEscape(statusKey)}">${foEscape(statusKey)}</span>
        ${ageBadge}
        ${priorityBlock}
      </div>
      <div class="fo-det-title">${foEscape(title)}</div>
    </div>
    ${foBuildMondayDetails(item)}
    <div class="fo-actions fo-det-actions">${actionsHtml}</div>
    <details class="fo-det-chat">
      <summary class="fo-det-chat-toggle">Chat${chatMsgCount ? ` · ${chatMsgCount} msg${chatMsgCount!==1?'s':''}` : ''}</summary>
      <div class="fo-itemchat">
        <div class="fo-itemchat-log" id="fo-chat-log-${item.id}">${chatLog}</div>
        <form class="fo-itemchat-form" onsubmit="return foSendItemChat(event,'${item.id}')">
          <input type="text" placeholder="Ask, edit, reassign, or resolve…">
          <button type="submit">Send</button>
        </form>
      </div>
    </details>`;
}

async function foLoadQueue() {
  const container = document.getElementById("fo-queue-cards");
  if (!localStorage.getItem("flowops-passcode")) {
    container.innerHTML = foRenderPasscodeGate();
    return;
  }
  container.innerHTML = foRenderSkeleton();
  try {
    const res = await fetch("/.netlify/functions/queue", { headers: foHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    foItems = data.items || [];
    if (data.routing) foRouting = data.routing;
    // Seed each card's chat log from what item-chat.js persisted server-side
    // -- but ONLY the first time this session sees that id. An in-progress
    // client-side thread (already typing, or already got a reply this
    // session) must never be clobbered by a periodic re-load's server copy.
    for (const it of foItems) {
      if (foItemChat[it.id] === undefined && Array.isArray(it.chatHistory) && it.chatHistory.length) {
        foItemChat[it.id] = it.chatHistory;
      }
    }
    foRenderFromItems(foItems);
  } catch (e) {
    container.innerHTML = `<div class="fo-error-state">
      <div class="fo-error-msg">couldn't reach the draft queue${e?.message ? ": " + foEscape(e.message) : ""}</div>
      <button class="fo-retry-btn" onclick="foLoadQueue()">retry</button>
    </div>`;
  }
}

// Items missing a priority (older data, predating the field) sort as if they
// were a 3 -- normal, not urgent, not last-resort.
function foPriority(item) {
  const p = Number(item.priority);
  return Number.isFinite(p) && p >= 1 && p <= 5 ? p : 3;
}

// null if createdAt is missing/unparseable (queue.js backfills it lazily on
// GET, so a card can briefly lack one right after this repo first sees it)
// or the item just isn't old enough yet to be worth flagging.
const FO_STALE_DAYS = 3;
function foItemAgeDays(item) {
  const created = item.createdAt ? new Date(item.createdAt).getTime() : NaN;
  if (!Number.isFinite(created)) return null;
  const days = Math.floor((Date.now() - created) / 86400000);
  return days > FO_STALE_DAYS ? days : null;
}

function foGroupByClient(items) {
  const groups = new Map();
  for (const item of items) {
    // Guaranteed truthy: foRenderQueue only ever hands this function items
    // that have a real group -- anything without one goes to
    // foGroupByProspect instead. There is no "n/a" fallback here on purpose.
    const key = item.group;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => foPriority(a) - foPriority(b));
  }
  // Groups holding a genuinely urgent (priority 1-2) item surface first, so a
  // busy-but-routine client group never buries a smaller group with something
  // time-sensitive in it. Ties fall back to the prior "busiest client" order.
  return [...groups.entries()].sort((a, b) => {
    const urgentA = a[1].some(it => foPriority(it) <= 2) ? 0 : 1;
    const urgentB = b[1].some(it => foPriority(it) <= 2) ? 0 : 1;
    return urgentA - urgentB || b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });
}

// Cards without a real, resolvable Monday group -- whether explicitly
// flagged potentialClient by the automation, or simply missing a group for
// any other reason -- get grouped by that inferred prospect name here, same
// sort as foGroupByClient. Falls back to a named bucket, never "n/a"/
// "Unknown", for the (ideally rare) case where potentialClient itself
// wasn't set either.
function foGroupByProspect(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.potentialClient || "Unmapped client/workstream";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => foPriority(a) - foPriority(b));
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}



function foToggleSection(key) {
  // Purely local UI state -- no need to round-trip the network just to
  // expand/collapse a section that's already fully loaded client-side.
  foSectionExpanded[key] = !foSectionExpanded[key];
  foRenderFromItems(foItems);
}

const NULL_REASON_LABELS = {
  "multi-item": "needs /monday-task (multi-item)",
  "content-conflict": "needs your input before this can be drafted",
  "unmapped-client": "unrecognized client -- confirm before this gets drafted",
  "parse-error": "drafted payload didn't parse cleanly -- check the note for what's missing before drafting this by hand",
};

// Every field here already exists in the pipeline's own payload schema
// (fireflies-monday-watch SKILL.md step A4h: {mode, boardId+groupId |
// parentItemId | existingItemId, itemName, columnValues, updateBody}) --
// this only surfaces Monday's own language directly on the card instead of
// the paraphrased title/note, it doesn't generate anything new. board/group
// are already human-readable strings at the top level of the item (not raw
// Monday ids), so no id-to-label lookup is needed either.
// parentItemName/parentItemId are backfilled server-side (queue.js's
// resolveMissingMondayNames) whenever a payload only carries a numeric
// parentItemId -- resolved live from Monday once, then cached, so this
// never has to fall back to a bare id except in the brief window before
// that resolution has run.
function foMondayNameRow(item) {
  const p = item.payload;
  const parentLabel = p.parentItemName || (p.parentItemId ? `#${p.parentItemId}` : null);
  if (p.mode === "create_subitem") {
    return { label: parentLabel ? `Subitem of ${parentLabel}` : "Subitem", value: p.itemName || "(untitled)" };
  }
  if (p.mode === "create_item") {
    return { label: item.group ? `New item in ${item.group}` : "New item", value: p.itemName || "(untitled)" };
  }
  // update_only: nothing new is named -- itemName here (when present) just
  // echoes what the EXISTING item is called, it's not a rename.
  const existingLabel = p.itemName || `#${p.existingItemId || "?"}`;
  return { label: `Update on ${existingLabel}`, value: existingLabel };
}

// Always includes the item's CURRENT value even if it's not in the known
// list (an unrecognized-but-real client, or a board name that drifted) --
// editing must never silently discard a value it doesn't recognize.
function foSelectOptions(known, current) {
  const opts = known.includes(current) || !current ? known : [current, ...known];
  return opts.map((v) => `<option value="${foEscape(v)}" ${v === current ? "selected" : ""}>${foEscape(v)}</option>`).join("");
}

function foBuildMondayDetails(item) {
  // Prospect cards (potentialClient set) were never going to route to
  // Monday at all -- a distinct state from a genuinely blocked/unresolved
  // card, so it gets its own label rather than falling through to a
  // misleading "multi-item" default (the bug this replaces).
  if (item.potentialClient) {
    return `<div class="fo-monday-details fo-monday-blocked">
      <span class="fo-monday-blocked-label">Potential client -- not routed to Monday</span>
    </div>`;
  }
  // Blocked/unresolved cards (nullReason set) don't have a resolved board/
  // group/update yet by definition -- show that state clearly instead of
  // empty or broken Monday fields. Nothing here is editable -- there's no
  // payload structure yet for a board/group/update edit to write into.
  if (!item.payload) {
    const reason = NULL_REASON_LABELS[item.nullReason] || NULL_REASON_LABELS["multi-item"];
    // note carries the specific detail for some nullReasons (e.g. parse-error
    // names exactly which field(s) failed and which source file) -- nowhere
    // else on a null-payload card shows it, so it'd otherwise be invisible.
    const noteLine = item.note ? `<p class="fo-preview-note">${foEscape(item.note)}</p>` : "";
    return `<div class="fo-monday-details fo-monday-blocked">
      <span class="fo-monday-blocked-label">${foEscape(reason)}</span>
      ${noteLine}
    </div>`;
  }

  const p = item.payload;
  const pending = foPending.has(item.id);
  const nameRow = foMondayNameRow(item);

  const sendAsSelect = `<select class="fo-monday-select" id="fo-sendas-${item.id}" onchange="foSendAsChanged('${item.id}')" ${pending ? "disabled" : ""}>
      <option value="create_item" ${p.mode === "create_item" ? "selected" : ""}>New item</option>
      <option value="create_subitem" ${p.mode === "create_subitem" ? "selected" : ""}>Subitem of...</option>
      <option value="update_only" ${p.mode === "update_only" ? "selected" : ""}>Update on...</option>
    </select>`;

  const boardSelect = `<select class="fo-monday-select" id="fo-board-${item.id}" onchange="foBoardGroupChanged('${item.id}')" ${pending ? "disabled" : ""}>
      ${foSelectOptions(foRouting.boards || [], item.board)}
    </select>`;
  const groupSelect = `<select class="fo-monday-select" id="fo-group-${item.id}" onchange="foBoardGroupChanged('${item.id}')" ${pending ? "disabled" : ""}>
      ${foSelectOptions(Object.keys(foRouting.groupsByClient || {}), item.group)}
    </select>`;

  const targetRow = foBuildTargetRow(item, p, pending);
  const replyToRow = foBuildReplyToRow(item, p, pending);

  // Directly editable, same click-into-place pattern as the rest of the
  // dashboard's manual controls -- saves on blur via foPatch(), same write
  // path as everything else. Empty (not placeholder TEXT) when there's no
  // draft yet, so an untouched blur never saves the placeholder itself as
  // if it were real content -- see .fo-update-body-missing:empty::before.
  const updateBodyBlock = `<div class="fo-update-body${p.updateBody ? "" : " fo-update-body-missing"}" id="fo-updatebody-${item.id}"
      contenteditable="true" spellcheck="false"
      data-original="${foEscape(p.updateBody || "")}"
      onkeydown="foUpdateBodyKeydown(event)"
      onblur="foSaveUpdateBodyEdit(this, '${item.id}')">${p.updateBody || ""}</div>`;

  // Inserts real §7 mention markup at the cursor -- the alternative to
  // typing "@Name", which Monday would just post as literal characters (see
  // foFindFakeMentions/checkMentionsAreReal, which blocks sending if that
  // happens anyway). onmousedown preventDefault on the button AND every
  // option keeps the update-body field's selection alive across the click,
  // so a mention lands wherever the cursor actually was.
  const people = foRouting.people || [];
  const mentionPicker = people.length ? `<span class="fo-mention-wrap">
      <button type="button" class="fo-mention-btn" title="Insert a mention" aria-label="Insert a mention"
        onmousedown="event.preventDefault()" onclick="foToggleMentionPicker('${item.id}')">@</button>
      <div class="fo-mention-picker" id="fo-mentionpicker-${item.id}" hidden>
        ${people.map((person) => `<button type="button" onmousedown="event.preventDefault()" onclick="foInsertMention('${item.id}', ${person.id})">${foEscape(person.name)}</button>`).join("")}
      </div>
    </span>` : "";

  return `<div class="fo-monday-details">
      <div class="fo-monday-row">
        <span class="fo-monday-key">${foEscape(nameRow.label)}</span>
        <span class="fo-monday-val">${foEscape(nameRow.value)}</span>
      </div>
      <div class="fo-monday-row">
        <span class="fo-monday-key">Send as</span>${sendAsSelect}
      </div>
      <div class="fo-monday-row">
        <span class="fo-monday-key">Board</span>${boardSelect}
        <span class="fo-monday-key">Group</span>${groupSelect}
      </div>
      ${targetRow}
      ${replyToRow}
      <div class="fo-monday-row">
        <span class="fo-monday-key">Update text</span>${mentionPicker}
      </div>
      ${updateBodyBlock}
    </div>`;
}

// The "Subitem of..."/"Update on..." target dropdown -- populated from the
// board+group currently selected above (not necessarily payload.boardId/
// groupId, which for update_only may not even exist), fetched lazily via
// foEnsureTargetsFetched/foTargetsCache. create_item needs none of this.
// For "Update on...", both top-level items AND their subitems are offered
// (indented) -- Monday treats a subitem as a real item, so posting an
// update to one works exactly the same way as to a top-level item. For
// "Subitem of...", only top-level items are offered as parents -- Monday
// doesn't support subitems of subitems (see item-chat.js's DRAFTING_RULES),
// so a subitem is never a valid parent choice here either.
function foBuildTargetRow(item, p, pending) {
  if (p.mode === "create_item") return "";

  const isSubitemMode = p.mode === "create_subitem";
  const label = isSubitemMode ? "Parent item" : "Existing item";
  const ids = foResolveBoardGroupIds(item.board, item.group);
  if (!ids) {
    return `<div class="fo-monday-row">
        <span class="fo-monday-key">${label}</span>
        <span class="fo-muted-label">pick a board/group above first</span>
      </div>`;
  }

  const cached = foGetTargetsSync(ids.boardId, ids.groupId);
  if (!cached) {
    foEnsureTargetsFetched(ids.boardId, ids.groupId); // fires once; re-renders on completion
    return `<div class="fo-monday-row">
        <span class="fo-monday-key">${label}</span>
        <select class="fo-monday-select" disabled><option>Loading...</option></select>
      </div>`;
  }
  if (cached.error) {
    return `<div class="fo-monday-row">
        <span class="fo-monday-key">${label}</span>
        <span class="fo-error-msg">couldn't load items: ${foEscape(cached.error)}
          <button type="button" onclick="foRetryTargets('${ids.boardId}','${ids.groupId}')">retry</button>
        </span>
      </div>`;
  }

  const selectedId = isSubitemMode ? p.parentItemId : p.existingItemId;
  let options = `<option value="">-- choose --</option>`;
  for (const t of cached.targets) {
    options += `<option value="${foEscape(t.id)}" ${String(selectedId) === String(t.id) ? "selected" : ""}>${foEscape(t.name)}</option>`;
    if (!isSubitemMode) {
      for (const s of t.subitems || []) {
        options += `<option value="${foEscape(s.id)}" ${String(selectedId) === String(s.id) ? "selected" : ""}>&nbsp;&nbsp;&nbsp;&nbsp;↳ ${foEscape(s.name)}</option>`;
      }
    }
  }
  return `<div class="fo-monday-row">
      <span class="fo-monday-key">${label}</span>
      <select class="fo-monday-select" id="fo-target-${item.id}" onchange="foTargetChanged('${item.id}')" ${pending ? "disabled" : ""}>
        ${options}
      </select>
    </div>`;
}

// Optional second step for "Update on...", once a target is actually
// chosen: reply to one of that item's existing updates instead of posting
// a new top-level comment. Fetched lazily via foEnsureUpdatesFetched/
// foUpdatesCache, same pattern as the target dropdown above. Blank stays a
// new top-level comment (parentUpdateId absent) -- this is genuinely
// optional, not a second required pick.
function foBuildReplyToRow(item, p, pending) {
  if (p.mode !== "update_only" || !p.existingItemId) return "";

  const cached = foGetUpdatesSync(p.existingItemId);
  if (!cached) {
    foEnsureUpdatesFetched(p.existingItemId); // fires once; re-renders on completion
    return `<div class="fo-monday-row">
        <span class="fo-monday-key">Reply to</span>
        <select class="fo-monday-select" disabled><option>Loading...</option></select>
      </div>`;
  }
  if (cached.error) {
    return `<div class="fo-monday-row">
        <span class="fo-monday-key">Reply to</span>
        <span class="fo-error-msg">couldn't load updates: ${foEscape(cached.error)}
          <button type="button" onclick="foRetryUpdates('${p.existingItemId}')">retry</button>
        </span>
      </div>`;
  }
  if (!cached.updates.length) {
    return `<div class="fo-monday-row">
        <span class="fo-monday-key">Reply to</span>
        <span class="fo-muted-label">no existing updates on this item yet -- will post as a new comment</span>
      </div>`;
  }

  let options = `<option value="">-- new comment (default) --</option>`;
  for (const u of cached.updates) {
    options += `<option value="${foEscape(u.id)}" ${String(p.parentUpdateId) === String(u.id) ? "selected" : ""}>${foEscape(foUpdatePreview(u))}</option>`;
  }
  return `<div class="fo-monday-row">
      <span class="fo-monday-key">Reply to</span>
      <select class="fo-monday-select" id="fo-replyto-${item.id}" onchange="foReplyToChanged('${item.id}')" ${pending ? "disabled" : ""}>
        ${options}
      </select>
    </div>`;
}

// Board/group mean something different per Send-as mode: for create_item
// it's the actual routing decision (payload.boardId/groupId), for
// create_subitem it's the board half of that (payload.boardId, needed for
// default assignees -- groupId isn't used by a subitem create at all) PLUS
// the search scope for the parent-item picker, and for update_only it's
// ONLY a search scope (update_only never carries boardId/groupId as a
// routing decision -- it targets a fixed existingItemId, nothing to route).
// In every mode, whatever target (parentItemId/existingItemId) was already
// picked belongs to the OLD board+group -- changing either one here makes
// that target stale, so it's cleared and Naz has to re-pick from the new
// scope's list rather than silently sending to something that used to make
// sense. Never leave board and parentItemId disagreeing (see item-chat.js's
// DRAFTING_RULES) -- this is the one place that could otherwise happen.
function foBoardGroupChanged(id) {
  const boardSel = document.getElementById(`fo-board-${id}`);
  const groupSel = document.getElementById(`fo-group-${id}`);
  if (!boardSel || !groupSel) return;
  foPatchBoardGroup(id, boardSel.value, groupSel.value);
}

function foPatchBoardGroup(id, newBoard, newGroup) {
  const item = foItems.find((it) => it.id === id);
  if (!item) return;
  const patch = { board: newBoard, group: newGroup };
  const mode = item.payload && item.payload.mode;

  if (mode === "create_item") {
    const ids = foResolveBoardGroupIds(newBoard, newGroup);
    if (!ids) {
      alert(`No known Monday group for "${newGroup}" on the ${newBoard} board. The label updated, but the actual Monday routing did not change -- fix this combination (or resolve it via the card's chat) before sending to Monday.`);
    } else {
      patch.payload = { ...item.payload, boardId: ids.boardId, groupId: ids.groupId };
    }
  } else if (mode === "create_subitem") {
    const ids = foResolveBoardGroupIds(newBoard, newGroup);
    const nextPayload = { ...item.payload };
    if (ids) nextPayload.boardId = ids.boardId;
    if (nextPayload.parentItemId) {
      delete nextPayload.parentItemId;
      delete nextPayload.parentItemName;
    }
    patch.payload = nextPayload;
  } else if (mode === "update_only" && item.payload.existingItemId) {
    const nextPayload = { ...item.payload };
    delete nextPayload.existingItemId;
    delete nextPayload.itemName;
    delete nextPayload.parentItemId;
    delete nextPayload.parentItemName;
    delete nextPayload.parentUpdateId;
    patch.payload = nextPayload;
  }

  foPatch(id, patch);
}

// The three Send-as modes clear whatever the OTHER modes' target fields
// left behind -- a stale parentItemId/existingItemId/itemName is exactly
// how a send ends up targeting the wrong thing. boardId is (re)resolved
// from whatever board/group are ALREADY showing, so switching modes never
// leaves a routing-relevant mode without one just because the user hasn't
// touched the board/group dropdowns yet this visit.
function foSendAsChanged(id) {
  const item = foItems.find((it) => it.id === id);
  const sel = document.getElementById(`fo-sendas-${id}`);
  if (!item || !item.payload || !sel) return;
  const nextMode = sel.value;
  if (nextMode === item.payload.mode) return;

  const payload = { ...item.payload, mode: nextMode };
  const ids = foResolveBoardGroupIds(item.board, item.group);

  if (nextMode === "create_item") {
    delete payload.parentItemId;
    delete payload.parentItemName;
    delete payload.existingItemId;
    delete payload.itemName; // always lookup/target-derived coming from the other two modes, never authored here
    delete payload.parentUpdateId; // only ever meaningful for update_only
    if (ids) {
      payload.boardId = ids.boardId;
      payload.groupId = ids.groupId;
    }
  } else if (nextMode === "create_subitem") {
    delete payload.existingItemId;
    delete payload.parentUpdateId;
    if (ids) payload.boardId = ids.boardId;
  } else if (nextMode === "update_only") {
    // Whatever parentItemId was here belonged to create_subitem's OWN
    // semantics (the parent of a not-yet-created item) -- only valid again
    // once foTargetChanged resolves it FROM the picked existing item.
    delete payload.parentItemId;
    delete payload.parentItemName;
    delete payload.parentUpdateId; // no target chosen yet in this fresh switch
  }

  foPatch(id, { payload });
}

// Picking a target sets exactly what that mode sends to Monday with --
// parentItemId for a new subitem, existingItemId for an update. For
// update_only, picking a target that's itself a subitem also resolves
// parentItemId/parentItemName from it (same as buildResolvedFields does
// server-side for an update_only draft authored via chat), so the card's
// label can say "subitem of X" without a second lookup.
function foTargetChanged(id) {
  const item = foItems.find((it) => it.id === id);
  const sel = document.getElementById(`fo-target-${id}`);
  if (!item || !item.payload || !sel || !sel.value) return;

  const ids = foResolveBoardGroupIds(item.board, item.group);
  const cached = ids && foGetTargetsSync(ids.boardId, ids.groupId);
  const targets = (cached && cached.targets) || [];
  const chosenId = sel.value;

  const payload = { ...item.payload };
  if (payload.mode === "create_subitem") {
    const target = targets.find((t) => String(t.id) === chosenId);
    if (!target) return;
    payload.parentItemId = target.id;
    payload.parentItemName = target.name;
    delete payload.existingItemId;
  } else if (payload.mode === "update_only") {
    const topLevel = targets.find((t) => String(t.id) === chosenId);
    if (topLevel) {
      payload.existingItemId = topLevel.id;
      payload.itemName = topLevel.name;
      delete payload.parentItemId;
      delete payload.parentItemName;
    } else {
      const parent = targets.find((t) => (t.subitems || []).some((s) => String(s.id) === chosenId));
      const sub = parent && parent.subitems.find((s) => String(s.id) === chosenId);
      if (!sub) return;
      payload.existingItemId = sub.id;
      payload.itemName = sub.name;
      payload.parentItemId = parent.id;
      payload.parentItemName = parent.name;
    }
    // A previously picked reply-to update belonged to the OLD target --
    // meaningless (and potentially wrong) once the target itself changes.
    delete payload.parentUpdateId;
  } else {
    return;
  }

  foPatch(id, { payload });
}

// Picking (or clearing) which existing update to reply to -- blank means a
// new top-level comment, same as never having set parentUpdateId at all.
function foReplyToChanged(id) {
  const item = foItems.find((it) => it.id === id);
  const sel = document.getElementById(`fo-replyto-${id}`);
  if (!item || !item.payload || !sel) return;

  const payload = { ...item.payload };
  if (sel.value) payload.parentUpdateId = sel.value;
  else delete payload.parentUpdateId;

  foPatch(id, { payload });
}

// Enter is left alone here (unlike the single-line fields elsewhere on this
// dashboard) -- this is real multi-line rich text (bullets, paragraphs),
// pressing Enter mid-edit needs to insert a line/new bullet, not save-and-
// blur. Escape still reverts, via innerHTML (not textContent -- this is
// rendered HTML, not plain text; textContent would dump the raw markup as
// literal visible text instead of restoring the actual bullets/bold/chips).
function foUpdateBodyKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.target.innerHTML = e.target.dataset.original || "";
    e.target.blur();
  }
}

function foSaveUpdateBodyEdit(el, id) {
  const item = foItems.find((it) => it.id === id);
  if (!item || !item.payload) return;
  const next = el.innerHTML.trim();
  const original = el.dataset.original || "";
  if (next === original) return;
  foPatch(id, { payload: { ...item.payload, updateBody: next } });
}

// Mirrors lib/monday.js's findFakeMentionText exactly -- keep both in sync.
// A typed "@Hashir" is plain text; Monday won't notify anyone or render a
// chip for it (see the real §7 mention format below). Strips real mention
// anchors first, then looks for anything left that still starts with "@"
// and reads like a name.
function foFindFakeMentions(html) {
  if (!html) return [];
  const withoutRealMentions = String(html).replace(/<a[^>]*class="mention"[^>]*>[\s\S]*?<\/a>/gi, " ");
  const plainText = withoutRealMentions.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
  const matches = plainText.match(/@[A-Za-z][A-Za-z'.]*(?:\s+[A-Z][A-Za-z'.]*){0,3}/g) || [];
  return matches.map((m) => m.trim());
}

// Only one open at a time -- opening one card's picker closes any other.
function foToggleMentionPicker(cardId) {
  const picker = document.getElementById(`fo-mentionpicker-${cardId}`);
  if (!picker) return;
  const willShow = picker.hidden;
  document.querySelectorAll(".fo-mention-picker").forEach((el) => { el.hidden = true; });
  picker.hidden = !willShow;
}

function foHideMentionPicker(cardId) {
  const picker = document.getElementById(`fo-mentionpicker-${cardId}`);
  if (picker) picker.hidden = true;
}

// Inserts REAL Monday mention markup (the exact §7 HTML format, not typed
// "@Name" text) at wherever the cursor currently is in this card's update-
// text field -- or at the end, if the field wasn't already focused (clicking
// the @ button itself doesn't steal focus, thanks to the onmousedown
// preventDefault on both the button and every picker option, but there may
// never have been a selection in this field at all yet). Saves immediately
// through the same foPatch() path as any other edit here.
function foInsertMention(cardId, userId) {
  const person = (foRouting.people || []).find((p) => p.id === userId);
  const el = document.getElementById(`fo-updatebody-${cardId}`);
  if (!person || !el) return;

  const html = `<a class="mention" data-mention-id="${person.id}" data-mention-type="User">@${foEscape(person.name)}</a>&nbsp;`;
  const sel = window.getSelection();
  const hasSelectionInField = sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer);

  if (hasSelectionInField) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = range.createContextualFragment(html);
    const lastNode = frag.lastChild;
    range.insertNode(frag);
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } else {
    el.focus();
    el.insertAdjacentHTML("beforeend", html);
  }

  foHideMentionPicker(cardId);
  foSaveUpdateBodyEdit(el, cardId);
}

// Clicking anywhere outside an open picker closes it -- registered once,
// not per-card.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".fo-mention-wrap")) {
    document.querySelectorAll(".fo-mention-picker").forEach((el) => { el.hidden = true; });
  }
});


function foBumpPriority(id, delta) {
  const item = foItems.find((it) => it.id === id);
  if (!item) return;
  const next = Math.min(5, Math.max(1, foPriority(item) + delta));
  if (next === foPriority(item)) return;
  foPatch(id, { priority: next });
}

// Conversation history per item, kept client-side so a full foLoadQueue()
// re-render (triggered whenever any card changes) doesn't lose in-progress
// threads on other cards -- each card's log is redrawn from this store.
const foItemChat = {};

function foRenderChatMessages(id, thinking) {
  const msgs = (foItemChat[id] || []).map(m => `<div class="fo-itemchat-msg ${m.role}">${foEscape(m.content)}</div>`).join("");
  return msgs + (thinking ? `<div class="fo-itemchat-msg assistant fo-thinking">thinking…</div>` : "");
}

function foRenderChatLog(id, thinking) {
  const log = document.getElementById(`fo-chat-log-${id}`);
  if (!log) return;
  log.innerHTML = foRenderChatMessages(id, thinking);
  log.scrollTop = log.scrollHeight;
}

async function foSendItemChat(e, id) {
  e.preventDefault();
  const form = e.target;
  const input = form.querySelector("input");
  const button = form.querySelector("button");
  const message = input.value.trim();
  if (!message) return false;

  input.value = "";
  input.disabled = true;
  button.disabled = true;

  const history = foItemChat[id] || [];
  if (history.length === 0) {
    const noteEl = document.getElementById(`fo-note-${id}`);
    if (noteEl) noteEl.hidden = true;
  }
  foItemChat[id] = [...history, { role: "user", content: message }];
  foRenderChatLog(id, true);

  let res;
  try {
    res = await fetch("/.netlify/functions/item-chat", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, message, history }) });
  } catch (err) {
    foItemChat[id].push({ role: "assistant", content: "error: " + err.message });
    foRenderChatLog(id);
    input.disabled = false;
    button.disabled = false;
    return false;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    foItemChat[id].push({ role: "assistant", content: "error: " + (data.error || `HTTP ${res.status}`) });
    foRenderChatLog(id);
    input.disabled = false;
    button.disabled = false;
    return false;
  }

  foItemChat[id].push({ role: "assistant", content: data.reply || "(no reply)" });
  if (data.changed) {
    // Something on the card actually changed (payload/status/priority/
    // reassignment/etc). item-chat.js already echoes back the fresh item, so
    // patch it into the local cache and re-render straight away instead of
    // paying for a second round trip (foLoadQueue) just to re-fetch what we
    // were already handed. The thread itself is left in foItemChat, so it
    // survives the re-render and Naz can keep editing the same card in the
    // same conversation.
    if (data.item) {
      const idx = foItems.findIndex(it => it.id === id);
      if (idx !== -1) foItems[idx] = data.item;
      else foItems.push(data.item);
      foRenderFromItems(foItems);
    } else {
      foLoadQueue();
    }
  } else {
    foRenderChatLog(id);
    input.disabled = false;
    button.disabled = false;
  }
  return false;
}

async function foPatch(id, patch) {
  // Belt-and-suspenders: the render layer already disables this card's
  // buttons while foPending has its id (see foQueueCard), but guard here too
  // in case something ever calls foPatch() directly (e.g. the chat tools).
  if (foPending.has(id)) return;
  foPending.add(id);

  const idx = foItems.findIndex(it => it.id === id);
  const previous = idx !== -1 ? foItems[idx] : null;
  if (idx !== -1) {
    // Show the result of the click immediately -- the card moves to whatever
    // section the new status belongs in right away, rather than sitting still
    // for the few seconds the GitHub commit round trip actually takes.
    foItems[idx] = { ...previous, ...patch };
    foRenderFromItems(foItems);
  }

  try {
    const res = await fetch("/.netlify/functions/queue", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, patch }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (idx !== -1) foItems[idx] = previous; // the guess was wrong -- put it back
      alert("Couldn't update it: " + (data.error || `HTTP ${res.status}`));
      return;
    }
    // Reconcile with whatever the server actually persisted (updatedAt, any
    // server-side fields the optimistic patch didn't know about).
    foItems = data.items || foItems;
  } finally {
    foPending.delete(id);
    foRenderFromItems(foItems);
  }
}

// The real network fire -- unchanged mechanism (still the one human-clicked
// path that can create/update a real Monday item). The confirmation step now
// lives entirely in the preview (foOpenSendPreview / foConfirmSendPreview)
// that calls this, not in a native confirm() here -- there's no caller left
// that should invoke this without the human having already seen an editable
// preview of exactly what's about to fire.
async function foSendToMonday(id, opts = {}) {
  const force = !!opts.force;
  const idx = foItems.findIndex(it => it.id === id);
  const previous = idx !== -1 ? foItems[idx] : null;
  if (idx !== -1) {
    // Can't know the real mondayItemId yet, but showing "sending..." beats
    // leaving the button looking clickable/frozen for the 5-10s the actual
    // Monday API calls take. The card stays put (not moved to Mondayed) until
    // the send is actually confirmed -- it's a real external side effect, not
    // something to guess the outcome of.
    foItems[idx] = { ...previous, _sending: true };
    foRenderFromItems(foItems);
  }

  const res = await fetch("/.netlify/functions/send-to-monday", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, force }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    if (idx !== -1) {
      foItems[idx] = previous;
      foRenderFromItems(foItems);
    }
    // A likely-duplicate hit is a warning, not a hard failure -- offer the
    // "send anyway" escape hatch instead of just alert()-ing the error text
    // and leaving no way past it for the false-positive case.
    if (data.duplicate) {
      foShowDuplicateWarning(id, data.duplicate);
    } else {
      alert("Couldn't send it: " + (data.error || `HTTP ${res.status}`));
    }
    return;
  }
  if (idx !== -1) {
    foItems[idx] = { ...previous, status: "sent", mondayItemId: data.mondayItemId };
  }
  foRenderFromItems(foItems);
}

// lib/monday.js's findLikelyDuplicate found a live Monday item/subitem that
// looks like it already covers this draft (by name, or by an existing
// update's text) -- its own overlay (not a native confirm()) so the match
// details are actually readable, reusing the send-preview's CSS rather than
// a parallel style.
function foShowDuplicateWarning(id, duplicate) {
  document.getElementById("fo-dup-warning-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "fo-dup-warning-overlay";
  overlay.className = "fo-preview-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const pct = Math.round((duplicate.score || 0) * 100);
  overlay.innerHTML = `
    <div class="fo-preview-card" role="dialog" aria-modal="true" aria-label="Possible duplicate">
      <div class="fo-preview-header">
        <span class="fo-preview-eyebrow">Possible duplicate -- nothing sent yet</span>
      </div>
      <p class="fo-preview-note">"${foEscape(duplicate.name)}" (Monday ${duplicate.isSubitem ? "subitem" : "item"} ${foEscape(duplicate.id)}) looks ${pct}% similar, matched on ${foEscape(duplicate.matchedOn || "")}.</p>
      <div class="fo-preview-actions fo-actions">
        <button type="button" class="fo-preview-cancel" id="fo-dup-cancel-btn">Cancel</button>
        <button type="button" class="fo-primary" id="fo-dup-send-anyway-btn">Send anyway</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("fo-dup-cancel-btn").addEventListener("click", () => overlay.remove());
  document.getElementById("fo-dup-send-anyway-btn").addEventListener("click", () => {
    overlay.remove();
    foSendToMonday(id, { force: true });
  });
}

// ── ignore-reason prompt ──────────────────────────────────────────────────
//
// Mirrors the performance lens's own rule (suggestions.js: a dismiss needs a
// reason because that reason is what the lens learns from) -- same idea
// here, just with quick presets on top of free text since most ignores are
// one of a handful of shapes (never a real task, already done, a dup of
// something else already queued/sent, misrouted client). Stored on the item
// as {ignoreReason, ignoredAt} so item-chat.js/ops-chat.js's drafting rules
// and monday-automation.md's Job A can both read what Naz has repeatedly
// rejected and steer away from redrafting the same kind of non-task.

const FO_IGNORE_PRESETS = ["not a task", "already handled", "duplicate", "wrong client"];

function foOpenIgnorePrompt(id) {
  document.getElementById("fo-ignore-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "fo-ignore-overlay";
  overlay.className = "fo-preview-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `
    <div class="fo-preview-card" role="dialog" aria-modal="true" aria-label="Why ignore this?">
      <div class="fo-preview-header">
        <span class="fo-preview-eyebrow">Why ignore this?</span>
      </div>
      <p class="fo-preview-note">Feeds back into what gets drafted next time -- a reason Naz keeps giving for the same kind of card steers the automation away from redrafting it.</p>
      <div class="fo-ignore-presets">
        ${FO_IGNORE_PRESETS.map((r) => `<button type="button" class="fo-ignore-preset" data-reason="${foEscape(r)}">${foEscape(r)}</button>`).join("")}
      </div>
      <input type="text" class="fo-ignore-input" id="fo-ignore-input" placeholder="Or type a reason...">
      <div class="fo-preview-actions fo-actions">
        <button type="button" class="fo-preview-cancel" id="fo-ignore-cancel-btn">Cancel</button>
        <button type="button" class="fo-primary" id="fo-ignore-confirm-btn">Ignore</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById("fo-ignore-input");
  overlay.querySelectorAll(".fo-ignore-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".fo-ignore-preset").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      input.value = btn.dataset.reason;
      input.focus();
    });
  });
  document.getElementById("fo-ignore-cancel-btn").addEventListener("click", () => overlay.remove());
  document.getElementById("fo-ignore-confirm-btn").addEventListener("click", () => {
    const reason = input.value.trim();
    if (!reason) { input.focus(); return; }
    overlay.remove();
    foPatch(id, { status: "ignored", ignoreReason: reason, ignoredAt: new Date().toISOString() });
  });
  input.focus();
}

// ── send-to-monday preview (editable, confirm-before-fire) ───────────────────
//
// Mirrors the /monday-task widget's own rule: title and description are
// contenteditable, nothing fires until an explicit confirm click, and the
// target board/client is shown plainly. Cancel (or Escape, or clicking the
// backdrop) tears the overlay down with zero network calls -- editing here
// is purely in-memory DOM state until Confirm is clicked, which is the only
// path that ever calls fetch.

function foCloseSendPreview() {
  document.getElementById("fo-send-preview-overlay")?.remove();
  document.removeEventListener("keydown", foSendPreviewEscHandler);
}

function foSendPreviewEscHandler(e) {
  if (e.key === "Escape") foCloseSendPreview();
}

function foOpenSendPreview(id) {
  const item = foItems.find(it => it.id === id);
  if (!item || !item.payload) return;

  document.getElementById("fo-send-preview-overlay")?.remove();

  const payload = item.payload;
  const isUpdateOnly = payload.mode === "update_only";
  const targetBits = [item.board, item.group].filter(Boolean);
  const targetLabel = targetBits.length ? targetBits.join(" / ") : "Unknown board/client";

  // Surfaced here too, not just at the hard confirm-time gate below -- catch
  // it the moment the preview opens, in case it slipped through from before
  // this picker existed, rather than only discovering it after clicking confirm.
  const fakeMentions = foFindFakeMentions(payload.updateBody);

  const overlay = document.createElement("div");
  overlay.id = "fo-send-preview-overlay";
  overlay.className = "fo-preview-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) foCloseSendPreview(); });

  overlay.innerHTML = `
    <div class="fo-preview-card" role="dialog" aria-modal="true" aria-label="Preview before sending to Monday">
      <div class="fo-preview-header">
        <span class="fo-preview-eyebrow">Preview — nothing sent yet</span>
        <span class="fo-preview-target">${foEscape(targetLabel)}</span>
      </div>
      ${isUpdateOnly ? `<p class="fo-preview-note">Posts an update to an existing Monday item — no new item is created.</p>` : `
        <div class="fo-preview-field">
          <label class="fo-preview-field-label">Title</label>
          <div class="fo-preview-title" contenteditable="true" id="fo-preview-title">${foEscape(payload.itemName || "")}</div>
        </div>
      `}
      <div class="fo-preview-field">
        <label class="fo-preview-field-label">Description</label>
        <div class="fo-preview-body" contenteditable="true" id="fo-preview-body">${payload.updateBody || ""}</div>
      </div>
      ${fakeMentions.length ? `<p class="fo-preview-error">Typed as plain text, not a real mention: ${fakeMentions.map(foEscape).join(", ")}. Close this and use the @ picker on the card instead -- sending will be blocked until it's a real mention.</p>` : ""}
      <p class="fo-preview-error" id="fo-preview-error" hidden></p>
      <div class="fo-preview-actions fo-actions">
        <button type="button" class="fo-preview-cancel" id="fo-preview-cancel-btn">Cancel</button>
        <button type="button" class="fo-primary" id="fo-preview-confirm-btn">Confirm &amp; send to Monday</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.getElementById("fo-preview-cancel-btn").addEventListener("click", foCloseSendPreview);
  document.getElementById("fo-preview-confirm-btn").addEventListener("click", () => foConfirmSendPreview(id));
  document.addEventListener("keydown", foSendPreviewEscHandler);
  (document.getElementById("fo-preview-title") || document.getElementById("fo-preview-body"))?.focus();
}

async function foConfirmSendPreview(id) {
  const item = foItems.find(it => it.id === id);
  if (!item || !item.payload) { foCloseSendPreview(); return; }

  const btn = document.getElementById("fo-preview-confirm-btn");
  const cancelBtn = document.getElementById("fo-preview-cancel-btn");
  const errEl = document.getElementById("fo-preview-error");
  const titleEl = document.getElementById("fo-preview-title");
  const bodyEl = document.getElementById("fo-preview-body");

  const newItemName = titleEl ? titleEl.textContent.trim() : (item.payload.itemName || "");
  const newUpdateBody = bodyEl ? bodyEl.innerHTML.trim() : (item.payload.updateBody || "");
  const payloadChanged =
    newItemName !== (item.payload.itemName || "") || newUpdateBody !== (item.payload.updateBody || "");

  // Hard gate, same rule sendQueueItemToMonday enforces server-side
  // (checkMentionsAreReal) -- checked again here against whatever's in the
  // field right now, including any last edit made in this very modal, so
  // this can't be bypassed by typing a fake mention in the preview itself.
  const fakeMentions = foFindFakeMentions(newUpdateBody);
  if (fakeMentions.length) {
    errEl.textContent = `Typed as plain text, not a real mention: ${fakeMentions.join(", ")}. Use the @ picker on the card instead of typing "@Name" -- nothing was sent.`;
    errEl.hidden = false;
    return;
  }

  btn.disabled = true;
  cancelBtn.disabled = true;
  btn.textContent = "Saving edits…";
  errEl.hidden = true;

  if (payloadChanged) {
    const patch = { payload: { ...item.payload, itemName: newItemName, updateBody: newUpdateBody } };
    if (item.payload.mode !== "update_only") patch.title = newItemName;

    let res, data;
    try {
      res = await fetch("/.netlify/functions/queue", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, patch }) });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      res = null;
      data = { error: String((err && err.message) || err) };
    }
    if (!res || !res.ok || data.error) {
      errEl.textContent = "Couldn't save your edits, so nothing was sent: " + (data.error || (res ? `HTTP ${res.status}` : "network error"));
      errEl.hidden = false;
      btn.disabled = false;
      cancelBtn.disabled = false;
      btn.textContent = "Confirm & send to Monday";
      return;
    }
    foItems = data.items || foItems;
  }

  foCloseSendPreview();
  await foSendToMonday(id); // the one real write -- unchanged, now only ever reached after this explicit confirm
}

foLoadQueue();
