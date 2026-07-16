// One-off content tool, not part of the running bot: scans a random sample of the
// stocks.txt/crypto.txt universe for today's single biggest gainer and biggest loser (daily %
// change plus intraday chart data), and writes it to data/movers.json for
// scripts/generate-short.js to turn into a finished Shorts visual.
//
// Run with: node scripts/find-movers.js [sampleSize] [universe]
// universe: stocks | crypto | both (default: both)
// Uses the same TWELVE_DATA_API_KEY and pacing as the live bot, so it draws from the same
// shared daily request quota -- see the printed cost estimate before running.

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { findMover } = require("../src/lib/shorts");

const PACING_MS = 7500;
const sampleSize = Math.min(543, Math.max(10, parseInt(process.argv[2], 10) || 200));
const universeKind = ["stocks", "crypto", "both"].includes(process.argv[3]) ? process.argv[3] : "both";

async function main() {
  const etaMin = Math.ceil((sampleSize * PACING_MS) / 60000);
  console.log(`Scanning ~${sampleSize} candidates from the ${universeKind} pool (~${etaMin} min, ~${sampleSize} of your 800 daily requests)...`);

  const { candidateCount, checked, winner, loser } = await findMover(universeKind, sampleSize);

  console.log(`Checked ${checked}/${candidateCount} candidates.`);
  console.log(`Winner: ${winner?.symbol} ${winner?.pctChange.toFixed(2)}%`);
  console.log(`Loser: ${loser?.symbol} ${loser?.pctChange.toFixed(2)}%`);

  const outPath = path.join(__dirname, "..", "data", "movers.json");
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), universeKind, winner, loser }, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
