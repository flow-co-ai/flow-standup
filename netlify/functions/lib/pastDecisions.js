// Shared by queue.js (the ignore-reasons read endpoint) and item-chat.js/
// ops-chat.js (folded into the drafting assistants' system prompt) -- one
// extraction so all three always agree on what counts as a "past decision"
// and how it's presented. Mirrors apply_performance.js's own
// recentDecisions/PAST DECISIONS pattern (decisions the human already made,
// fed back into the next generation instead of thrown away) for the
// performance lens -- same idea, applied to Daily Ops ignores.

function recentIgnoreDecisions(items, limit = 30) {
  return (items || [])
    .filter((it) => it.status === "ignored" && it.ignoreReason)
    .slice()
    .sort((a, b) => new Date(b.ignoredAt || 0) - new Date(a.ignoredAt || 0))
    .slice(0, limit)
    .map((it) => ({
      title: it.title || null,
      client: it.group || it.potentialClient || null,
      board: it.board || null,
      reason: it.ignoreReason,
      ignoredAt: it.ignoredAt || null,
    }));
}

// Empty string (not a header with "none yet") when there's nothing to show
// -- appended directly onto an existing system prompt string, so a no-op
// here should truly be a no-op there too.
function formatPastDecisionsBlock(items) {
  const decisions = recentIgnoreDecisions(items);
  if (!decisions.length) return "";
  const lines = decisions.map(
    (d) => `- [${d.client || "n/a"}${d.board ? "/" + d.board : ""}] "${d.title || "(untitled)"}" -- ignored: ${d.reason}`
  );
  return `\n\n## PAST DECISIONS -- things Naz has ignored, and why\nA repeated pattern here (the same kind of card, the same reason) is negative signal: don't draft that kind of thing as a task again -- route it to Notes/FYI instead. A single one-off ignore isn't a pattern by itself.\n${lines.join("\n")}\n`;
}

module.exports = { recentIgnoreDecisions, formatPastDecisionsBlock };
