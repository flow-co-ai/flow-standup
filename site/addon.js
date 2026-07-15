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
const HANDLED_STATUSES = ["done", "ignored", "sent"];
let foHandledExpanded = false;

async function foLoadQueue() {
  try {
    const res = await fetch("/.netlify/functions/queue", { headers: foHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const items = data.items || [];
    const active = items.filter(it => ACTIVE_STATUSES.includes(it.status));
    const handled = items.filter(it => HANDLED_STATUSES.includes(it.status));
    document.getElementById("fo-queue-cards").innerHTML = foRenderQueue(active, handled);
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

function foRenderQueue(active, handled) {
  const activeHtml = active.length
    ? foGroupByClient(active).map(([client, items]) => `
      <div class="fo-group">
        <div class="fo-group-header">${foEscape(client)} <span class="fo-group-count">(${items.length})</span></div>
        <div class="fo-card-grid">
          ${items.map(item => foQueueCard(item, false)).join("")}
        </div>
      </div>`).join("")
    : `<div class="fo-empty">queue is empty</div>`;

  const handledHtml = `
    <div class="fo-handled">
      <button class="fo-handled-toggle" onclick="foToggleHandled()">
        ${foHandledExpanded ? "▾" : "▸"} handled (${handled.length})
      </button>
      <div class="fo-handled-list fo-card-grid" ${foHandledExpanded ? "" : "hidden"}>
        ${handled.length ? handled.map(item => foQueueCard(item, true)).join("") : `<div class="fo-empty">nothing handled yet</div>`}
      </div>
    </div>`;

  return activeHtml + handledHtml;
}

function foToggleHandled() {
  foHandledExpanded = !foHandledExpanded;
  foLoadQueue();
}

const NULL_REASON_LABELS = {
  "multi-item": "needs /monday-task (multi-item)",
  "content-conflict": "needs your input before this can be drafted",
};

function foStripGroupPrefix(title, group) {
  if (!group) return title;
  const escaped = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`^\\[${escaped}\\]\\s*`, "i"), "");
}

function foQueueCard(item, handled) {
  const cls = { ready: "fo-b-ready", confirm: "fo-b-confirm", sent: "fo-b-sent", done: "fo-b-done", ignored: "fo-b-done" }[item.status] || "fo-b-confirm";
  const p = foPriority(item);

  // mondayItemId means a real Monday item already exists for this card -- true
  // even if its dashboard status got reverted back to active (e.g. via the
  // Handled section's "undo"), so this always wins over the payload check:
  // clicking send-to-monday again would create a genuine duplicate on the board.
  const sendControl = item.mondayItemId
    ? `<span class="fo-muted-label">already sent to Monday (item ${foEscape(item.mondayItemId)})</span>`
    : item.payload
    ? `<button class="fo-primary" onclick="foSendToMonday('${item.id}')">send to monday</button>`
    : `<span class="fo-muted-label">${foEscape(NULL_REASON_LABELS[item.nullReason] || NULL_REASON_LABELS["multi-item"])}</span>`;

  const actions = handled
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
  // Handled list has no such header, so its titles keep the full bracket.
  const title = handled ? (item.title || item.id) : foStripGroupPrefix(item.title || item.id, item.group);

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
    // reassignment/etc) -- reload so the queue re-sorts and re-groups live,
    // without waiting for the next fireflies-monday-watch run. The thread
    // itself is left in foItemChat, so it survives the re-render and Naz can
    // keep editing the same card in the same conversation.
    foLoadQueue();
  } else {
    foRenderChatLog(id);
    input.disabled = false;
    button.disabled = false;
  }
  return false;
}

async function foPatch(id, patch) {
  const res = await fetch("/.netlify/functions/queue", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, patch }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert("Couldn't update it: " + (data.error || `HTTP ${res.status}`));
  }
  foLoadQueue();
}

async function foSendToMonday(id) {
  if (!confirm("This creates a real item on Monday. Go ahead?")) return;
  const res = await fetch("/.netlify/functions/send-to-monday", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id }) });
  const data = await res.json();
  if (data.error) alert("Couldn't send it: " + data.error);
  foLoadQueue();
}

foLoadQueue();
