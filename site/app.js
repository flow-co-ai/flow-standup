/* app.js — Flow Ops dashboard
 *
 * Persistence model:
 *   READ  — public GitHub raw URL, no auth needed
 *   WRITE — /.netlify/functions/save-checks, requires X-Ops-Key passcode
 *   LOCAL — localStorage mirror used when the network read fails (offline)
 *
 * Checks are stored as { rowId: true } (only checked rows kept).
 * Each week gets its own file: checks/{week_of}.json on the "state" branch.
 */

// ── constants ─────────────────────────────────────────────────────────────────

const HEALTH = {
  on_track: {
    label: 'On track',
    accent: '#8CBE6E',
    chipBorder: 'rgba(140,190,110,0.35)',
    chipBg: 'rgba(140,190,110,0.08)',
    glow: 'rgba(140,190,110,0.3)',
  },
  needs_attention: {
    label: 'Needs attention',
    accent: '#DCA746',
    chipBorder: 'rgba(220,167,70,0.35)',
    chipBg: 'rgba(220,167,70,0.08)',
    glow: 'rgba(220,167,70,0.3)',
  },
  at_risk: {
    label: 'At risk',
    accent: '#DE6E4C',
    chipBorder: 'rgba(222,110,76,0.4)',
    chipBg: 'rgba(222,110,76,0.1)',
    glow: 'rgba(222,110,76,0.32)',
  },
};

const SOURCE_TAG   = { monday: 'MON', meeting: 'MTG', whatsapp: 'WA' };
const STALE_DAYS   = 8;
const REPO_OWNER   = 'flow-co-ai';
const REPO_NAME    = 'flow-standup';

const KEY_PASSCODE = 'flowops-passcode';
const localChecksKey = (weekOf) => `flowops-v4-${weekOf}`;
const KEY_DISMISSED_ALERTS = 'flowops-dismissed-alerts';

// ── state ─────────────────────────────────────────────────────────────────────

let standup   = null;
let handled   = {};       // { rowId: true }  — only checked rows stored
let copiedId  = null;
let copyTimer = null;
let saveTimer = null;
let historyWeekExpanded = {}; // { `${clientName}::${isoWeek}`: true } — collapsed-by-default per card per week
let dismissedAlerts   = loadDismissedAlerts(); // Set of alert keys already seen

// ── card overrides (manual reorder / hide / rename / edit / add) ─────────────
//
// latest.json is 100% regenerated from scratch every pipeline run — there's
// no field in it a manual edit could survive being overwritten in. This is
// the same pattern as `handled` above (a separate file on the state branch,
// merged in at render time) but persistent across weeks rather than reset
// each week, since a hide/rename is meant to stick.
let standupOverrides = { overrides: {}, manualProspects: [] };
let dragKey = null; // _key of whichever mini-card is currently mid-drag (one grid at a time)
let hiddenClientsExpanded = false;
let hiddenProspectsExpanded = false;
let showAddProspectForm = false;

// ── view routing (grid <-> client detail via location.hash) ──────────────────

function currentClientView() {
  const m = location.hash.match(/^#c=(.+)$/);
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  if (name === 'Unmapped') return null; // never a real client card -- see the grid-view guard below
  const exists = (standup?.by_client || []).some(c => c.client === name);
  return exists ? name : null;
}

function openClient(name) {
  location.hash = `c=${encodeURIComponent(name)}`;
}

function currentProspectView() {
  const m = location.hash.match(/^#p=(.+)$/);
  if (!m) return null;
  const key = decodeURIComponent(m[1]);
  // Routes on _key (prospect:<name> / manual-<n>), not raw name -- a manual
  // prospect has no entry in standup.potential_clients to look a name up
  // against at all, so _key is the only identity that works for both.
  const exists = effectiveProspects().some(p => p._key === key);
  return exists ? key : null;
}

function openProspect(key) {
  location.hash = `p=${encodeURIComponent(key)}`;
}

function backToGrid() {
  // Prefer history.back() when the grid is in history (keeps back-gesture natural)
  if (location.hash) history.back(); else render();
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ── persistence layer ─────────────────────────────────────────────────────────

// --- localStorage (offline mirror) -------------------------------------------

function loadLocal() {
  if (!standup?.week_of) return;
  try { handled = JSON.parse(localStorage.getItem(localChecksKey(standup.week_of)) || '{}'); }
  catch { handled = {}; }
}

function saveLocal() {
  if (!standup?.week_of) return;
  try { localStorage.setItem(localChecksKey(standup.week_of), JSON.stringify(handled)); } catch {}
}

// --- passcode -----------------------------------------------------------------

function getPasscode()        { return localStorage.getItem(KEY_PASSCODE) || null; }
function storePasscode(p)     { localStorage.setItem(KEY_PASSCODE, p); }
function clearStoredPasscode(){ localStorage.removeItem(KEY_PASSCODE); }

// --- dismissed auto-completed alerts (localStorage) ---------------------------

function loadDismissedAlerts() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY_DISMISSED_ALERTS) || '[]')); }
  catch { return new Set(); }
}
function saveDismissedAlerts(set) {
  try { localStorage.setItem(KEY_DISMISSED_ALERTS, JSON.stringify([...set])); } catch {}
}
// item+board+timestamp is stable across reloads and unique per real alert —
// dismissing marks exactly the alerts shown at dismiss time, so a NEW alert
// added later (different timestamp) still brings the banner back.
function alertKey(a) { return `${a.item}|${a.board}|${a.timestamp}`; }

// --- remote read (public, no auth) -------------------------------------------

async function loadRemoteChecks() {
  if (!standup?.week_of) return;
  const url =
    `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}` +
    `/refs/heads/state/checks/${standup.week_of}.json?t=${Date.now()}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) return;   // fresh week — all unchecked
    if (!res.ok)            return;   // silently fall back to local
    const remote = await res.json();
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      handled = remote;
      saveLocal(); // keep local mirror in sync
      render();
    }
  } catch { /* network error — local mirror already loaded */ }
}

// --- card overrides: read + merge (public, no auth) --------------------------
//
// Not week-scoped like checks/<week>.json above -- a hide/rename/reorder is
// meant to survive into next week's regenerated latest.json, so this is one
// evergreen file rather than one per week.

async function loadRemoteStandupOverrides() {
  const url =
    `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}` +
    `/refs/heads/state/checks/standup-overrides.json?t=${Date.now()}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) return;   // nothing overridden yet
    if (!res.ok)            return;   // silently fall back to un-overridden
    const remote = await res.json();
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      standupOverrides = { overrides: remote.overrides || {}, manualProspects: remote.manualProspects || [] };
      render();
    }
  } catch { /* network error — grid renders un-overridden until next load */ }
}

