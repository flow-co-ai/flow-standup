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

async function foLoadQueue() {
  try {
    const res = await fetch("/.netlify/functions/queue", { headers: foHeaders() });
    const data = await res.json();
    const items = data.items || [];
    const el = document.getElementById("fo-queue-cards");
    el.innerHTML = items.length ? items.map(foQueueCard).join("") : `<div class="fo-empty">queue is empty</div>`;
  } catch (e) {
    document.getElementById("fo-queue-cards").innerHTML = `<div class="fo-empty">couldn't reach the draft queue</div>`;
  }
}

function foQueueCard(item) {
  const cls = { ready: "fo-b-ready", confirm: "fo-b-confirm", sent: "fo-b-sent", done: "fo-b-done", ignored: "fo-b-done" }[item.status] || "fo-b-confirm";
  const done = item.status === "done" || item.status === "ignored" || item.status === "sent";
  return `
    <div class="fo-card">
      <div class="fo-row">
        <div>
          <p class="fo-title">${foEscape(item.title || item.id)}</p>
          <p class="fo-sub">${foEscape(item.note || "")}</p>
        </div>
        <span class="fo-badge ${cls}">${foEscape(item.status || "confirm")}</span>
      </div>
      ${done ? "" : `
      <div class="fo-actions">
        <button class="fo-primary" onclick="foSendToMonday('${item.id}')">send to monday</button>
        <button onclick="foPatch('${item.id}', {status:'done'})">mark done</button>
        <button onclick="foPatch('${item.id}', {status:'ignored'})">ignore</button>
      </div>`}
    </div>`;
}

async function foPatch(id, patch) {
  await fetch("/.netlify/functions/queue", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id, patch }) });
  foLoadQueue();
}

async function foSendToMonday(id) {
  if (!confirm("This creates a real item on Monday. Go ahead?")) return;
  const res = await fetch("/.netlify/functions/send-to-monday", { method: "POST", headers: foHeaders(), body: JSON.stringify({ id }) });
  const data = await res.json();
  if (data.error) alert("Couldn't send it: " + data.error);
  foLoadQueue();
}

async function foLoadRundown() {
  try {
    const res = await fetch("/.netlify/functions/rundown", { headers: foHeaders() });
    const data = await res.json();
    document.getElementById("fo-rundown-card").innerHTML = `
      <div class="fo-card">
        <p class="fo-sub">${foEscape(data.date || "no date")}</p>
        <p class="fo-title" style="font-weight:400;white-space:pre-wrap;">${foEscape(data.summary || "")}</p>
      </div>`;
  } catch (e) {
    document.getElementById("fo-rundown-card").innerHTML = `<div class="fo-empty">couldn't reach the rundown</div>`;
  }
}

const foHistory = { queue: [], rundown: [] };

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
foLoadRundown();
