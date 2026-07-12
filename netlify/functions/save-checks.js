/**
 * save-checks.js — Netlify Function
 *
 * POST /.netlify/functions/save-checks
 * Body:    { week_of: "YYYY-MM-DD", checks: { rowId: true, ... } }
 * Header:  X-Ops-Key: <passcode>
 *
 * Writes checks/{week_of}.json to the "state" branch of this repo via the
 * GitHub Contents API. Creates the "state" branch if it doesn't exist yet.
 *
 * Env vars (set in Netlify site settings, NOT in GitHub secrets):
 *   OPS_PASSCODE    — shared passcode for writing checkmarks
 *   GH_STATE_TOKEN  — GitHub fine-grained PAT, Contents read/write on this repo
 *
 * Requires Node 18+ for the global fetch API (Netlify's default runtime).
 */

const OWNER = 'flow-co-ai';
const REPO  = 'flow-standup';

// ── GitHub API helpers ────────────────────────────────────────────────────────

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'flow-standup/save-checks',
  };
}

async function ensureStateBranch(token) {
  const baseUrl = `https://api.github.com/repos/${OWNER}/${REPO}`;

  // Check whether the state branch already exists
  const checkRes = await fetch(`${baseUrl}/git/ref/heads/state`, {
    headers: ghHeaders(token),
  });

  if (checkRes.status === 200) return; // exists, nothing to do

  if (checkRes.status !== 404) {
    const body = await checkRes.text();
    throw new Error(`GitHub: unexpected status checking state branch: ${checkRes.status} — ${body}`);
  }

  // Get the HEAD SHA of the default branch (main)
  const mainRes = await fetch(`${baseUrl}/git/ref/heads/main`, {
    headers: ghHeaders(token),
  });
  if (!mainRes.ok) {
    const body = await mainRes.text();
    throw new Error(`GitHub: could not read main branch: ${mainRes.status} — ${body}`);
  }
  const mainData = await mainRes.json();
  const headSha = mainData.object.sha;

  // Create the state branch
  const createRes = await fetch(`${baseUrl}/git/refs`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ ref: 'refs/heads/state', sha: headSha }),
  });

  // 422 means it was created by a concurrent request — that's fine
  if (!createRes.ok && createRes.status !== 422) {
    const body = await createRes.text();
    throw new Error(`GitHub: could not create state branch: ${createRes.status} — ${body}`);
  }
}

async function writeChecksFile(token, weekOf, checks) {
  const filePath = `checks/${weekOf}.json`;
  const baseUrl  = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;
  const content  = Buffer.from(JSON.stringify(checks, null, 2) + '\n').toString('base64');

  // Try to fetch the existing file to get its SHA (required for updates)
  const getRes = await fetch(`${baseUrl}?ref=state`, {
    headers: ghHeaders(token),
  });

  const putBody = {
    message: `chore: update checks for ${weekOf}`,
    content,
    branch: 'state',
  };

  if (getRes.ok) {
    const existing = await getRes.json();
    putBody.sha = existing.sha; // required to overwrite
  } else if (getRes.status !== 404) {
    const body = await getRes.text();
    throw new Error(`GitHub: unexpected status reading existing file: ${getRes.status} — ${body}`);
  }
  // 404 → new file, no sha needed

  const putRes = await fetch(baseUrl, {
    method: 'PUT',
    headers: ghHeaders(token),
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`GitHub: write failed: ${putRes.status} — ${body}`);
  }
}

// ── main handler ──────────────────────────────────────────────────────────────

exports.handler = async function handler(event) {
  // Only POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // Check env vars are configured
  const passcode = process.env.OPS_PASSCODE || '';
  const ghToken  = process.env.GH_STATE_TOKEN || '';

  if (!passcode || !ghToken) {
    console.error('save-checks: OPS_PASSCODE or GH_STATE_TOKEN is not set');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Server not configured — contact the site owner' }),
    };
  }

  // Verify passcode
  const provided = (event.headers || {})['x-ops-key'] || '';
  if (!provided || provided !== passcode) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid or missing passcode' }),
    };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { week_of, checks } = body;

  if (!week_of || typeof week_of !== 'string') {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Body must include week_of (string YYYY-MM-DD)' }),
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week_of)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'week_of must match YYYY-MM-DD' }),
    };
  }
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Body must include checks (object)' }),
    };
  }

  // Write to GitHub
  try {
    await ensureStateBranch(ghToken);
    await writeChecksFile(ghToken, week_of, checks);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, week_of }),
    };
  } catch (err) {
    console.error('save-checks: GitHub write error:', err.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `GitHub write failed: ${err.message}` }),
    };
  }
};
