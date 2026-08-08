const GITHUB_REPO = "flow-co-ai/flow-standup";
const WORKFLOWS = ["daily-pulse.yml", "standup.yml"];

async function getLatestRunStatus(workflowFile, since, token) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=5`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`status check failed for ${workflowFile}: ${res.status}`);
  const data = await res.json();
  const sinceMs = new Date(since).getTime() - 5000;
  const run = (data.workflow_runs || []).find((r) => new Date(r.created_at).getTime() >= sinceMs);
  if (!run) return { workflow: workflowFile, status: "pending" };
  return { workflow: workflowFile, status: run.status, conclusion: run.conclusion, id: run.id };
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  try {
    // Same X-Ops-Key gate as every other function here (including the
    // read-only rundown.js) -- this reports real internal CI status
    // (run ids, success/failure), and nothing in this codebase exposes that
    // without the ops passcode.
    const key = event.headers["x-ops-key"];
    if (!key || key !== process.env.OPS_PASSCODE) return json(401, { ok: false, error: "unauthorized" });

    const since = event.queryStringParameters && event.queryStringParameters.since;
    if (!since) return json(400, { ok: false, error: "missing since param" });

    const token = process.env.GH_STATE_TOKEN;
    if (!token) throw new Error("GH_STATE_TOKEN is not set");

    const results = await Promise.all(WORKFLOWS.map((w) => getLatestRunStatus(w, since, token)));
    const allDone = results.every((r) => r.status === "completed");
    const anyFailed = results.some((r) => r.conclusion && r.conclusion !== "success");

    return json(200, { ok: true, done: allDone, failed: anyFailed, runs: results });
  } catch (err) {
    console.error("refresh-status error:", err);
    return json(500, { ok: false, error: String((err && err.message) || err) });
  }
};
