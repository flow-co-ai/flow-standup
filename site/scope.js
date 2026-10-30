/* scope.js — puts "what we do for this client" on the Overview hero.
 *
 * Reads site/contracts.json (written by build_contracts.py) and site/hub.json (for
 * month-to-date spend). Adds a Scope / Numbers toggle to the hero; the choice is
 * remembered per browser. Scope is the default. Nothing here fetches from an API.
 */
(() => {
  "use strict";
  const KEY = "flowops-hero-view";
  const EDIT = "https://github.com/flow-co-ai/flow-standup/edit/main/";
  const NEW = "https://github.com/flow-co-ai/flow-standup/new/main/contracts";
  const DAY = 86400000;
  let DATA = null, HUB = null;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const toDate = (v) => { if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null; const [y, m, d] = v.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  const today = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
  const fmtDay = (d, withYear) => d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  const view = () => { try { return localStorage.getItem(KEY) === "numbers" ? "numbers" : "scope"; } catch { return "scope"; } };
  const setView = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: still toggles for this page */ } };
  const onOverview = () => { const p = new URLSearchParams(location.hash.slice(1)); return !p.get("v") && (!p.get("t") || p.get("t") === "overview"); };
  const clientName = () => { const s = document.getElementById("view"); return s ? s.value : ""; };

  // ── term ───────────────────────────────────────────────────────────────
  function termLine(t) {
    const s = toDate(t.start), e = toDate(t.end), now = today(), out = [];
    if (s && e) out.push(`${fmtDay(s, s.getFullYear() !== e.getFullYear())} → ${fmtDay(e, true)}`);
    else if (s) out.push(`Since ${fmtDay(s, s.getFullYear() !== now.getFullYear())}`);
    if (e) { const n = Math.round((e - now) / DAY); out.push(n >= 0 ? `${n} ${n === 1 ? "day" : "days"} left` : `ended ${-n} days ago`); }
    if (t.note) out.push(esc(t.note));
    return out.join(" · ");
  }

  // ── budget and month-to-date pace ──────────────────────────────────────
  function pace(b, name) {
    const c = HUB && HUB.clients && HUB.clients[name];
    if (!c || !Array.isArray(c.dates) || !c.series) return null;
    const end = toDate((HUB.complete_through || {}).spend) || toDate(c.dates[c.dates.length - 1]);
    if (!end) return null;
    const y = end.getFullYear(), m = end.getMonth(), frac = end.getDate() / new Date(y, m + 1, 0).getDate();
    const total = (key) => {
      const s = c.series[key]; if (!Array.isArray(s) || !s.some((v) => +v)) return null; // never tracked
      let t = 0;
      c.dates.forEach((d, i) => { const x = toDate(d); if (x && x.getFullYear() === y && x.getMonth() === m && x <= end) t += +s[i] || 0; });
      return t;
    };
    const rows = [];
    if (b.google) rows.push(["Google", total("google_spend"), b.google]);
    if (b.meta) rows.push(["Meta", total("meta_spend"), b.meta]);
    if (!rows.length && b.total) rows.push(["All platforms", total("spend"), b.total]);
    const tracked = rows.filter((r) => r[1] != null);
    if (!tracked.length) return { none: true };
    const spent = tracked.reduce((s, r) => s + r[1], 0), budget = tracked.reduce((s, r) => s + r[2], 0), expected = budget * frac;
    const ratio = expected ? spent / expected : 0;
    const [cls, word] = ratio > 1.1 ? ["bad", "over pace"] : ratio < 0.8 ? ["warn", "under pace"] : ["ok", "on pace"];
    const month = end.toLocaleDateString("en-US", { month: "short" });
    return { label: `${month} 1–${end.getDate()}`, spent, expected, cls, word, rows, frac,
      missing: rows.filter((r) => r[1] == null).map((r) => r[0]) };
  }
  function budgetHTML(b, name) {
    const plats = [["google", "Google"], ["meta", "Meta"], ["lsa", "LSA"]].filter(([k]) => b[k]);
    const head = plats.length ? `${plats.map(([k, l]) => `${money(b[k])} ${l}`).join(" + ")} a month`
      : b.total ? `${money(b.total)} a month across platforms` : `<span class="sc-dim">Not set</span>`;
    let html = `<div>${head}</div>`;
    if (plats.length || b.total) {
      const p = pace(b, name);
      if (!p) html += `<div class="sc-pace">No spend data in Windsor for this client yet.</div>`;
      else if (p.none) html += `<div class="sc-pace">This client's ad spend isn't tracked in Windsor yet.</div>`;
      else {
        html += `<div class="sc-pace">${p.label}: ${money(p.spent)} spent, ${money(p.expected)} expected by now · <b class="${p.cls}">${p.word}</b></div>`;
        if (p.rows.length > 1) html += `<div class="sc-sub">${p.rows.filter((r) => r[1] != null).map((r) => `${r[0]} ${money(r[1])} of ${money(r[2] * p.frac)}`).join(" · ")}</div>`;
        if (p.missing.length) html += `<div class="sc-sub">${p.missing.join(", ")} not tracked in Windsor.</div>`;
      }
      if (b.lsa) html += `<div class="sc-sub">LSA spend isn't in Windsor.</div>`;
    }
    if (b.note) html += `<div class="sc-sub">${esc(b.note)}</div>`;
    return html;
  }

  // ── lists ──────────────────────────────────────────────────────────────
  const plainList = (xs) => `<ul class="sc-list">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  function datedList(xs, cls) {
    return `<ul class="sc-list dots ${cls || ""}">${xs.map((x) => {
      const d = toDate(x.date), when = [d ? fmtDay(d) : "", x.source].filter(Boolean).join(" · ");
      return `<li><span>${when ? `<span class="sc-when">${esc(when)}</span>` : ""}${esc(x.text)}</span></li>`;
    }).join("")}</ul>`;
  }
  const row = (label, body, cls) => `<dt class="${cls || ""}">${label}</dt><dd>${body}</dd>`;

  function scopeHTML(name) {
    const c = DATA && DATA.clients && DATA.clients[name];
    if (!c) {
      return `<div class="scope"><div class="sc-kicker">Scope</div><h2 class="sc-title">No scope on file for <em>${esc(name)}</em>.</h2>
        <div class="sc-foot"><a href="${NEW}" target="_blank" rel="noopener">Add a contract file</a> named after the client, with "name": "${esc(name)}".</div></div>`;
    }
    const changed = c.changed || [], shown = changed.slice(0, 3), more = changed.length - shown.length;
    const rev = toDate(c.reviewed_through);
    let rows = row("We run", c.we_run && c.we_run.length ? plainList(c.we_run) : `<span class="sc-dim">Nothing listed</span>`);
    rows += row("Ad budget", budgetHTML(c.budget || {}, name));
    if (c.not_ours && c.not_ours.length) rows += row("Not ours", `<div class="sc-dim">${plainList(c.not_ours)}</div>`);
    if (shown.length) rows += row("Changed", datedList(shown) + (more > 0 ? `<div class="sc-sub">${more} older ${more === 1 ? "change" : "changes"} in the contract file.</div>` : ""));
    if (c.unclear && c.unclear.length) rows += row("Unclear", datedList(c.unclear, "warn"), "warn");
    if (c.heard && c.heard.length) rows += row("Heard since review", datedList(c.heard, "grey") + `<div class="sc-sub">Picked up from chats and calls. Not applied until someone updates the contract.</div>`);
    return `<div class="scope">
      <div class="sc-kicker">Scope</div>
      <h2 class="sc-title">What we do for <em>${esc(name)}</em></h2>
      ${c.term ? `<div class="sc-term">${termLine(c.term)}</div>` : ""}
      <dl class="sc-rows">${rows}</dl>
      <div class="sc-foot">${rev ? `Reviewed through ${fmtDay(rev, true)} against the playbook, WhatsApp and calls. ` : ""}<a href="${EDIT}${esc(c.edit_path)}" target="_blank" rel="noopener">Edit scope</a></div>
    </div>`;
  }

  // ── mount ──────────────────────────────────────────────────────────────
  function apply() {
    const body = document.getElementById("view-body");
    const hero = body && body.querySelector(".hero");
    const inner = hero && hero.querySelector(".hero-in");
    if (!inner || !onOverview()) return;
    const name = clientName(); if (!name) return;
    inner.querySelectorAll(":scope > .sc-toggle, :scope > .scope").forEach((n) => n.remove());
    const v = view();
    hero.classList.add("has-sc");
    hero.classList.toggle("scope-on", v === "scope");
    inner.insertAdjacentHTML("afterbegin", `<div class="sc-toggle" role="group" aria-label="Hero view">
      <button type="button" data-sc="scope" aria-pressed="${v === "scope"}">Scope</button>
      <button type="button" data-sc="numbers" aria-pressed="${v === "numbers"}">Numbers</button></div>`);
    if (v === "scope") inner.insertAdjacentHTML("beforeend", DATA ? scopeHTML(name) : `<div class="scope"><div class="sc-kicker">Scope</div><div class="sc-term">Loading scope…</div></div>`);
  }

  const css = `
.hero.has-sc .hero-in>h1{padding-right:200px}
.sc-toggle{position:absolute;top:22px;right:26px;z-index:2;display:flex;gap:2px;padding:3px;border:1px solid var(--hero-line);border-radius:999px;background:rgba(255,255,255,.04)}
.sc-toggle button{border:0;background:none;color:var(--hero-muted);font-size:13.5px;font-weight:600;padding:6px 14px;border-radius:999px;cursor:pointer}
.sc-toggle button:hover{color:#fff}
.sc-toggle button[aria-pressed="true"]{background:#f1f1ee;color:#18191a}
.sc-toggle button:focus-visible{outline:2px solid var(--green-on-dark);outline-offset:2px}
.hero.scope-on .hero-in>h1,.hero.scope-on .hero-in>.bul{display:none}
.scope{max-width:1080px}
.sc-kicker{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--green-on-dark)}
.sc-title{font:700 42px/1.1 "Inter Tight",Inter,sans-serif;letter-spacing:-.03em;margin:8px 0 0;padding-right:200px;color:#fff}
.sc-title em{font-style:normal;color:var(--green-on-dark)}
.sc-term{margin-top:10px;font-size:16px;color:var(--hero-muted)}
.sc-rows{display:grid;grid-template-columns:170px minmax(0,1fr);margin:26px 0 0;border-top:1px solid var(--hero-line)}
.sc-rows dt{padding:15px 18px 15px 0;border-bottom:1px solid var(--hero-line);font-size:13px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--hero-muted)}
.sc-rows dt.warn{color:var(--amber)}
.sc-rows dd{margin:0;padding:12px 0;border-bottom:1px solid var(--hero-line);font-size:17px;line-height:1.5;color:#e6e7e2}
.sc-list{list-style:none;margin:0;padding:0}
.sc-list li{padding:2px 0}
.sc-list.dots li{display:flex;gap:12px;align-items:baseline}
.sc-list.dots li::before{content:"";flex:0 0 8px;height:8px;border-radius:50%;background:var(--green-on-dark);transform:translateY(-1px)}
.sc-list.warn li::before{background:var(--amber)}
.sc-list.grey li::before{background:#6f7268}
.sc-when{margin-right:8px;font-size:14px;color:var(--hero-muted);white-space:nowrap}
.sc-dim{color:#c3c5bd}
.sc-pace{margin-top:4px;font-size:15px;color:var(--hero-muted)}
.sc-pace b{font-weight:600}.sc-pace b.ok{color:var(--green-on-dark)}.sc-pace b.warn{color:var(--amber)}.sc-pace b.bad{color:#ff8a7f}
.sc-sub{margin-top:3px;font-size:14px;color:var(--hero-muted)}
.sc-foot{margin-top:16px;font-size:14px;color:var(--hero-muted)}
.sc-foot a{color:var(--green-on-dark);text-decoration:none}.sc-foot a:hover{text-decoration:underline}
@media (max-width:860px){
  .hero.has-sc .hero-in>h1,.sc-title{padding-right:0}
  .sc-toggle{position:static;display:inline-flex;margin:0 0 18px}
  .sc-title{font-size:28px}
  .sc-rows{grid-template-columns:1fr}
  .sc-rows dt{padding:14px 0 2px;border-bottom:0}
  .sc-rows dd{padding:0 0 14px;font-size:15.5px}
  .sc-when{display:block;white-space:normal}
}`;

  document.head.insertAdjacentHTML("beforeend", `<style id="scope-css">${css}</style>`);
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".sc-toggle button[data-sc]"); if (!b) return;
    setView(b.dataset.sc); apply();
  });
  const body = document.getElementById("view-body");
  if (body) new MutationObserver(apply).observe(body, { childList: true });

  const get = (p) => fetch(p, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([get("contracts.json"), get("hub.json")]).then(([c, h]) => {
    DATA = c || { clients: {} }; HUB = h; apply();
  });
})();
