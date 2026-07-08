// Loads the candidate ticker pools shipped at the repo root (stocks.txt / crypto.txt) for
// /watch autobuild to sample from. These are just reference lists, not the active watchlist.

const fs = require("fs");
const path = require("path");

const STOCKS_FILE = path.join(__dirname, "..", "..", "stocks.txt");
const CRYPTO_FILE = path.join(__dirname, "..", "..", "crypto.txt");

function loadLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
}

// kind: "stocks" | "crypto" | "both"
function loadUniverse(kind) {
  if (kind === "stocks") return loadLines(STOCKS_FILE);
  if (kind === "crypto") return loadLines(CRYPTO_FILE);
  return [...loadLines(STOCKS_FILE), ...loadLines(CRYPTO_FILE)];
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
