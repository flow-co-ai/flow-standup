// refresh-widget.js — single "Refresh Everything" button, shared across all
// four pages (Standup / Daily Ops / Performance / Timeline). Self-contained
// so it can be included with one <script> tag on every page.
//
// Replaces the old Standup-only "Refresh Standup" button + its handler in
// app.js. Hits /.netlify/functions/refresh-everything, which dispatches BOTH
// the Daily Pulse and Daily Standup GitHub Actions in one call.

(function () {
  const KEY_PASSCODE = 'flowops-passcode';
  const REFRESH_DEBOUNCE_MS = 60_000;
  let debounceUntil = 0;

  function getPasscode()        { return localStorage.getItem(KEY_PASSCODE) || null; }
  function storePasscode(p)     { localStorage.setItem(KEY_PASSCODE, p); }
  function clearStoredPasscode(){ localStorage.removeItem(KEY_PASSCODE); }

  function mountButton() {
    const headerRight = document.querySelector('.header-right');
    if (!headerRight) return null;

    let mount = document.getElementById('refresh-everything-mount');
    if (!mount) {
      mount = document.createElement('span');
      mount.id = 'refresh-everything-mount';
      headerRight.appendChild(mount);
    }

    mount.innerHTML = `
      <button id="refresh-everything-btn" class="refresh-btn" type="button" title="Refreshes Standup, Daily Ops health check, Performance and Timeline in one go">
        <span class="refresh-icon" aria-hidden="true">&#8635;</span>
        <span class="refresh-label">Refresh Everything</span>
      </button>
      <span id="refresh-everything-error" class="refresh-error" role="alert" hidden></span>
    `;
    return document.getElementById('refresh-everything-btn');
  }

  function promptForPasscode(onSubmit) {
    let bar = document.getElementById('refresh-passcode-bar');
    if (bar) { bar.hidden = false; return; }
    bar = document.createElement('div');
    bar.id = 'refresh-passcode-bar';
    bar.className = 'passcode-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Enter ops passcode');
    bar.innerHTML = `
      <form id="refresh-passcode-form">
        <input id="refresh-passcode-input" type="password" placeholder="Ops passcode" autocomplete="off">
        <button type="submit">Go</button>
      </form>
    `;
    document.body.appendChild(bar);
    document.getElementById('refresh-passcode-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('refresh-passcode-input');
      const val = (input?.value || '').trim();
      if (!val) return;
      storePasscode(val);
      bar.hidden = true;
      if (input) input.value = '';
      onSubmit();
    });
    setTimeout(() => document.getElementById('refresh-passcode-input')?.focus(), 80);
  }

  function init() {
    const btn = mountButton();
    if (!btn) return;
    const labelEl = btn.querySelector('.refresh-label');
    const errEl = document.getElementById('refresh-everything-error');

    const showError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
    const clearError = () => { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } };

    async function trigger() {
      if (Date.now() < debounceUntil) {
        const secsLeft = Math.ceil((debounceUntil - Date.now()) / 1000);
        showError(`Already triggered — wait ${secsLeft}s before triggering again.`);
        return;
      }

      const passcode = getPasscode();
      if (!passcode) { promptForPasscode(trigger); return; }

      clearError();
      btn.disabled = true;
      btn.classList.add('is-loading');
      if (labelEl) labelEl.textContent = 'Triggering...';

      let res;
      try {
        res = await fetch('/.netlify/functions/refresh-everything', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ops-Key': passcode },
        });
      } catch (err) {
        btn.classList.remove('is-loading');
        btn.disabled = false;
        showError('Network error: ' + err.message);
        return;
      }

      const data = await res.json().catch(() => ({}));
      btn.classList.remove('is-loading');

      if (!data.ok) {
        btn.disabled = false;
        showError(data.error || `Couldn't trigger (HTTP ${res.status})`);
        if (res.status === 401 && data.error === 'unauthorized') {
          clearStoredPasscode();
          promptForPasscode(trigger);
        }
        return;
      }

      if (labelEl) labelEl.textContent = 'Triggered — takes ~2-3 min, refresh the page after';
      debounceUntil = Date.now() + REFRESH_DEBOUNCE_MS;
      setTimeout(() => {
        btn.disabled = false;
        if (labelEl) labelEl.textContent = 'Refresh Everything';
      }, 5000);
    }

    btn.addEventListener('click', trigger);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
