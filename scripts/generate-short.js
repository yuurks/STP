// Fills scripts/movers-short.template.html with real numbers from data/movers.json --
// run this any time after find-movers.js to get an updated, ready-to-screen-record Short
// without hand-editing any HTML.
//
// Run with: node scripts/generate-short.js

const fs = require("fs");
const path = require("path");
const { generateShortHtml } = require("../src/lib/shorts");

function main() {
  const moversPath = path.join(__dirname, "..", "data", "movers.json");
  const movers = JSON.parse(fs.readFileSync(moversPath, "utf8"));
  const { winner, loser } = movers;

  if (!winner?.intraday?.closes?.length || !loser?.intraday?.closes?.length) {
    throw new Error("data/movers.json is missing intraday data -- run scripts/find-movers.js first");
  }

  const html = generateShortHtml(winner, loser);
  const outPath = path.join(__dirname, "..", "data", "movers-short.html");
  fs.writeFileSync(outPath, html);
  console.log(`Wrote ${outPath}`);
}

main();
