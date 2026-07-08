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

// Real tickers/pairs are short and only ever use these characters. This guards against
// someone pasting a whole list (or any other junk) into the ticker field, which would
// otherwise get stored as one giant "ticker" and blow past Discord's 2000-char message limit.
const MAX_SYMBOL_LENGTH = 20;
const VALID_SYMBOL = /^[A-Z0-9.\/-]+$/;

function isValidTicker(input) {
  if (typeof input !== "string") return false;
  const s = input.trim();
  return s.length > 0 && s.length <= MAX_SYMBOL_LENGTH && VALID_SYMBOL.test(s.toUpperCase());
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

// Adds several tickers in one load/save cycle instead of one file write per ticker.
function addTickers(guildId, tickers) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  for (const ticker of tickers) {
    const normalized = normalizeSymbol(ticker);
    if (!guild.tickers.includes(normalized)) guild.tickers.push(normalized);
  }
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

function clearTickers(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.tickers = [];
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

function setAlerts(guildId, channelId, intervalMinutes) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.alerts = channelId ? { channelId, intervalMinutes, lastRun: null } : null;
  saveAll(all);
  return guild.alerts;
}

function markAlertsRun(guildId, timestamp) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  if (guild.alerts) guild.alerts.lastRun = timestamp;
  saveAll(all);
}

function allGuildsWithAlerts() {
  const all = loadAll();
  return Object.entries(all).filter(([, g]) => g.alerts);
}

// Remembers each ticker's verdict from the last alert check, so alerts only fire when a
// verdict actually changes (e.g. Neutral -> Buy) instead of repeating every interval.
function getLastVerdicts(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.lastVerdicts || {};
}

function saveVerdicts(guildId, verdicts) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.lastVerdicts = { ...(guild.lastVerdicts || {}), ...verdicts };
  saveAll(all);
}

module.exports = {
  getGuild, addTicker, addTickers, removeTicker, clearTickers, setAutoscan, markAutoscanRun, allGuildsWithAutoscan,
  setAlerts, markAlertsRun, allGuildsWithAlerts, getLastVerdicts, saveVerdicts,
  normalizeSymbol, isValidTicker
};
