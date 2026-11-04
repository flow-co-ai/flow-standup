// The one Claude model setting for every Netlify function. Change it in
// config.json ("model"); ANTHROPIC_MODEL in Netlify env overrides it.
const config = require("../../../config.json");

const MODEL = process.env.ANTHROPIC_MODEL || config.model || "claude-sonnet-4-6";

module.exports = { MODEL };