function clientKey(name)   { return `client:${name}`; }
function prospectKey(name) { return `prospect:${name}`; }

// Attaches { key, ov, rank, naturalIndex } to each item and sorts by rank
// (explicit rank always wins; anything never dragged keeps its original
// pipeline order, appended after everything that HAS been ranked — see
// reorderKeys, which always submits the full grid's current key order, so
// the instant any one card in a grid is dragged, every card in that grid
// becomes ranked at once and this ambiguity stops applying to it).
function sortByOverride(items, keyFn) {
  const overrides = standupOverrides.overrides || {};
  return items
    .map((item, i) => {
      const key = keyFn(item);
      const ov = overrides[key] || {};
      return { item, key, ov, rank: Number.isFinite(ov.rank) ? ov.rank : Infinity, naturalIndex: i };
    })
    .sort((a, b) => (a.rank - b.rank) || (a.naturalIndex - b.naturalIndex));
}

// displayName is purely cosmetic (grid card + detail header) -- item.client
// itself is left untouched everywhere else (hash routing via openClient/
// currentClientView, and findPriorityForClient's matching in buildCard),
// since that's the real Monday/roster identity, not something a rename
// should ever affect.
function effectiveByClient() {
  const items = (standup?.by_client || []).filter(e => e.client !== 'Unmapped');
  return sortByOverride(items, e => clientKey(e.client))
    .filter(({ ov }) => !ov.hidden)
    .map(({ item, key, ov }) => ({ ...item, _key: key, displayName: ov.name ?? item.client, headline: ov.headline ?? item.headline }));
}

function hiddenClients() {
  const items = (standup?.by_client || []).filter(e => e.client !== 'Unmapped');
  return sortByOverride(items, e => clientKey(e.client))
    .filter(({ ov }) => ov.hidden)
    .map(({ item, key, ov }) => ({ ...item, _key: key, displayName: ov.name ?? item.client, headline: ov.headline ?? item.headline }));
}

// Manual prospects are mapped into the exact same shape as a generated
// potential_clients entry (empty items/action_items, null likelihood) so
// buildPotentialCard/buildPotentialCardDetail render them with no special
// casing at all.
function allProspectsRaw() {
  const generated = (standup?.potential_clients || []).map(p => ({ ...p, _key: prospectKey(p.name) }));
  const manual = (standupOverrides.manualProspects || []).map(p => ({
    name: p.name, summary: p.summary, items: [], action_items: [], likelihood_percent: null,
    _key: p.id, _manual: true,
  }));
  return [...generated, ...manual];
}

function effectiveProspects() {
  return sortByOverride(allProspectsRaw(), p => p._key)
    .filter(({ ov }) => !ov.hidden)
    .map(({ item, key, ov }) => ({ ...item, _key: key, name: ov.name ?? item.name, summary: ov.summary ?? item.summary }));
}

function hiddenProspects() {
  return sortByOverride(allProspectsRaw(), p => p._key)
    .filter(({ ov }) => ov.hidden)
    .map(({ item, key, ov }) => ({ ...item, _key: key, name: ov.name ?? item.name, summary: ov.summary ?? item.summary }));
}

// --- card overrides: write (requires passcode) --------------------------------
//
// Same optimistic-then-reconcile-or-revert shape as toggleHandled/doSave
// above: apply the guessed result locally and re-render immediately (a drag
// that visibly lags until a GitHub commit round-trips would feel broken),
// then either reconcile with the server's real response or roll back.

// Every write funnels through this one chain, in the order applyOverride()
// was CALLED -- not the order their network requests happen to complete in.
// Without this, two edits fired close together (e.g. rename a card, then
// immediately rename it again) race: both POSTs can be in flight at once,
// and updateJSON's retry-on-409 on the backend only guarantees each
// individual write eventually lands, not that they land in the right
// ORDER -- whichever request's GitHub commit happens to finish last wins,
// which is not necessarily the edit the user made last. Serializing here
// (not just retrying on the backend) is the same fix as Daily Ops' foPending
// guard on the priority buttons, just as a queue instead of a block, since a
// card's optimistic UI should still update instantly rather than waiting.
let overridesWriteChain = Promise.resolve();

function applyOverride(action, payload, optimisticApply) {
  const previous = standupOverrides;
  standupOverrides = optimisticApply({
    overrides: { ...previous.overrides },
    manualProspects: previous.manualProspects.map(p => ({ ...p })),
  });
  render(); // optimistic feedback fires immediately, never queued

  const task = () => sendOverrideWrite(action, payload, previous);
  overridesWriteChain = overridesWriteChain.then(task, task); // keep the chain alive even if a write throws/reverts
  return overridesWriteChain;
}

async function sendOverrideWrite(action, payload, previous) {
  const passcode = getPasscode();
  if (!passcode) {
    standupOverrides = previous;
    render();
    showPasscodePrompt();
    return;
  }

  try {
    const res = await fetch('/.netlify/functions/standup-overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ops-Key': passcode },
      body: JSON.stringify({ action, ...payload }),
    });
    if (res.status === 401) {
      standupOverrides = previous;
      render();
      clearStoredPasscode();
      showPasscodePrompt();
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      standupOverrides = previous;
      render();
      alert('Could not save: ' + (data.error || `HTTP ${res.status}`));
      return;
    }
    standupOverrides = { overrides: data.overrides || {}, manualProspects: data.manualProspects || [] };
    render();
  } catch (err) {
    standupOverrides = previous;
    render();
    alert('Network error: ' + err.message);
  }
}

function reorderKeys(order) {
  applyOverride('reorder', { order }, (ov) => {
    order.forEach((key, i) => { ov.overrides[key] = { ...(ov.overrides[key] || {}), rank: i }; });
    return ov;
  });
}

function hideCard(key) {
  applyOverride('hide', { key }, (ov) => {
    ov.overrides[key] = { ...(ov.overrides[key] || {}), hidden: true };
    return ov;
  });
}

function unhideCard(key) {
  applyOverride('unhide', { key }, (ov) => {
    ov.overrides[key] = { ...(ov.overrides[key] || {}), hidden: false };
    return ov;
  });
}

