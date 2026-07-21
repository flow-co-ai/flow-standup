// This reuses whatever passcode mechanism the page already has for the
// checkmark feature — swap FO_PASSCODE() for however that value is already
// available in your existing app.js instead of prompting a second time.
function FO_PASSCODE() {
  // Same passcode the checkmark sync uses — stored once, shared by both features.
  let p = localStorage.getItem("flowops-passcode");
  if (!p) {
    p = prompt("Ops passcode");
    if (p) localStorage.setItem("flowops-passcode", p);
  }
  return p || "";
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
const foSectionExpanded = { handled: false, mondayed: false };

// Last-known full queue, kept client-side so button clicks can re-render
// immediately from a local optimistic guess instead of waiting 5-10s on a
// round trip (Monday API calls, GitHub commits) before anything visibly
// changes. Every mutation below patches this in place, re-renders straight
// away, then reconciles with whatever the server actually persisted.
let foItems = [];

// ids currently mid-foPatch(). Rapid clicks on the same card's buttons (e.g.
// mashing a priority arrow) used to fire several overlapping POSTs -- each
// read the same GitHub sha, so every one after the first landed as a 409 and
// got silently rolled back. This blocks the buttons for that card the moment
// the first click fires so there's only ever one write in flight per item.
const foPending = new Set();

function foRenderFromItems(items) {
  // Standing invariant: a real Monday item existing (mondayItemId set)
  // always wins over whatever the stored status field says -- so section
  // placement itself can never show a Mondayed item as active or Handled,
  // even if some bug upstream left the status field inconsistent.
  const active = items.filter(it => !it.mondayItemId && ACTIVE_STATUSES.includes(it.status));
  const handled = items.filter(it => !it.mondayItemId && HANDLED_STATUSES.includes(it.status));
  const mondayed = items.filter(it => it.mondayItemId || MONDAYED_STATUSES.includes(it.status));
  document.getElementById("fo-queue-cards").innerHTML = foRenderQueue(active, handled, mondayed);
}

async function foLoadQueue() {
  try {
    const res = await fetch("/.netlify/functions/queue", { headers: foHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    foItems = data.items || [];
    foRenderFromItems(foItems);
  } catch (e) {
    document.getElementById("fo-queue-cards").innerHTML = `<div class="fo-empty">couldn't reach the draft queue${e && e.message ? ": " + foEscape(e.message) : ""}</div>`;
  }
}

// Items missing a priority (older data, predating the field) sort as if they
// were a 3 -- normal, not urgent, not last-resort.
function foPriority(item) {
  const p = Number(item.priority);
  return Number.isFinite(p) && p >= 1 && p <= 5 ? p : 3;
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

function foRenderCollapsibleSection(key, label, items, emptyText) {
  const expanded = foSectionExpanded[key];
  return `
    <div class="fo-handled">
      <button class="fo-handled-toggle" onclick="foToggleSection('${key}')">
        ${expanded ? "▾" : "▸"} ${label} (${items.length})
      </button>
      <div class="fo-handled-list fo-card-grid" ${expanded ? "" : "hidden"}>
        ${items.length ? items.map(item => foQueueCard(item, key)).join("") : `<div class="fo-empty">${emptyText}</div>`}
      </div>
    </div>`;
}

function foRenderQueue(active, handled, mondayed) {
  // Structural rule, not a special case for any particular flag: anything
  // without a real, resolvable Monday group ALWAYS renders in Potential
  // Clients, never as its own client group and never under a raw "n/a"/
  // "Unknown" catch-all. This holds regardless of WHY the group is missing
  // -- explicitly flagged potentialClient by the automation, or any other
  // reason a group never got set -- so there is no path left for a
  // groupless card to render silently under a fallback label.
  const activeReal      = active.filter(it => !!it.group);
  const activeProspects = active.filter(it => !it.group);

  const activeHtml = activeReal.length
    ? foGroupByClient(activeReal).map(([client, items]) => `
      <div class="fo-group">
        <div class="fo-group-header">${foEscape(client)} <span class="fo-group-count">(${items.length})</span></div>
        <div class="fo-card-grid">
          ${items.map(item => foQueueCard(item, "active")).join("")}
        </div>
      </div>`).join("")
    : (activeProspects.length ? "" : `<div class="fo-empty">queue is empty</div>`);

  const prospectsHtml = activeProspects.length ? `
    <div class="fo-prospects">
      <div class="fo-label">Potential clients</div>
      ${foGroupByProspect(activeProspects).map(([name, items]) => `
        <div class="fo-group fo-group-prospect">
          <div class="fo-group-header">${foEscape(name)} <span class="fo-group-count">(${items.length})</span></div>
          <div class="fo-card-grid">
            ${items.map(item => foQueueCard(item, "active")).join("")}
          </div>
        </div>`).join("")}
    </div>` : "";

  const handledHtml = foRenderCollapsibleSection("handled", "handled", handled, "nothing handled yet");
  const mondayedHtml = foRenderCollapsibleSection("mondayed", "mondayed", mondayed, "nothing sent to monday yet");

  return activeHtml + prospectsHtml + handledHtml + mondayedHtml;
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
};

// Every field here already exists in the pipeline's own payload schema
// (fireflies-monday-watch SKILL.md step A4h: {mode, boardId+groupId |
// parentItemId | existingItemId, itemName, columnValues, updateBody}) --
// this only surfaces Monday's own language directly on the card instead of
// the paraphrased title/note, it doesn't generate anything new. board/group
// are already human-readable strings at the top level of the item (not raw
// Monday ids), so no id-to-label lookup is needed either.
function foMondayNameRow(p) {
  if (p.mode === "create_subitem") return { label: "Subitem", value: p.itemName || "(untitled)" };
  if (p.mode === "create_item") return { label: "Item", value: p.itemName || "(untitled)" };
  // update_only: nothing new is named -- itemName here (when present) just
  // echoes what the EXISTING item is called, it's not a rename.
  return { label: "Updating item", value: p.itemName || `#${p.existingItemId || "?"}` };
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
  // empty or broken Monday fields.
  if (!item.payload) {
    const reason = NULL_REASON_LABELS[item.nullReason] || NULL_REASON_LABELS["multi-item"];
    return `<div class="fo-monday-details fo-monday-blocked">
      <span class="fo-monday-blocked-label">${foEscape(reason)}</span>
    </div>`;
  }

  const p = item.payload;
  const nameRow = foMondayNameRow(p);
  const updateBodyBlock = p.updateBody
    ? `<div class="fo-update-body">${p.updateBody}</div>`
    : `<div class="fo-update-body fo-update-body-missing">No full update draft was captured for this item yet -- showing the summary note above instead.</div>`;

  return `<div class="fo-monday-details">
      <div class="fo-monday-row">
        <span class="fo-monday-key">${foEscape(nameRow.label)}</span>
        <span class="fo-monday-val">${foEscape(nameRow.value)}</span>
      </div>
      <div class="fo-monday-row">
        <span class="fo-monday-key">Board</span>
        <span class="fo-monday-val">${foEscape(item.board || "n/a")}</span>
        <span class="fo-monday-key">Group</span>
        <span class="fo-monday-val">${foEscape(item.group || "n/a")}</span>
      </div>
      <span class="fo-monday-key">Update text</span>
      ${updateBodyBlock}
    </div>`;
}

function foStripGroupPrefix(title, group) {
  if (!group) return title;
  const escaped = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`^\\[${escaped}\\]\\s*`, "i"), "");
}

// section is "active" | "handled" | "mondayed".
function foQueueCard(item, section) {
  const cls = { ready: "fo-b-ready", confirm: "fo-b-confirm", sent: "fo-b-sent", done: "fo-b-done", ignored: "fo-b-done" }[item.status] || "fo-b-confirm";
  const p = foPriority(item);
  const pending = foPending.has(item.id);

  // mondayItemId means a real Monday item already exists for this card --
  // clicking send-to-monday again would create a genuine duplicate on the
  // board. _sending is a local-only optimistic flag (see foSendToMonday) --
  // the real Monday API round trip takes 5-10s, so this shows immediately
  // rather than leaving the button looking clickable/frozen for that stretch.
  // No-payload case renders nothing here (was a duplicate, sometimes
  // mislabeled -- see foBuildMondayDetails) -- the Monday-details block
  // above the actions row is now the one place that explains why there's
  // no send button.
  const sendControl = item._sending
    ? `<button class="fo-primary" disabled>sending to monday…</button>`
    : item.mondayItemId
    ? `<span class="fo-muted-label">already sent to Monday (item ${foEscape(item.mondayItemId)})</span>`
    : item.payload
    ? `<button class="fo-primary" onclick="foOpenSendPreview('${item.id}')">send to monday</button>`
    : "";

  // Mondayed cards get no "undo" -- a real Monday item exists permanently,
  // there's nothing local left to revert (see the standing sent-invariant:
  // mondayItemId always wins over status, so a fake "undo" would just get
  // silently corrected back on the next write anyway).
  const actions = section === "mondayed"
    ? `<div class="fo-actions">
        <span class="fo-muted-label">sent to Monday${item.mondayItemId ? ` (item ${foEscape(item.mondayItemId)})` : ""}</span>
      </div>`
    : section === "handled"
    ? `<div class="fo-actions">
        <button onclick="foPatch('${item.id}', {status:'confirm'})" ${pending ? "disabled" : ""}>undo</button>
      </div>`
    : `<div class="fo-actions">
        ${sendControl}
        <button onclick="foPatch('${item.id}', {status:'done'})" ${pending ? "disabled" : ""}>mark done</button>
        <button onclick="foPatch('${item.id}', {status:'ignored'})" ${pending ? "disabled" : ""}>ignore</button>
      </div>`;

  const mondayDetails = foBuildMondayDetails(item);

  // Grouped (active) cards sit under a header already naming the client, so the
  // redundant "[Client Name]" bracket in the title is stripped there; the flat
  // Handled/Mondayed lists have no such header, so their titles keep the full bracket.
  const title = section === "active" ? foStripGroupPrefix(item.title || item.id, item.group) : (item.title || item.id);

  // Every card gets a thread now -- item-chat.js is a general edit assistant
  // for the whole card (reply, edit title/note/payload, change status or
  // priority, reassign), not just a missing-payload resolver, so this is no
  // longer gated on status === "confirm".
  const itemChatBox = `
    <div class="fo-itemchat">
      <div class="fo-itemchat-log" id="fo-chat-log-${item.id}">${foRenderChatMessages(item.id)}</div>
      <form class="fo-itemchat-form" onsubmit="return foSendItemChat(event, '${item.id}')">
        <input type="text" placeholder="Ask, edit, reassign, or resolve..." />
        <button type="submit">Send</button>
      </form>
    </div>`;

  // Once a chat thread has started, the bot's conversation is the live source
  // of truth for this card, so the static note (which may now be stale) hides
  // (foSendItemChat also hides it live, without waiting on a reload).
  const chatStarted = (foItemChat[item.id] || []).length > 0;

  // Direct manual edit path -- contenteditable title/note, saved via the
  // existing foPatch() (same PATCH endpoint the chatbot's edit_item tool
  // already writes through), for the quick tweaks that don't need a
  // conversation. Enter saves (blurs, which triggers the save); Escape
  // reverts to the last-saved text without writing anything. data-original
  // is read back by both handlers, so a plain "clicked in and clicked back
  // out with no real change" never fires a no-op patch.
  const titleHtml = `<p class="fo-title" id="fo-title-${item.id}" contenteditable="true" spellcheck="false"
      data-original="${foEscape(title)}"
      onkeydown="foEditableKeydown(event)"
      onblur="foSaveTitleEdit(this, '${item.id}')">${foEscape(title)}</p>`;
  const noteHtml = `<p class="fo-sub" id="fo-note-${item.id}" contenteditable="true" spellcheck="false"
      data-original="${foEscape(item.note || "")}"
      onkeydown="foEditableKeydown(event)"
      onblur="foSaveNoteEdit(this, '${item.id}')"
      ${chatStarted ? "hidden" : ""}>${foEscape(item.note || "")}</p>`;

  // Priority (1 most urgent, 5 least) drives sort order within a client
  // group (foGroupByClient) -- these buttons are the "reorder" affordance
  // for that: raise/lower priority instead of a free drag, since order
  // isn't independently stored anywhere today, only derived from this
  // number. Same foPatch() write path as everything else here.
  const priorityControls = section === "active" ? `
      <button type="button" class="fo-priority-btn" title="Raise priority" aria-label="Raise priority"
        onclick="foBumpPriority('${item.id}', -1)" ${p <= 1 || pending ? "disabled" : ""}>&#9650;</button>
      <span class="fo-priority fo-priority-${p}">P${p}</span>
      <button type="button" class="fo-priority-btn" title="Lower priority" aria-label="Lower priority"
        onclick="foBumpPriority('${item.id}', 1)" ${p >= 5 || pending ? "disabled" : ""}>&#9660;</button>`
    : `<span class="fo-priority fo-priority-${p}">P${p}</span>`;

  return `
    <div class="fo-card">
      <div class="fo-row">
        <div>
          ${titleHtml}
          ${noteHtml}
          ${item.sourceLabel ? `<p class="fo-source">${foEscape(item.sourceLabel)}</p>` : ""}
        </div>
        <div class="fo-badges">
          ${priorityControls}
          <span class="fo-badge ${cls}">${foEscape(item.status || "confirm")}</span>
        </div>
      </div>
      ${mondayDetails}
      ${actions}
      ${itemChatBox}
    </div>`;
}

// Shared keydown handler for the contenteditable title/note fields: Enter
// saves (blurs -- the blur handler does the actual patch), Shift+Enter is
// left alone (not used today, but doesn't fight a future multi-line note),
// Escape reverts to data-original and blurs without saving.
function foEditableKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    e.target.blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.target.textContent = e.target.dataset.original || "";
    e.target.blur();
  }
}

function foSaveTitleEdit(el, id) {
  const next = el.textContent.trim();
  const original = el.dataset.original || "";
  if (!next || next === original) {
    el.textContent = original; // empty or unchanged -- revert display, no write
    return;
  }
  foPatch(id, { title: next });
}

function foSaveNoteEdit(el, id) {
  const next = el.textContent.trim();
  const original = el.dataset.original || "";
  if (next === original) return; // note may legitimately be empty, unlike title
  foPatch(id, { note: next });
}

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
async function foSendToMonday(id) {
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

  const res = await fetch("/.netlify/functions/send-to-monday", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    if (idx !== -1) {
      foItems[idx] = previous;
      foRenderFromItems(foItems);
    }
    alert("Couldn't send it: " + (data.error || `HTTP ${res.status}`));
    return;
  }
  if (idx !== -1) {
    foItems[idx] = { ...previous, status: "sent", mondayItemId: data.mondayItemId };
  }
  foRenderFromItems(foItems);
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
