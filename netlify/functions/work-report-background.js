// POST { client, from, to, job } with header x-ops-key -> 202 right away.
//
// Background function (the -background suffix gives it 15 minutes): reads
// Monday, drafts the work report, and writes the result to the state branch
// at work-reports/jobs/<job>.json. The page polls work-report.js?job=<id>
// for it. Everything else about work reports lives in work-report.js and
// lib/workReport.js.

const { putJSON, updateJSON } = require("./lib/github");
const { buildDraft, parseWindow, sameSecret, JOB_ID, jobPath, draftPath } = require("./lib/workReport");

exports.handler = async (event) => {
  const key = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
  if (!sameSecret(key, process.env.OPS_PASSCODE)) return; // nothing written; the page's poll gives up
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (!JOB_ID.test(String(body.job || ""))) return;

  let result;
  try {
    const { client, w } = parseWindow(body);
    result = { status: "done", ...(await buildDraft(client, w)) };
  } catch (err) {
    console.error("work-report-background:", err);
    result = { status: "error", error: err.name === "AbortError" ? "The model took too long. Try a shorter date range." : String((err && err.message) || err) };
  }
  result.finishedAt = new Date().toISOString();
  // The shared copy everyone sees when they open this client's Work reports tab.
  if (result.status === "done") {
    await updateJSON(draftPath(result.client), () => ({ client: result.client, savedAt: result.finishedAt, data: result, text: null, subject: null, sentAt: null }), `work report draft: ${result.client}`, { fallback: {} })
      .catch((err) => console.error("work-report-background: couldn't save the shared draft", err));
  }
  try { await putJSON(jobPath(body.job), result, `work report draft ${body.job}`); }
  catch (err) { console.error("work-report-background: couldn't save the draft", err); }
};
