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
    const key = item.group || "n/a";
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

// Cards the automation couldn't confidently route to a signed client on the
// active roster (item.potentialClient set instead of a real group) get
// grouped by that inferred prospect name here, same sort as foGroupByClient.
function foGroupByProspect(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.potentialClient || "Unknown";
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
  // Cards flagged "unmapped client/workstream" by the automation carry
  // potentialClient instead of a real roster group -- they get their own
  // section below instead of being force-grouped under an existing client
  // or sitting invisibly with nowhere to render.
  const activeReal      = active.filter(it => !it.potentialClient);
  const activeProspects = active.filter(it => it.potentialClient);

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

function foStripGroupPrefix(title, group) {
  if (!group) return title;
  const escaped = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`^\\[${escaped}\\]\\s*`, "i"), "");
}

// section is "active" | "handled" | "mondayed".
function foQueueCard(item, section) {
  const cls = { ready: "fo-b-ready", confirm: "fo-b-confirm", sent: "fo-b-sent", done: "fo-b-done", ignored: "fo-b-done" }[item.status] || "fo-b-confirm";
  const p = foPriority(item);

  // mondayItemId means a real Monday item already exists for this card --
  // clicking send-to-monday again would create a genuine duplicate on the
  // board. _sending is a local-only optimistic flag (see foSendToMonday) --
  // the real Monday API round trip takes 5-10s, so this shows immediately
  // rather than leaving the button looking clickable/frozen for that stretch.
  const sendControl = item._sending
    ? `<button class="fo-primary" disabled>sending to monday…</button>`
    : item.mondayItemId
    ? `<span class="fo-muted-label">already sent to Monday (item ${foEscape(item.mondayItemId)})</span>`
    : item.payload
    ? `<button class="fo-primary" onclick="foSendToMonday('${item.id}')">send to monday</button>`
    : `<span class="fo-muted-label">${foEscape(NULL_REASON_LABELS[item.nullReason] || NULL_REASON_LABELS["multi-item"])}</span>`;

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
        <button onclick="foPatch('${item.id}', {status:'confirm'})">undo</button>
      </div>`
    : `<div class="fo-actions">
        ${sendControl}
        <button onclick="foPatch('${item.id}', {status:'done'})">mark done</button>
        <button onclick="foPatch('${item.id}', {status:'ignored'})">ignore</button>
      </div>`;

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
  const noteHtml = `<p class="fo-sub" id="fo-note-${item.id}" ${chatStarted ? "hidden" : ""}>${foEscape(item.note || "")}</p>`;

  return `
    <div class="fo-card">
      <div class="fo-row">
        <div>
          <p class="fo-title">${foEscape(title)}</p>
          ${noteHtml}
          ${item.sourceLabel ? `<p class="fo-source">${foEscape(item.sourceLabel)}</p>` : ""}
        </div>
        <div class="fo-badges">
          <span class="fo-priority fo-priority-${p}">P${p}</span>
          <span class="fo-badge ${cls}">${foEscape(item.status || "confirm")}</span>
        </div>
      </div>
      ${actions}
      ${itemChatBox}
    </div>`;
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
  const idx = foItems.findIndex(it => it.id === id);
  const previous = idx !== -1 ? foItems[idx] : null;
  if (idx !== -1) {
    // Show the result of the click immediately -- the card moves to whatever
    // section the new status belongs in right away, rather than sitting still
    // for the few seconds the GitHub commit round trip actually takes.
    foItems[idx] = { ...previous, ...patch };
    foRenderFromItems(foItems);
  }

  const res = await fetch("/.netlify/functions/queue", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, patch }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (idx !== -1) {
      foItems[idx] = previous; // the guess was wrong -- put it back
      foRenderFromItems(foItems);
    }
    alert("Couldn't update it: " + (data.error || `HTTP ${res.status}`));
    return;
  }
  // Reconcile with whatever the server actually persisted (updatedAt, any
  // server-side fields the optimistic patch didn't know about).
  foItems = data.items || foItems;
  foRenderFromItems(foItems);
}

async function foSendToMonday(id) {
  if (!confirm("This creates a real item on Monday. Go ahead?")) return;

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

foLoadQueue();
