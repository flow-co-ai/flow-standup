// POST -> Monday.com webhook receiver. Fires the instant a Status column
// changes to "Done" on any of the 4 configured boards -- writes straight to
// standups/completed-accumulator.json on `main`, no cron, no AI inference,
// no dependency on the item still being active by the time a batch job runs.
//
// SETUP (one-time, in Monday): Board -> Integrations -> Webhooks -> "When
// status changes -> send webhook", one per board (CRM/Ads/Video/Web+SEO).
// ALSO set one on each Subitems board (Subitems of CRM/Ads/Video/Web+SEO) --
// subitem status changes fire on the subitem's own board, not the parent's.
// Monday POSTs a {"challenge":"..."} verification request first -- handled
// below.
//
// ENV VARS: GH_STATE_TOKEN, MONDAY_API_TOKEN (already set in Netlify)
//
// KNOWN RISK (not fixed here, a real tradeoff -- flagged 2026-08-06): this
// writes directly to the GitHub Contents API for the SAME file
// (completed-accumulator.json) that standup.yml's Action ALSO bundles into
// its own daily commit (git add standups/ ...). If this webhook fires while
// that Action is mid-run, its push gets rejected, it rebases, and a real
// conflict on this file makes the Action drop its ENTIRE day's commit
// (standup.yml's own documented behavior: abort the rebase, reset to
// origin/main, defer to whichever run already landed) -- not just this
// file. Narrow window (the Action's own run is short), but real. Properly
// fixing it means deciding whether standup.yml should stop bundling this
// file into its own commit at all, which would break generate.py's own
// MTG/WA-sourced completions unless that's restructured too -- a real
// product decision, not something to silently change here.

const crypto = require("crypto");

const GITHUB_REPO = "flow-co-ai/flow-standup";
const ACCUMULATOR_PATH = "standups/completed-accumulator.json";
const MONDAY_API_URL = "https://api.monday.com/v2";

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function fetchItemDetails(itemId) {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: process.env.MONDAY_API_TOKEN,
      "Content-Type": "application/json",
      "API-Version": "2023-10",
    },
    body: JSON.stringify({
      query: `query($ids: [ID!]!) { items(ids: $ids) { id name board { id name } group { title } parent_item { id name group { title } } } }`,
      variables: { ids: [String(itemId)] },
    }),
  });
  const payload = await res.json();
  const item = payload?.data?.items?.[0];
  if (!item) throw new Error(`Monday item ${itemId} not found`);
  // Subitems don't have their own meaningful group -- resolve client via the
  // parent item's group instead when this is a subitem.
  const groupTitle = item.parent_item ? (item.parent_item.group?.title || "") : (item.group?.title || "");
  const name = item.parent_item ? `${item.parent_item.name} — ${item.name}` : item.name;
  return { name, boardName: item.board?.name || "", groupTitle };
}

// Escapes regex metacharacters in a client alias before it's dropped into a
// RegExp literal -- an alias can legitimately contain "." or other special
// characters (a business name, a domain-ish string).
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match, not a plain substring check -- mirrors
// fetch_monday.py's all_alias_matches() exactly (same bug class it was
// written to fix: "Flow" must match "Flow OS" but never "workflow"). A
// group title is a fairly clean, deliberately-set value, but there's no
// reason to use a looser check here than the rest of the codebase already
// settled on for the exact same kind of matching.
async function resolveClient(groupTitle) {
  const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/config.json?t=${Date.now()}`);
  const config = await res.json();
  const needle = groupTitle.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(config.clients || {})) {
    const variants = new Set();
    for (const alias of aliases) {
      const a = alias.toLowerCase().trim();
      if (a) {
        variants.add(a);
        variants.add(a.replace(/\s+/g, ""));
      }
    }
    for (const v of variants) {
      const re = new RegExp(`(?<!\\w)${escapeRegExp(v)}(?!\\w)`);
      if (re.test(needle)) return canonical;
    }
  }
  return "Unmapped";
}

async function getFile(token) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${ACCUMULATOR_PATH}?ref=main`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
  );
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  const data = await res.json();
  const content = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
  return { content, sha: data.sha };
}

async function putFile(token, content, sha, message) {
  const body = Buffer.from(JSON.stringify(content, null, 2) + "\n", "utf-8").toString("base64");
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${ACCUMULATOR_PATH}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: body, sha, branch: "main" }),
  });
  if (res.status === 409) return { ok: false, conflict: true };
  if (!res.ok) return { ok: false, conflict: false, error: `GitHub write failed: ${res.status} ${await res.text()}` };
  return { ok: true };
}

async function appendCompletion(itemId, client, text) {
  const token = process.env.GH_STATE_TOKEN;
  if (!token) throw new Error("GH_STATE_TOKEN is not set");

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { content: acc, sha } = await getFile(token);

    const allSeenIds = new Set([
      ...(acc.monday_ids_seen || []),
      ...((acc.history || []).flatMap((wk) => wk.monday_ids_seen || [])),
    ]);
    if (allSeenIds.has(String(itemId))) return { ok: true, skipped: "already recorded" };

    const week = isoWeek(new Date());
    if (acc.isoWeek !== week) {
      acc.history = acc.history || [];
      acc.history.unshift({ isoWeek: acc.isoWeek, items: acc.items || [], monday_ids_seen: acc.monday_ids_seen || [] });
      acc.isoWeek = week;
      acc.items = [];
      acc.monday_ids_seen = [];
    }

    acc.items = acc.items || [];
    acc.monday_ids_seen = acc.monday_ids_seen || [];
    acc.items.push({
      id: crypto.createHash("sha1").update(`${itemId}:${Date.now()}`).digest("hex").slice(0, 12),
      client,
      text,
      who: null,
      source: "MON",
      sourceDate: new Date().toISOString().slice(0, 10),
      monday_item_id: String(itemId),
      generated: false,
    });
    acc.monday_ids_seen.push(String(itemId));

    const result = await putFile(token, acc, sha, `webhook: mark ${itemId} done (${client})`);
    if (result.ok) return { ok: true };
    if (!result.conflict) throw new Error(result.error);
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw new Error("Gave up after 5 conflicting writes");
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  try {
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method not allowed" });
    const body = JSON.parse(event.body || "{}");
    if (body.challenge) return json(200, { challenge: body.challenge });

    const ev = body.event;
    if (!ev) return json(200, { ok: true, skipped: "no event payload" });
    console.log("monday webhook event:", JSON.stringify({ pulseId: ev.pulseId, columnType: ev.columnType, label: ev.value?.label?.text }));

    const newLabel = ev.value?.label?.text;
    if (!["color", "status"].includes(ev.columnType) || newLabel !== "Done") {
      return json(200, { ok: true, skipped: `not a Done transition (columnType=${ev.columnType}, label=${newLabel})` });
    }

    const itemId = ev.pulseId || ev.itemId;
    if (!itemId) return json(200, { ok: true, skipped: "no item id in payload" });

    const details = await fetchItemDetails(itemId);
    const client = await resolveClient(details.groupTitle);
    const text = `Marked Done on Monday: ${details.name}`;

    const result = await appendCompletion(itemId, client, text);
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error("monday-done-webhook error:", err);
    return json(500, { ok: false, error: String((err && err.message) || err) });
  }
};
