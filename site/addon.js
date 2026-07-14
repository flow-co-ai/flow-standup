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

function foRenderQueue(active, handled) {
  const activeHtml = active.length
    ? active.map(item => foQueueCard(item, false)).join("")
    : `<div class="fo-empty">queue is empty</div>`;

  const handledHtml = `
    <div class="fo-handled">
      <button class="fo-handled-toggle" onclick="foToggleHandled()">
        ${foHandledExpanded ? "▾" : "▸"} handled (${handled.length})
      </button>
      <div class="fo-handled-list" ${foHandledExpanded ? "" : "hidden"}>
        ${handled.length ? handled.map(item => foQueueCard(item, true)).join("") : `<div class="fo-empty">nothing handled yet</div>`}
      </div>
    </div>`;

  return activeHtml + handledHtml;
}

function foToggleHandled() {
  foHandledExpanded = !foHandledExpanded;
  foLoadQueue();
}

function foQueueCard(item, handled) {
  const cls = { ready: "fo-b-ready", confirm: "fo-b-confirm", sent: "fo-b-sent", done: "fo-b-done", ignored: "fo-b-done" }[item.status] || "fo-b-confirm";

  const sendControl = item.payload
    ? `<button class="fo-primary" onclick="foSendToMonday('${item.id}')">send to monday</button>`
    : `<span class="fo-muted-label">needs /monday-task (multi-item)</span>`;

  const actions = handled
    ? `<div class="fo-actions">
        <button onclick="foPatch('${item.id}', {status:'confirm'})">undo</button>
      </div>`
    : `<div class="fo-actions">
        ${sendControl}
        <button onclick="foPatch('${item.id}', {status:'done'})">mark done</button>
        <button onclick="foPatch('${item.id}', {status:'ignored'})">ignore</button>
      </div>`;

  return `
    <div class="fo-card">
      <div class="fo-row">
        <div>
          <p class="fo-title">${foEscape(item.title || item.id)}</p>
          <p class="fo-sub">${foEscape(item.note || "")}</p>
          ${item.sourceLabel ? `<p class="fo-source">${foEscape(item.sourceLabel)}</p>` : ""}
        </div>
        <span class="fo-badge ${cls}">${foEscape(item.status || "confirm")}</span>
      </div>
      ${actions}
    </div>`;
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

const foHistory = { queue: [] };

async function foSendChat(e, topic) {
  e.preventDefault();
  const input = document.getElementById(`fo-${topic}-input`);
  const text = input.value.trim();
  if (!text) return false;
  input.value = "";
  const log = document.getElementById(`fo-${topic}-log`);
  log.insertAdjacentHTML("beforeend", `<div class="fo-msg user">${foEscape(text)}</div>`);

  foHistory[topic].push({ role: "user", content: text });
  const res = await fetch("/.netlify/functions/chat", {
    method: "POST",
    headers: foHeaders(),
    body: JSON.stringify({ topic, messages: foHistory[topic] }),
  });
  const data = await res.json();
  if (data.error) {
    log.insertAdjacentHTML("beforeend", `<div class="fo-msg assistant">error: ${foEscape(JSON.stringify(data.error))}</div>`);
  } else {
    log.insertAdjacentHTML("beforeend", `<div class="fo-msg assistant">${foEscape(data.reply)}</div>`);
    foHistory[topic].push({ role: "assistant", content: data.reply });
    foLoadQueue();
  }
  log.scrollTop = log.scrollHeight;
  return false;
}

foLoadQueue();
