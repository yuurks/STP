// Minimal JSON-file-backed watchlist store, one entry per Discord server (guild).
// Good enough for a single-process bot; swap for a real database if you outgrow it.

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "watchlists.json");

// Accepts stock tickers (AAPL), and crypto/forex pairs written as BTC/USD, BTC-USD, or btcusd
// (for common cases), normalizing all to Twelve Data's expected "BASE/QUOTE" or plain format.
function normalizeSymbol(input) {
  let s = input.toUpperCase().trim();
  if (s.includes("/")) return s; // already in BASE/QUOTE form
  if (s.includes("-")) return s.replace("-", "/"); // BTC-USD -> BTC/USD
  return s; // plain stock ticker, e.g. AAPL
}

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

function ensureGuild(all, guildId) {
  if (!all[guildId]) all[guildId] = { tickers: [], autoscan: null };
  return all[guildId];
}

function getGuild(guildId) {
  const all = loadAll();
  return ensureGuild(all, guildId);
}

function addTicker(guildId, ticker) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  const normalized = normalizeSymbol(ticker);
  if (!guild.tickers.includes(normalized)) guild.tickers.push(normalized);
  saveAll(all);
  return guild.tickers;
}

function removeTicker(guildId, ticker) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  const normalized = normalizeSymbol(ticker);
  guild.tickers = guild.tickers.filter(t => t !== normalized);
  saveAll(all);
  return guild.tickers;
}

function setAutoscan(guildId, channelId, intervalMinutes) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.autoscan = channelId ? { channelId, intervalMinutes, lastRun: null } : null;
  saveAll(all);
  return guild.autoscan;
}

function markAutoscanRun(guildId, timestamp) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  if (guild.autoscan) guild.autoscan.lastRun = timestamp;
  saveAll(all);
}

function allGuildsWithAutoscan() {
  const all = loadAll();
  return Object.entries(all).filter(([, g]) => g.autoscan);
}

module.exports = {
  getGuild, addTicker, removeTicker, setAutoscan, markAutoscanRun, allGuildsWithAutoscan,
  normalizeSymbol
};
