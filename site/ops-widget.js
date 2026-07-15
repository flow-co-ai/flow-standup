// Global "Ask Flow Ops" floating chat widget -- the single shared include
// both daily.html and index.html load. Builds its own bubble + panel and
// appends them to <body> on load, so it never disturbs either page's
// existing layout. Talks to netlify/functions/ops-chat.js.
(function () {
  // Same localStorage key addon.js's FO_PASSCODE() uses, so Naz isn't
  // prompted twice for the same passcode on daily.html.
  function ocPasscode() {
    let p = localStorage.getItem("flowops-passcode");
    if (!p) {
      p = prompt("Ops passcode");
      if (p) localStorage.setItem("flowops-passcode", p);
    }
    return p || "";
  }
  function ocHeaders() {
    return { "content-type": "application/json", "X-Ops-Key": ocPasscode() };
  }
  function ocEscape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // In-memory only -- resets on page reload/navigation, same as item-chat's
  // per-card threads. Not persisted; kept simple on purpose.
  const ocHistory = [];

  function build() {
    const bubble = document.createElement("button");
    bubble.className = "oc-bubble";
    bubble.type = "button";
    bubble.setAttribute("aria-label", "Open Ask Flow Ops");
    bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

    const panel = document.createElement("div");
    panel.className = "oc-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="oc-header">
        <div>
          <div class="oc-title">Ask Flow Ops</div>
          <div class="oc-title-sub">Monday + Daily Ops, live</div>
        </div>
        <button type="button" class="oc-close" aria-label="Close">&times;</button>
      </div>
      <div class="oc-log"></div>
      <form class="oc-form">
        <input type="text" placeholder="Ask about anything, or draft a new item..." />
        <button type="submit">Send</button>
      </form>`;

    document.body.appendChild(bubble);
    document.body.appendChild(panel);

    const log = panel.querySelector(".oc-log");
    const form = panel.querySelector("form");
    const input = form.querySelector("input");
    const button = form.querySelector("button");
    const closeBtn = panel.querySelector(".oc-close");

    function render(thinking) {
      log.innerHTML = ocHistory.map((m) => `<div class="oc-msg ${m.role}">${ocEscape(m.content)}</div>`).join("")
        + (thinking ? `<div class="oc-msg assistant thinking">thinking…</div>` : "");
      log.scrollTop = log.scrollHeight;
    }

    bubble.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        render();
        input.focus();
      }
    });
    closeBtn.addEventListener("click", () => {
      panel.hidden = true;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const message = input.value.trim();
      if (!message) return;

      // Prior turns only -- the new message is sent separately, matching the
      // {id, message, history} convention item-chat.js's frontend already uses.
      const priorHistory = ocHistory.filter((m) => m.role === "user" || m.role === "assistant");

      input.value = "";
      input.disabled = true;
      button.disabled = true;
      ocHistory.push({ role: "user", content: message });
      render(true);

      let res;
      try {
        res = await fetch("/.netlify/functions/ops-chat", {
          method: "POST",
          headers: ocHeaders(),
          body: JSON.stringify({ message, history: priorHistory }),
        });
      } catch (err) {
        ocHistory.push({ role: "error", content: "error: " + err.message });
        render();
        input.disabled = false;
        button.disabled = false;
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        ocHistory.push({ role: "error", content: "error: " + (data.error || `HTTP ${res.status}`) });
      } else {
        ocHistory.push({ role: "assistant", content: data.reply || "(no reply)" });
      }
      render();
      input.disabled = false;
      button.disabled = false;
      input.focus();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