function addProspect(name, summary) {
  applyOverride('addProspect', { name, summary }, (ov) => {
    // Temp id, just for the optimistic render -- the reconciled server
    // response (the real manualProspects, with the real id) replaces it a
    // moment later.
    ov.manualProspects.push({ id: `manual-pending-${ov.manualProspects.length}`, name, summary, createdAt: null });
    return ov;
  });
}

// field is 'headline' (clients) or 'name'/'summary' (prospects). Manual
// prospects' name/summary IS their base content (edited in place on
// manualProspects); everything else is an override layered onto generated
// content (edited into overrides[key]) -- mirrors the same split in
// standup-overrides.js's own edit handler.
function saveCardEdit(key, field, next) {
  applyOverride('edit', { key, patch: { [field]: next } }, (ov) => {
    if (key.startsWith('manual-')) {
      const idx = ov.manualProspects.findIndex(p => p.id === key);
      if (idx !== -1) ov.manualProspects[idx] = { ...ov.manualProspects[idx], [field]: next };
    } else {
      ov.overrides[key] = { ...(ov.overrides[key] || {}), [field]: next };
    }
    return ov;
  });
}

// Shared by every contenteditable card field below. Enter saves (blurs,
// which triggers the real save); Escape reverts to the last-saved text
// without writing anything -- same UX as Daily Ops' inline title/note edit.
function editableCardKeydown(e) {
  e.stopPropagation(); // the card itself is a role="button" click/keydown target -- Enter here must NOT also navigate
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.target.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.target.textContent = e.target.dataset.original || '';
    e.target.blur();
  }
}

function onCardFieldBlur(e, key, field, allowEmpty) {
  const next = e.target.textContent.trim();
  const original = e.target.dataset.original || '';
  if (!allowEmpty && !next) { e.target.textContent = original; return; }
  if (next === original) return;
  saveCardEdit(key, field, next);
}

// --- remote write (requires passcode) ----------------------------------------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 2000);
}

async function doSave() {
  const passcode = getPasscode();
  if (!passcode) {
    showPasscodePrompt();
    return;
  }

  setSyncStatus('saving');

  try {
    const res = await fetch('/.netlify/functions/save-checks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Key': passcode,
      },
      body: JSON.stringify({ week_of: standup.week_of, checks: handled }),
    });

    if (res.status === 401) {
      clearStoredPasscode();
      setSyncStatus('failed');
      showPasscodePrompt();
      return;
    }

    if (!res.ok) {
      setSyncStatus('failed');
      return;
    }

    setSyncStatus('saved');
  } catch {
    // Network error — local state is safe; retry on next toggle
    setSyncStatus('failed');
  }
}

// --- toggle ------------------------------------------------------------------

function toggleHandled(id) {
  if (handled[id]) delete handled[id]; else handled[id] = true;
  saveLocal();
  render();
  scheduleSave(); // doSave will show passcode prompt if needed
}

// ── sync status indicator ─────────────────────────────────────────────────────

let fadeTimer = null;

function setSyncStatus(status) {
  const el_ = document.getElementById('sync-status');
  if (!el_) return;
  clearTimeout(fadeTimer);

  const config = {
    saving: { text: '· syncing…',    color: 'rgba(169,180,120,0.55)' },
    saved:  { text: '· synced',      color: 'rgba(169,180,120,0.35)' },
    failed: { text: '· sync failed', color: 'rgba(220,167,70,0.75)'  },
  }[status];

  if (!config) { el_.hidden = true; return; }

  el_.textContent = config.text;
  el_.style.color = config.color;
  el_.hidden = false;

  if (status === 'saved') {
    fadeTimer = setTimeout(() => { el_.hidden = true; }, 3500);
  }
}

// ── passcode prompt ───────────────────────────────────────────────────────────

let promptBar = null;

function showPasscodePrompt() {
  if (promptBar) { promptBar.hidden = false; focusPasscodeInput(); return; }

  promptBar = el('div', { class: 'passcode-bar', role: 'dialog', 'aria-label': 'Enter ops passcode to sync' },
    el('form', { class: 'passcode-form', onsubmit: onPasscodeSubmit },
      el('label', { class: 'passcode-label', for: 'passcode-input', text: 'Sync passcode' }),
      el('input', {
        id: 'passcode-input',
        class: 'passcode-input',
        type: 'password',
        placeholder: 'enter passcode…',
        autocomplete: 'current-password',
        required: '',
      }),
      el('button', { class: 'passcode-submit', type: 'submit', text: 'Sync' }),
      el('button', {
        class: 'passcode-dismiss',
        type: 'button',
        'aria-label': 'Dismiss',
        html: '&#10005;',
        onclick: () => { promptBar.hidden = true; },
      }),
    ),
  );

  document.body.append(promptBar);
  focusPasscodeInput();
}

function focusPasscodeInput() {
  setTimeout(() => document.getElementById('passcode-input')?.focus(), 80);
}

function onPasscodeSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('passcode-input');
  const val   = (input?.value || '').trim();
  if (!val) return;
  storePasscode(val);
  if (input) input.value = '';
  promptBar.hidden = true;
  // Trigger the pending save immediately (skip debounce)
  clearTimeout(saveTimer);
  doSave();
}

// ── refresh standup (manual workflow_dispatch trigger) ────────────────────────

const REFRESH_DEBOUNCE_MS = 60_000; // floor on real re-triggers, independent of the button's own disabled state
let refreshDebounceUntil = 0;

