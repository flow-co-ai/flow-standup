// Read/write JSON files on the `state` branch — the same branch and the same
// GH_STATE_TOKEN your checkmark-writer function already uses. Nothing new to
// set up here if that's already configured; this just reuses it.

const API = "https://api.github.com";

function repoInfo(branchOverride) {
  const repo = process.env.GH_REPO || "flow-co-ai/flow-standup";
  const branch = branchOverride || process.env.GH_STATE_BRANCH || "state";
  return { repo, branch };
}

// Thrown specifically for a 409 (stale sha -- someone else wrote this file
// between our read and our write) so callers can tell "safe to retry with a
// fresh read" apart from every other GitHub API failure.
class ConflictError extends Error {}

async function ghFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GH_STATE_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    if (res.status === 409) throw new ConflictError(`GitHub API 409: ${body}`);
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res;
}

// Returns { data, sha }. sha is null if the file doesn't exist yet.
// branchOverride reads from a specific branch instead of the state branch --
// e.g. the standup rundown only ever gets pushed to main, so its state-branch
// copy can be stale; pass "main" there to actually get the current one.
async function getJSON(filePath, fallback = {}, branchOverride) {
  const { repo, branch } = repoInfo(branchOverride);
  const res = await ghFetch(`/repos/${repo}/contents/${filePath}?ref=${branch}`);
  if (res.status === 404) return { data: fallback, sha: null };
  const json = await res.json();
  const content = Buffer.from(json.content, "base64").toString("utf-8");
  return { data: JSON.parse(content), sha: json.sha };
}

async function putJSON(filePath, data, message, sha = null) {
  const { repo, branch } = repoInfo();
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  const res = await ghFetch(`/repos/${repo}/contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: message || `update ${filePath}`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  return res.json();
}

// Every read-then-write caller in this codebase (queue.js, item-chat.js,
// standup-overrides.js, ops-chat.js) shares the same race: two requests read
// the same sha, both try to write, the second gets a 409 and the whole write
// is lost.
// This wraps that pattern once -- read, let the caller compute the next
// state from it, write with that sha, and on a 409 just re-read-and-retry
// (the retry re-runs `mutate` against whatever the other writer actually
// left behind, so it's a real merge, not a blind overwrite). `mutate` can
// throw its own error (e.g. "no item with that id") to abort without
// retrying -- only a ConflictError triggers another attempt.
async function updateJSON(filePath, mutate, message, { fallback = {}, branchOverride, maxAttempts = 4 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, sha } = await getJSON(filePath, fallback, branchOverride);
    const next = await mutate(data);
    try {
      await putJSON(filePath, next, typeof message === "function" ? message(next) : message, sha);
      return next;
    } catch (err) {
      if (err instanceof ConflictError && attempt < maxAttempts) continue;
      throw err;
    }
  }
}

module.exports = { getJSON, putJSON, updateJSON, ConflictError };
