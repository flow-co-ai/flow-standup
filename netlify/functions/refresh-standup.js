// POST -> manually triggers the Daily Standup GitHub Action (workflow_dispatch)
// so Naz can kick off a fresh standup regenerate from the dashboard, instead
// of only via the daily cron or the GitHub Actions UI. Same OPS_PASSCODE gate
// as every other write-capable function in this app -- this fires a real CI
// run (which can itself write to Monday via the completion tracker), so it's
// not left open to anyone who can load the page.

const GITHUB_REPO = "flow-co-ai/flow-standup";
const WORKFLOW_FILE = "standup.yml";

// Shared by this file's own HTTP handler AND ops-chat.js's trigger_standup_
// refresh tool -- one real side-effecting call (fires a CI run that can
// itself write to Monday via the completion tracker), so the chat gets the
// exact same trigger the on-page button uses, not a second copy of it.
async function triggerStandupWorkflow() {
  const token = process.env.GITHUB_WORKFLOW_TOKEN;
  if (!token) return { ok: false, error: "GITHUB_WORKFLOW_TOKEN is not set" };

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  // GitHub returns 204 No Content with no body on success -- that IS success.
  if (res.status === 204) return { ok: true };

  // Any non-204 (401/403/404/422, etc.) -- surface GitHub's own error detail
  // rather than swallowing it, mirroring GitHub's status code so it's
  // obvious at a glance whether this is an auth/scope problem (401/403), a
  // wrong repo/workflow path (404), or a bad ref (422).
  let detail = {};
  try {
    detail = await res.json();
  } catch {
    detail = { message: await res.text().catch(() => "") };
  }
  return { ok: false, error: detail.message || `GitHub API ${res.status}`, statusCode: res.status };
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

  try {
    const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"] || JSON.parse(event.body || "{}").passcode;
    if (passcode !== process.env.OPS_PASSCODE) return json(401, { ok: false, error: "unauthorized" });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method not allowed" });

    const result = await triggerStandupWorkflow();
    if (result.ok) return json(200, { ok: true });
    return json(result.statusCode || 500, { ok: false, error: result.error });
  } catch (err) {
    console.error("refresh-standup function error:", err);
    return json(500, { ok: false, error: String((err && err.message) || err) });
  }
};

exports.triggerStandupWorkflow = triggerStandupWorkflow;