function initRefreshStandupButton() {
  const btn = document.getElementById('refresh-standup-btn');
  if (!btn) return;
  const labelEl = btn.querySelector('.refresh-label');
  const errEl   = document.getElementById('refresh-standup-error');

  const showRefreshError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
  const clearRefreshError = () => { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } };

  btn.addEventListener('click', async () => {
    // Real re-trigger floor: even though the button re-enables after ~5s
    // (below), an actual new dispatch is blocked for the full 60s so a burst
    // of clicks can't queue duplicate runs back to back.
    if (Date.now() < refreshDebounceUntil) {
      const secsLeft = Math.ceil((refreshDebounceUntil - Date.now()) / 1000);
      showRefreshError(`Already triggered — wait ${secsLeft}s before triggering again.`);
      return;
    }

    const passcode = getPasscode();
    if (!passcode) {
      showPasscodePrompt();
      return;
    }

    clearRefreshError();
    btn.disabled = true;
    btn.classList.add('is-loading');
    if (labelEl) labelEl.textContent = 'Triggering...';

    let res;
    try {
      res = await fetch('/.netlify/functions/refresh-standup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ops-Key': passcode },
      });
    } catch (err) {
      btn.classList.remove('is-loading');
      btn.disabled = false;
      showRefreshError('Network error: ' + err.message);
      return;
    }

    const data = await res.json().catch(() => ({}));
    btn.classList.remove('is-loading');

    if (!data.ok) {
      btn.disabled = false;
      showRefreshError(data.error || `Couldn't trigger (HTTP ${res.status})`);
      // Distinguish our own passcode gate (data.error === 'unauthorized')
      // from a GitHub-side auth failure (different message, e.g. bad token
      // scope) -- only the former means the STORED passcode itself is wrong.
      if (res.status === 401 && data.error === 'unauthorized') {
        clearStoredPasscode();
        showPasscodePrompt();
      }
      return;
    }

    // Per-client Claude calls now run in parallel (generate.py) instead of
    // sequentially -- measured real runs dropped from ~2-2.5min to ~1.2-1.4min.
    if (labelEl) labelEl.textContent = 'Triggered — takes ~1-2 min, refresh the page after';
    refreshDebounceUntil = Date.now() + REFRESH_DEBOUNCE_MS;
    setTimeout(() => {
      btn.disabled = false;
      if (labelEl) labelEl.textContent = 'Refresh Standup';
    }, 5000);
  });
}

// ── clipboard ─────────────────────────────────────────────────────────────────

function copyText(id, text) {
  const done = () => {
    copiedId = id;
    render();
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedId = null; render(); }, 1800);
  };
  const fallback = () => {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    Object.assign(ta.style, { position: 'fixed', opacity: '0' });
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { fallback(); done(); });
  } else { fallback(); done(); }
}

// ── minimal DOM builder ───────────────────────────────────────────────────────

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if      (k === 'class')                                    e.className = v;
    else if (k === 'text')                                     e.textContent = v;
    else if (k === 'html')                                     e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function')    e[k] = v;
    else if (k === 'style'      && typeof v === 'object')      Object.assign(e.style, v);
    else                                                       e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

// ── checkbox builder ──────────────────────────────────────────────────────────

function isHandled(id) { return !!handled[id]; }

function buildCheckbox(id, isStalled) {
  const checked = isHandled(id);
  const inner = el('span', {
    class: `checkbox-inner${checked ? ' checked' : ''}`,
    html: checked ? '&#10003;' : '',
  });
  const wrap = el('span', {
    class: `row-checkbox${isStalled ? ' stalled-checkbox' : ''}`,
    role: 'button',
    tabindex: '0',
    'aria-label': 'Mark handled',
    onclick: () => toggleHandled(id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHandled(id); } },
  }, inner);
  return wrap;
}

// ── row builder ───────────────────────────────────────────────────────────────

function buildRow(item, isStalled) {
  if (!item || typeof item !== 'object') return null;
  const { id, text, source, monday_url: url, item_name, days_stalled } = item;
  const tag = SOURCE_TAG[source] || '';

  const textSpan = el('span', { class: 'row-text', text });

  const metaEls = [];
  if (isStalled && days_stalled != null) {
    metaEls.push(el('span', { class: 'days-badge', text: `${days_stalled}d` }));
  }
  if (tag) metaEls.push(el('span', { class: 'source-chip', text: tag }));

  let rightEl;
  if (url) {
    rightEl = el('a', {
      href: url,
      target: '_blank',
      rel: 'noopener',
      title: item_name || 'Open in Monday.com',
      class: 'row-right row-link',
      onclick: (e) => e.stopPropagation(),
    }, ...metaEls, el('span', { class: 'chevron', html: '&#8599;' }));
  } else {
    rightEl = el('span', { class: 'row-right' }, ...metaEls);
  }

  const rowContent = el('div', {
    class: isStalled ? 'stalled-row' : 'highlight-row',
  }, textSpan, rightEl);

  return el('div', { class: 'row-wrapper no-checkbox' }, rowContent);
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parses a plain "YYYY-MM-DD" (or "YYYY-MM-DDT...") string into "Jul 11"
// without ever constructing a Date object -- `new Date("2026-07-11")` parses
// as UTC midnight, which `toLocaleDateString` then renders as the day BEFORE
// in any timezone behind UTC (all of the Americas). Plain string slicing
// keeps this exactly the calendar date the pipeline recorded.
function formatShortDate(isoDateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDateStr || '');
  if (!m) return '';
  const month = SHORT_MONTHS[parseInt(m[2], 10) - 1];
  if (!month) return '';
  return `${month} ${parseInt(m[3], 10)}`;
}

// completed_this_week / completed_history[].items rows: {text, who, source, date, generated, monday_url}.
// source here is already the short tag (MTG/MON/WA) from the accumulator —
// unlike buildRow's items, it's not mapped through SOURCE_TAG.
function buildCompletedRow(item) {
  if (!item || typeof item !== 'object') return null;
  const { text, who, source, date, generated, monday_url: url } = item;
  const label = who ? `${text} — ${who}` : (text || '');

  const textSpanProps = { class: generated ? 'row-text row-text-generated' : 'row-text', text: label };
  if (generated) {
    textSpanProps.title = 'No real update text was available for this item — this line is a generated placeholder, not a description someone wrote. Worth a spot-check against the real Monday item.';
  }
  const textSpan = el('span', textSpanProps);
  const metaEls = [];
  if (generated) metaEls.push(el('span', { class: 'generated-chip', text: 'auto', title: 'Generated placeholder — no source text behind this line' }));
  if (source) metaEls.push(el('span', { class: 'source-chip', text: source }));
  const dateLabel = formatShortDate(date);
  if (dateLabel) metaEls.push(el('span', { class: 'date-chip', text: dateLabel }));

  let rightEl;
  if (url) {
    rightEl = el('a', {
      href: url,
      target: '_blank',
      rel: 'noopener',
      title: 'Open in Monday.com',
      class: 'row-right row-link',
      onclick: (e) => e.stopPropagation(),
    }, ...metaEls, el('span', { class: 'chevron', html: '&#8599;' }));
  } else {
    rightEl = el('span', { class: 'row-right' }, ...metaEls);
  }

  const rowContent = el('div', { class: 'completed-row' }, textSpan, rightEl);
  return el('div', { class: 'row-wrapper no-checkbox' }, rowContent);
}

