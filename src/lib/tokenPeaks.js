// Tiny persisted store of the highest market cap ever observed for a token address, across every
// scan that's seen it. DexScreener's snapshot API has no historical high of its own -- confirmed
// against a real live pair, the only fields available are current price/marketCap/fdv plus
// rolling 5m/1h/6h/24h windows -- so "this coin already proved it could reach $X and has since
// pulled back" can only be known by remembering what we've personally observed over time. Global,
// not per-guild (see watchlist.js): a token's own peak market cap is a fact about the token, not
// about which Discord server happens to be watching it.

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "tokenPeaks.json");

function loadAll() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveAll(all) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
}

function getPeak(address) {
  const all = loadAll();
  return all[address] || null;
}

// Batched (one read + one write for the whole scan's worth of pairs) rather than per-token --
// /breakout's candidate universe is Raydium's top ~1000 pools, so a per-call read/write here
// would mean hundreds of file round-trips every single scan. observations: [{ address,
// marketCap }]. Returns a Map of address -> the peak record as it stood BEFORE this batch, so
// callers can compare "current vs. what we already knew" without this same observation masking
// the comparison against itself.
function recordObservations(observations) {
  const all = loadAll();
  const previousPeaks = new Map();
  let changed = false;
  for (const { address, marketCap } of observations) {
    if (!address || !marketCap) continue;
    const previous = all[address] || null;
    previousPeaks.set(address, previous);
    if (!previous || marketCap > previous.marketCap) {
      all[address] = { marketCap, timestamp: Date.now() };
      changed = true;
    }
  }
  if (changed) saveAll(all);
  return previousPeaks;
}

module.exports = { getPeak, recordObservations };
