// Durable record of recent /shorts and promo-ad pipeline failures -- console logs alone aren't
// enough to investigate these after the fact: Railway's log buffer is short-lived and the
// breakout scanner alone logs dozens of lines every ~10 minutes, so by the time a missing
// YouTube post actually gets reported, whatever error text existed has almost always already
// scrolled out of view (confirmed directly -- checked logs within minutes of a real failure and
// found nothing useful). This persists the same information to the data volume instead, where it
// survives regardless of how much time or how much other logging happens in between.

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "shortsErrors.json");
const MAX_ENTRIES = 50;

function loadAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

// context: "shorts" | "promo" -- symbol is null for the promo ad, which has no ticker.
function logShortsError(context, symbol, message) {
  const all = loadAll();
  all.push({ timestamp: Date.now(), context, symbol: symbol || null, message });
  const trimmed = all.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(trimmed, null, 2));
}

function getRecentShortsErrors() {
  return loadAll();
}

module.exports = { logShortsError, getRecentShortsErrors };