// ── pill builder ──────────────────────────────────────────────────────────────

function buildPill(action, id) {
  if (!action) return null;

  if (action.type === 'email') {
    const params = new URLSearchParams();
    if (action.subject) params.set('subject', action.subject);
    if (action.body)    params.set('body', action.body);
    return el('a', {
      class: 'pill',
      href: `mailto:${action.to || ''}?${params.toString()}`,
      target: '_blank',
      rel: 'noopener',
      html: 'Draft email &#8599;',
    });
  }

  if (action.type === 'copy') {
    if (copiedId === id) {
      return el('span', { class: 'copied-pill', html: 'Copied &#10003;' });
    }
    return el('button', {
      class: 'pill',
      type: 'button',
      text: 'Copy draft',
      onclick: () => copyText(id, action.body || ''),
    });
  }

  return null;
}

// ── next-step row builder ─────────────────────────────────────────────────────

function buildNextRow(priority) {
  if (!priority) return null;
  const id   = priority.id;
  const done = isHandled(id);

  let displayText = priority.text || '';
  const colonIdx  = displayText.indexOf(': ');
  if (colonIdx > 0 && colonIdx < 45) displayText = displayText.slice(colonIdx + 2);

  const textEl = el('span', {
    class: 'next-text',
    style: { textDecoration: done ? 'line-through' : 'none' },
    text: displayText,
  });

  const content = el('div', { class: 'next-content' }, textEl, buildPill(priority.action, id));

  return el('div', { class: 'row-wrapper no-checkbox' }, content);
}

// ── priority matcher ──────────────────────────────────────────────────────────

function findPriorityForClient(priorities, clientEntry) {
  const name = clientEntry.client;

  let m = priorities.find(p => p.client && p.client === name);
  if (m) return m;

  const prefix = name.toLowerCase() + ': ';
  m = priorities.find(p => (p.text || '').toLowerCase().startsWith(prefix));
  if (m) return m;

  m = priorities.find(p => (p.text || '').toLowerCase().includes(name.toLowerCase()));
  return m || null;
}

// ── shared mini-card manual controls (drag to reorder, hide) ─────────────────
//
// Same small control row on every mini-card, client or prospect -- the
// drag handle and remove button both need onclick stopPropagation since the
// card itself is a click-to-open target (see buildMiniCard/buildPotentialCard).

function buildCardControls(key) {
  return el('div', { class: 'card-controls' },
    el('span', {
      class: 'card-drag-handle',
      draggable: 'true',
      title: 'Drag to reorder',
      'aria-label': 'Drag to reorder',
      onclick: (e) => e.stopPropagation(),
      ondragstart: (e) => { dragKey = key; e.dataTransfer.effectAllowed = 'move'; },
    }, '⠿'),
    el('button', {
      class: 'card-remove-btn',
      type: 'button',
      title: 'Hide this card',
      'aria-label': 'Hide this card',
      onclick: (e) => { e.stopPropagation(); hideCard(key); },
    }, '✕'),
  );
}

// orderKeys is the full current display order for THIS card's grid (closed
// over from render() at build time) -- dropping onto card `key` moves
// whatever's mid-drag to that position and persists the whole grid's order.
function cardDropProps(key, orderKeys) {
  return {
    ondragover: (e) => e.preventDefault(),
    ondrop: (e) => {
      e.preventDefault();
      const moving = dragKey;
      dragKey = null;
      if (!moving || moving === key) return;
      const from = orderKeys.indexOf(moving);
      const to = orderKeys.indexOf(key);
      if (from === -1 || to === -1) return;
      const next = [...orderKeys];
      next.splice(from, 1);
      next.splice(to, 0, moving);
      reorderKeys(next);
    },
  };
}

// ── mini card builder (grid view) ─────────────────────────────────────────────

function buildMiniCard(entry, orderKeys) {
  const h = HEALTH[entry.health] || HEALTH.on_track;
  const key = entry._key;

  const displayName = entry.displayName || entry.client;

  const card = el('article', {
    class: 'mini-card',
    role: 'button',
    tabindex: '0',
    'aria-label': `Open ${displayName}`,
    // Routing always uses the real entry.client (Monday/roster identity) --
    // never displayName, which is purely a cosmetic override.
    onclick: () => openClient(entry.client),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClient(entry.client); }
    },
    ...cardDropProps(key, orderKeys),
  });

  card.append(buildCardControls(key));

  card.append(el('div', { class: 'mini-state' },
    el('span', { class: 'mini-dot', style: { background: h.accent, boxShadow: `0 0 8px ${h.glow}` } }),
    el('span', { class: 'mini-state-label', style: { color: h.accent }, text: h.label }),
  ));

  // Editable in place -- a display-only rename (health/highlights/stalled/
  // completed are all structured pipeline data keyed off the real
  // entry.client, which this never touches; see effectiveByClient).
  card.append(el('h2', {
    class: 'mini-name',
    contenteditable: 'true',
    spellcheck: 'false',
    'data-original': displayName,
    onclick: (e) => e.stopPropagation(),
    onkeydown: editableCardKeydown,
    onblur: (e) => onCardFieldBlur(e, key, 'name', false),
    text: displayName,
  }));

  // Editable in place too, same UX -- the other field a real client card
  // can override (health/highlights/stalled/completed are all structured
  // pipeline data, not freely-editable text).
  const headline = entry.headline || 'No activity recorded this week.';
  card.append(el('p', {
    class: 'mini-micro',
    contenteditable: 'true',
    spellcheck: 'false',
    'data-original': headline,
    onclick: (e) => e.stopPropagation(),
    onkeydown: editableCardKeydown,
    onblur: (e) => onCardFieldBlur(e, key, 'headline', false),
    text: headline,
  }));

  const s = entry.stats || {};
  if (s.tasks > 0 || s.monday_msgs > 0 || s.meetings > 0 || s.wa_msgs > 0) {
    const statsEl = el('div', { class: 'mini-stats' });
    const chip = (n, label, warn) => el('span', { class: `mini-stat${warn ? ' stat-warn' : ''}` },
      el('span', { class: 'mini-stat-n', text: String(n) }),
      ` ${label}`,
    );
    if (s.tasks)      statsEl.append(chip(s.tasks, 'tasks', false));
    if (s.working)    statsEl.append(chip(s.working, 'working', false));
    if (s.review)     statsEl.append(chip(s.review, 'review', false));
    if (s.stuck)      statsEl.append(chip(s.stuck, 'stuck', true));
    if (s.done)       statsEl.append(chip(s.done, 'done', false));
    if (s.monday_msgs) statsEl.append(chip(s.monday_msgs, 'msgs', false));
    if (s.meetings)   statsEl.append(chip(s.meetings, 'mtgs', false));
    if (s.wa_msgs)    statsEl.append(chip(s.wa_msgs, 'wa', false));
    card.append(statsEl);
  }

  return card;
}

