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

function foGroupByClient(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.group || "n/a";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  // Most items needing attention first, so Naz sees the busiest client at the top.
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function foRenderQueue(active, handled) {
  const activeHtml = active.length
    ? foGroupByClient(active).map(([client, items]) => `
      <div class="fo-group">
        <div class="fo-group-header">${foEscape(client)} <span class="fo-group-count">(${items.length})</span></div>
        ${items.map(item => foQueueCard(item, false)).join("")}
      </div>`).join("")
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

  const sendControl = item.payload
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

  // status "confirm" == content-conflict/no-payload-yet: let Naz answer inline
  // instead of routing him through /monday-task for a single-line decision.
  const clarifyBox = !handled && item.status === "confirm"
    ? `<form class="fo-clarify" onsubmit="return foSubmitClarify(event, '${item.id}')">
        <input type="text" placeholder="Answer here to unblock this draft" />
        <button type="submit">Send</button>
      </form>`
    : "";

  return `
    <div class="fo-card">
      <div class="fo-row">
        <div>
          <p class="fo-title">${foEscape(title)}</p>
          <p class="fo-sub">${foEscape(item.note || "")}</p>
          ${item.sourceLabel ? `<p class="fo-source">${foEscape(item.sourceLabel)}</p>` : ""}
        </div>
        <span class="fo-badge ${cls}">${foEscape(item.status || "confirm")}</span>
      </div>
      ${actions}
      ${clarifyBox}
    </div>`;
}

async function foSubmitClarify(e, id) {
  e.preventDefault();
  const form = e.target;
  const input = form.querySelector("input");
  const message = input.value.trim();
  if (!message) return false;

  const res = await fetch("/api/clarify", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, message }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    alert("Couldn't submit that: " + (data.error || `HTTP ${res.status}`));
    return false;
  }
  form.outerHTML = `<p class="fo-clarify-done">got it — will finalize on next check.</p>`;
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
