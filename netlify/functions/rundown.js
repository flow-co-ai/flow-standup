// GET -> today's morning rundown digest, written by Naz's flow-morning-rundown
//         Cowork automation to checks/rundown.json on the state branch.

const { getJSON } = require("./lib/github");

const RUNDOWN_PATH = "checks/rundown.json";
const EMPTY = { date: null, summary: "No rundown yet.", flags: [] };

exports.handler = async (event) => {
  const passcode = event.headers["x-ops-key"] || event.headers["x-ops-passcode"];
  if (passcode !== process.env.OPS_PASSCODE) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const { data } = await getJSON(RUNDOWN_PATH, EMPTY);
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
};