// ── potential client card (prospects, not signed clients) ────────────────────
//
// Anything that doesn't clearly match a signed client on the active roster
// lands here instead of being force-merged into an existing client's card --
// one card per distinct prospect, visually distinct (dashed border, no health
// dot) from the real client mini-cards above it.

const SOURCE_LABEL = { meeting: 'Meeting', whatsapp: 'WhatsApp', monday_group: 'Monday', mention: 'Mentioned' };

function buildPotentialCard(p, orderKeys) {
  const aliasGap = p.possible_existing_client;
  const key = p._key;
  const card = el('article', {
    class: `mini-card potential-card${aliasGap ? ' alias-gap-card' : ''}`,
    role: 'button',
    tabindex: '0',
    'aria-label': `Open ${p.name || 'potential client'}`,
    onclick: () => openProspect(key),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProspect(key); }
    },
    ...cardDropProps(key, orderKeys),
  });

  card.append(buildCardControls(key));

  card.append(el('div', { class: 'mini-state' },
    el('span', {
      class: `mini-state-label potential-label${aliasGap ? ' alias-gap-label' : ''}`,
      text: aliasGap ? 'Possible existing client — alias mismatch' : 'Potential client',
    }),
  ));

  // Renaming a real client wouldn't make sense (see buildMiniCard), but a
  // prospect's name is exactly the kind of thing an AI match can get
  // slightly wrong -- editable in place here too.
  const name = p.name || 'Unknown';
  card.append(el('h2', {
    class: 'mini-name',
    contenteditable: 'true',
    spellcheck: 'false',
    'data-original': name,
    onclick: (e) => e.stopPropagation(),
    onkeydown: editableCardKeydown,
    onblur: (e) => onCardFieldBlur(e, key, 'name', false),
    text: name,
  }));
  if (aliasGap) {
    card.append(el('p', { class: 'mini-micro alias-gap-note', text: `May actually be ${aliasGap} — add a config.json alias if so, instead of tracking this as a new business.` }));
  }

  const items = p.items || [];
  const first = items[0];
  if (first) card.append(el('p', { class: 'mini-micro', text: first.blurb || '' }));

  const sources = p.sources || [];
  if (sources.length) {
    const statsEl = el('div', { class: 'mini-stats' });
    sources.forEach(s => statsEl.append(el('span', { class: 'mini-stat' }, SOURCE_LABEL[s] || s)));
    if (items.length > 1) {
      statsEl.append(el('span', { class: 'mini-stat' },
        el('span', { class: 'mini-stat-n', text: String(items.length) }), ' mentions',
      ));
    }
    if (typeof p.likelihood_percent === 'number') {
      statsEl.append(el('span', { class: 'mini-stat likelihood-chip-mini' },
        `${p.likelihood_percent}% `, el('span', { class: 'generated-chip', text: 'est' }),
      ));
    }
    card.append(statsEl);
  }

  return card;
}

// ── potential client detail view ──────────────────────────────────────────────

function buildPotentialCardDetail(p) {
  const aliasGap = p.possible_existing_client;
  const wrap = el('div', { class: `potential-detail${aliasGap ? ' alias-gap-card' : ''}` });

  wrap.append(el('div', { class: 'mini-state' },
    el('span', {
      class: `mini-state-label potential-label${aliasGap ? ' alias-gap-label' : ''}`,
      text: aliasGap ? 'Possible existing client — alias mismatch' : 'Potential client',
    }),
  ));
  wrap.append(el('h2', { class: 'mini-name', text: p.name || 'Unknown' }));
  if (aliasGap) {
    wrap.append(el('p', { class: 'mini-micro alias-gap-note', text: `May actually be ${aliasGap} — add a config.json alias if so, instead of tracking this as a new business.` }));
  }

  if (typeof p.likelihood_percent === 'number') {
    const reasonEl = p.likelihood_reason ? el('p', { class: 'likelihood-reason', text: p.likelihood_reason }) : null;
    wrap.append(el('div', { class: 'likelihood-box' },
      el('div', { class: 'likelihood-row' },
        el('span', { class: 'likelihood-percent', text: `${p.likelihood_percent}%` }),
        el('span', { class: 'likelihood-label', text: 'likelihood of closing' }),
        el('span', {
          class: 'generated-chip',
          text: 'estimate',
          title: 'A subjective AI read on tone and interest signals in the text below — not measured data.',
        }),
      ),
      reasonEl,
    ));
  }

  // One synthesized summary for the whole prospect (single meeting: lifted
  // directly; several meetings under different titles, now merged by the
  // clean-entity-name dedup upstream: one combined synthesis) -- never each
  // meeting's raw content shown back to back. Always rendered (even empty)
  // now that it's also the one editable field on this page -- a prospect
  // with nothing generated (or a manual one with no note yet) still needs
  // somewhere to type one in.
  {
    const sec = el('div', { class: 'card-section potential-item' });
    sec.append(el('span', { class: 'section-label', text: 'Summary' }));
    sec.append(el('p', {
      class: 'potential-summary',
      contenteditable: 'true',
      spellcheck: 'false',
      'data-original': p.summary || '',
      onkeydown: editableCardKeydown,
      onblur: (e) => onCardFieldBlur(e, p._key, 'summary', true),
      text: p.summary || '',
    }));
    if ((p.action_items || []).length) {
      sec.append(el('span', { class: 'section-label', text: 'Action items' }));
      const list = el('ul', { class: 'action-items-list' });
      p.action_items.forEach(a => list.append(el('li', { text: a })));
      sec.append(list);
    }
    wrap.append(sec);
  }

  // Per-mention provenance -- source + date + the short blurb each one
  // came in with. Never the full overview/action_items here (that's what
  // the synthesized summary above is for) -- just enough to see how many
  // times, and from where, this prospect has come up.
  const items = p.items || [];
  if (items.length) {
    const sec = el('div', { class: 'card-section potential-item' });
    sec.append(el('span', { class: 'section-label', text: p.summary ? 'Mentions' : 'Details' }));
    items.forEach(item => {
      const whenLabel = formatShortDate(item.when) || item.when || '';
      const row = el('div', { class: 'potential-item-header' },
        el('span', { class: 'source-chip', text: SOURCE_LABEL[item.source] || item.source || '' }),
        whenLabel ? el('span', { class: 'date-chip', text: whenLabel }) : null,
      );
      sec.append(row);
      sec.append(el('p', { class: 'mini-micro', text: item.blurb || '' }));
    });
    wrap.append(sec);
  }

  return wrap;
}

