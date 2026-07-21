// Loads the candidate ticker pool shipped at the repo root (crypto.txt) for /watch autobuild
// and /shorts to sample from. Just a reference list, not the active watchlist.

const fs = require("fs");
const path = require("path");

const CRYPTO_FILE = path.join(__dirname, "..", "..", "crypto.txt");

function loadLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
}

// crypto.txt is compiled roughly biggest-to-smallest by market cap (see its own header comment)
// -- skipping this many of the top entries approximates "small/mid cap" without needing a real
// market-cap data source (Twelve Data's free tier doesn't expose one). Approximate, not exact:
// the file's ranking is a point-in-time compile, not a live feed.
const SMALLCAP_RANK_CUTOFF = 50;

// kind: "crypto" | "crypto-smallcap"
function loadUniverse(kind) {
  if (kind === "crypto-smallcap") return loadLines(CRYPTO_FILE).slice(SMALLCAP_RANK_CUTOFF);
  return loadLines(CRYPTO_FILE);
}

function sample(list, count) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

module.exports = { loadUniverse, sample };
