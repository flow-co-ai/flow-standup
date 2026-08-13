const GITHUB_REPO = "flow-co-ai/flow-standup";

async function dispatchWorkflow(workflowFile, token) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
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
  if (!res.ok) throw new Error(`dispatch ${workflowFile} failed: ${res.status} ${await res.text()}`);
}

exports.dispatchWorkflow = dispatchWorkflow;

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  try {
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method not allowed" });

    const key = event.headers["x-ops-key"];
    if (!key || key !== process.env.OPS_PASSCODE) return json(401, { ok: false, error: "unauthorized" });

    const token = process.env.GH_STATE_TOKEN;
    if (!token) throw new Error("GH_STATE_TOKEN is not set");

    await dispatchWorkflow("daily-pulse.yml", token);
    await dispatchWorkflow("standup.yml", token);

    return json(200, { ok: true, triggered: ["daily-pulse.yml", "standup.yml"], triggeredAt: new Date().toISOString() });
  } catch (err) {
    console.error("refresh-everything error:", err);
    return json(500, { ok: false, error: String((err && err.message) || err) });
  }
};