// ── card builder ──────────────────────────────────────────────────────────────

function buildCard(entry, priorities, displayName) {
  const h = HEALTH[entry.health] || HEALTH.on_track;

  const highlights = (entry.work_by_department || []).flatMap(d => d.highlights    || []);
  const stalled    = (entry.work_by_department || []).flatMap(d => d.stalled_items || []);
  const clientPrio = findPriorityForClient(priorities, entry);

  const card = el('article', { class: 'client-card' });

  card.append(el('div', { class: 'card-header' },
    el('span', { class: 'client-name', text: displayName || entry.client }),
    el('span', {
      class: 'health-chip',
      style: { color: h.accent, borderColor: h.chipBorder, background: h.chipBg },
      text: h.label,
    }),
  ));

  const sections = el('div', { class: 'card-sections' });

  if (highlights.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label', text: 'What happened' }));
    highlights.forEach(h => { const r = buildRow(h, false); if (r) sec.append(r); });
    sections.append(sec);
  }

  if (stalled.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label stalled-label', text: 'Stalled' }));
    stalled.forEach(s => { const r = buildRow(s, true); if (r) sec.append(r); });
    sections.append(sec);
  }

  const completedThisWeek = entry.completed_this_week || [];
  // Rolling window of the most recently finished prior weeks (newest first),
  // capped server-side at HISTORY_WINDOW_WEEKS -- weeks with nothing for
  // this client are skipped rather than rendered as empty toggles.
  const completedHistory = (entry.completed_history || []).filter(wk => (wk.items || []).length);

  if (completedThisWeek.length || completedHistory.length) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label completed-label', text: 'Completed' }));
    completedThisWeek.forEach(c => { const r = buildCompletedRow(c); if (r) sec.append(r); });

    completedHistory.forEach(wk => {
      const expandKey = `${entry.client}::${wk.week_of}`;
      const expanded  = !!historyWeekExpanded[expandKey];
      const rangeLabel = isoWeekToDateRange(wk.week_of) || 'prior week';
      const toggle = el('button', {
        class: 'prior-week-toggle',
        type: 'button',
        onclick: () => { historyWeekExpanded[expandKey] = !expanded; render(); },
      },
        el('span', { class: 'prior-week-caret', text: expanded ? '▾' : '▸' }),
        ` ${rangeLabel} (${wk.items.length})`,
      );
      sec.append(toggle);

      if (expanded) {
        const priorList = el('div', { class: 'prior-week-list' });
        wk.items.forEach(c => { const r = buildCompletedRow(c); if (r) priorList.append(r); });
        sec.append(priorList);
      }
    });
    sections.append(sec);
  }

  if (clientPrio) {
    const sec = el('div', { class: 'card-section' });
    sec.append(el('span', { class: 'section-label', text: 'Next' }));
    const r = buildNextRow(clientPrio);
    if (r) sec.append(r);
    sections.append(sec);
  }

  card.append(sections);
  return card;
}

// ── footer renderer ───────────────────────────────────────────────────────────

function renderFooter() {
  const ts = document.getElementById('footer-ts');
  if (ts && standup.week_of) {
    ts.textContent =
      `Generated for week of ${standup.week_of} from Monday.com boards, meeting transcripts, and team messages.`;
  }
}

// ── auto-completed alert banner (page-level, not per-card) ────────────────────
//
// generate.py's completion tracker can auto-mark an item Done on Monday from
// comms evidence alone — GitHub Actions has no way to ping anyone directly,
// so this banner is the notification channel for that specifically. It stays
// dismissed (per-alert, via localStorage) once seen, but a genuinely NEW
// alert (different item/board/timestamp) brings it back.

function renderAlertBanner() {
  const container = document.getElementById('alert-banner-container');
  if (!container) return;
  container.innerHTML = '';

  const alerts = (standup?.auto_completed_alerts || []).filter(a => !dismissedAlerts.has(alertKey(a)));
  if (!alerts.length) return;

  const list = el('ul', { class: 'alert-banner-list' },
    ...alerts.map(a => el('li', { class: 'alert-banner-item' },
      el('span', { class: 'alert-banner-text', text: a.item || '' }),
      ' ',
      el('span', {
        class: 'alert-banner-meta',
        text: `(${a.board || 'Unknown'} · ${a.evidence_source || ''} · ${fmtTimestamp(a.timestamp)})`,
      }),
    )),
  );

  const banner = el('div', { class: 'alert-banner', role: 'alert' },
    el('div', { class: 'alert-banner-header' },
      el('span', { class: 'alert-banner-title', text: '⚠️ Auto-marked Done on Monday' }),
      el('button', {
        class: 'alert-banner-dismiss',
        type: 'button',
        'aria-label': 'Dismiss',
        html: '&#10005;',
        onclick: () => {
          alerts.forEach(a => dismissedAlerts.add(alertKey(a)));
          saveDismissedAlerts(dismissedAlerts);
          renderAlertBanner();
        },
      }),
    ),
    list,
  );
  container.append(banner);
}

// ── full render (called on every state change) ────────────────────────────────

function render() {
  if (!standup) return;
  const app        = document.getElementById('app');
  const priorities = standup.this_week_priorities || [];
  const viewClient   = currentClientView();
  const viewProspect = currentProspectView();
  app.innerHTML    = '';

  if (viewClient) {
    // ── detail view ──
    app.className = 'client-detail';
    app.append(el('button', {
      class: 'back-link',
      type: 'button',
      html: '&#8592;&nbsp; All clients',
      onclick: backToGrid,
    }));
    const entry = (standup.by_client || []).find(c => c.client === viewClient);
    // Display name only -- buildCard still receives the real entry (client
    // routing/priority-matching there is keyed off entry.client untouched).
    const displayName = (standupOverrides.overrides || {})[clientKey(viewClient)]?.name;
    if (entry) app.append(buildCard(entry, priorities, displayName));
    return;
  }

  if (viewProspect) {
    // ── potential-client detail view ──
    app.className = 'client-detail';
    app.append(el('button', {
      class: 'back-link',
      type: 'button',
      html: '&#8592;&nbsp; All potential clients',
      onclick: backToGrid,
    }));
    // effectiveProspects() (not the raw standup.potential_clients lookup) so
    // a manual prospect resolves here too, and so name/summary overrides
    // are already applied by the time buildPotentialCardDetail sees it.
    const p = effectiveProspects().find(pp => pp._key === viewProspect);
    if (p) app.append(buildPotentialCardDetail(p));
    return;
  }

  // ── grid view ──
  app.className = 'client-grid-page';

  const clients = effectiveByClient();
  const clientKeys = clients.map(c => c._key);
  const clientGrid = el('div', { class: 'client-grid' });
  clients.forEach(entry => clientGrid.append(buildMiniCard(entry, clientKeys)));
  app.append(clientGrid);
  appendHiddenCardsToggle(app, hiddenClients(), () => hiddenClientsExpanded, (v) => { hiddenClientsExpanded = v; }, c => c.displayName);

  const prospects = effectiveProspects();
  const prospectKeys = prospects.map(p => p._key);
  const hasAnyProspects = prospects.length || hiddenProspects().length || showAddProspectForm;
  if (hasAnyProspects) {
    app.append(el('div', { class: 'section-divider' },
      el('span', { class: 'section-divider-label', text: 'Potential clients' }),
      el('span', { class: 'section-divider-note', text: 'not merged into any client above — confirm before treating as real' }),
    ));
    if (prospects.length) {
      const potentialGrid = el('div', { class: 'client-grid' });
      prospects.forEach(p => potentialGrid.append(buildPotentialCard(p, prospectKeys)));
      app.append(potentialGrid);
    }
  }
  app.append(buildAddProspectControl());
  appendHiddenCardsToggle(app, hiddenProspects(), () => hiddenProspectsExpanded, (v) => { hiddenProspectsExpanded = v; }, p => p.name);
}

// Shared by both grids -- a simple "Hidden (n)" toggle + unhide list,
// same pattern as Daily Ops' collapsed Handled section.
function appendHiddenCardsToggle(app, hidden, getExpanded, setExpanded, labelFn) {
  if (!hidden.length) return;
  const expanded = getExpanded();
  app.append(el('button', {
    class: 'hidden-cards-toggle',
    type: 'button',
    onclick: () => { setExpanded(!expanded); render(); },
  }, `${expanded ? '▾' : '▸'} Hidden (${hidden.length})`));

  if (!expanded) return;
  const list = el('div', { class: 'hidden-cards-list' });
  hidden.forEach(item => list.append(el('div', { class: 'hidden-card-row' },
    el('span', { class: 'hidden-card-name', text: labelFn(item) }),
    el('button', { type: 'button', class: 'hidden-card-unhide', text: 'unhide', onclick: () => unhideCard(item._key) }),
  )));
  app.append(list);
}

// "+ Add potential client" -- the one manual-create affordance on this page
// (real clients come from Monday/roster, never hand-typed here).
function buildAddProspectControl() {
  const wrap = el('div', { class: 'add-prospect-wrap' });
  wrap.append(el('button', {
    class: 'add-prospect-btn',
    type: 'button',
    text: showAddProspectForm ? 'Cancel' : '+ Add potential client',
    onclick: () => { showAddProspectForm = !showAddProspectForm; render(); },
  }));

  if (showAddProspectForm) {
    const nameInput = el('input', { class: 'add-prospect-input', type: 'text', placeholder: 'Prospect name', required: '' });
    const noteInput = el('input', { class: 'add-prospect-input', type: 'text', placeholder: 'Note (optional)' });
    wrap.append(el('form', {
      class: 'add-prospect-form',
      onsubmit: (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        addProspect(name, noteInput.value.trim());
        showAddProspectForm = false;
      },
    }, nameInput, noteInput, el('button', { type: 'submit', class: 'add-prospect-submit', text: 'Add' })));
  }

  return wrap;
}

// ── date formatting ───────────────────────────────────────────────────────────

function fmtDate(iso) {
  try {
    return new Date(iso + 'T12:00:00Z')
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function fmtTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso || ''; }
}

// "2026-W28" -> "Jul 7 – Jul 13" (the ISO week's Monday-Sunday range).
// The accumulator carries the compact ISO week code; this is just for display.
function isoWeekToDateRange(isoWeekStr) {
  if (!isoWeekStr) return '';
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeekStr);
  if (!m) return isoWeekStr;
  const year = parseInt(m[1], 10), week = parseInt(m[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

// ── init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Independent of standup.json loading -- wire it up even if the fetch
  // below fails, since that's exactly when a manual refresh is most useful.
  initRefreshStandupButton();

  // 1. Fetch standup JSON. Cache-busted the same way loadRemoteChecks()
  // already busts its own fetch (?t=Date.now()) -- this one never had that,
  // so a refresh could keep serving a stale cached copy from the browser or
  // an intermediate CDN edge after a new standup.yml run actually committed
  // fresh data. cache: 'no-store' additionally tells the browser's own HTTP
  // cache to skip itself entirely, regardless of any cache-control header.
  standup = await (async () => {
    try {
      const res = await fetch(`latest.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  })();

  if (!standup) {
    document.getElementById('banner-missing').hidden = false;
    return;
  }

  // 2. Load local mirror first (instant, no flicker)
  loadLocal();

  // 3. Staleness check
  if (standup.week_of) {
    const ageDays = (Date.now() - new Date(standup.week_of + 'T12:00:00Z').getTime()) / 86_400_000;
    if (ageDays > STALE_DAYS) {
      document.getElementById('banner-stale').hidden = false;
    }
  }

  // 4. Header
  const weekEl = document.getElementById('week-of');
  if (weekEl && standup.week_of) {
    weekEl.textContent = `Week of ${fmtDate(standup.week_of)}`;
  }

  // 5. First render with local state
  render();
  renderFooter();
  renderAlertBanner();

  // 6. Fetch remote checks + card overrides (each replaces local/default and
  //    re-renders on arrival; independent of each other, so run in parallel).
  //    Runs async so the page is already interactive.
  await Promise.all([loadRemoteChecks(), loadRemoteStandupOverrides()]);
}

document.addEventListener('DOMContentLoaded', init);
