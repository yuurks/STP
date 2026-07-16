// Minimal JSON-file-backed watchlist store, one entry per Discord server (guild).
// Good enough for a single-process bot; swap for a real database if you outgrow it.

const fs = require("fs");
const path = require("path");
const { createPortfolio } = require("./portfolio");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "watchlists.json");
// Logged once at startup so a Railway (or any host's) persistent volume can be mounted at the
// exact right directory -- get this wrong and the volume silently does nothing. Railway sets
// RAILWAY_VOLUME_MOUNT_PATH automatically ONLY when a volume is genuinely attached to this
// service -- if that comes back blank, there is no volume here no matter what the dashboard
// showed, and nothing will ever persist regardless of the DATA_FILE path above.
console.log(`Watchlist data file: ${DATA_FILE}`);
console.log(`Railway volume mount path (blank = no volume attached): ${process.env.RAILWAY_VOLUME_MOUNT_PATH || "(not set)"}`);
console.log(`Railway volume name: ${process.env.RAILWAY_VOLUME_NAME || "(not set)"}`);
console.log(`Data file already exists at startup: ${fs.existsSync(DATA_FILE)}`);

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

// Wholesale swap, used by /watch autobuild to replace the watchlist with a fresh set.
function replaceTickers(guildId, tickers) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.tickers = [...new Set(tickers.map(normalizeSymbol))];
  saveAll(all);
  return guild.tickers;
}

function getAutobuildLastRun(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.autobuildLastRun || null;
}

function markAutobuildRun(guildId, timestamp) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.autobuildLastRun = timestamp;
  saveAll(all);
}

// Recurring config for the standalone /autobuild command -- shares the same autobuildLastRun
// cooldown clock as the manual /watch autobuild trigger, so the two can't stack.
function setAutobuildSchedule(guildId, config) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.autobuildSchedule = config;
  saveAll(all);
  return guild.autobuildSchedule;
}

function allGuildsWithAutobuildSchedule() {
  const all = loadAll();
  return Object.entries(all).filter(([, g]) => g.autobuildSchedule);
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

// Every fired alert gets logged here so /alerts history can check back later on what the price
// actually did -- real forward performance, not a simulation. Capped so this can't grow forever.
const MAX_ALERT_HISTORY = 200;
function logAlert(guildId, symbol, verdict, price, atr) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.alertHistory = guild.alertHistory || [];
  guild.alertHistory.push({ symbol, verdict, price, atr: atr || null, timestamp: Date.now() });
  if (guild.alertHistory.length > MAX_ALERT_HISTORY) {
    guild.alertHistory = guild.alertHistory.slice(-MAX_ALERT_HISTORY);
  }
  saveAll(all);
}

function getAlertHistory(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.alertHistory || [];
}

// Recurring config for /alerts digest-on -- periodically posts the same "real performance"
// report /alerts history builds on demand, without needing to be asked.
function setAlertDigestSchedule(guildId, config) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.alertDigestSchedule = config;
  saveAll(all);
  return guild.alertDigestSchedule;
}

function markAlertDigestRun(guildId, timestamp) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  if (guild.alertDigestSchedule) guild.alertDigestSchedule.lastRun = timestamp;
  saveAll(all);
}

function allGuildsWithAlertDigestSchedule() {
  const all = loadAll();
  return Object.entries(all).filter(([, g]) => g.alertDigestSchedule);
}

function getPortfolio(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.portfolio || null;
}

function startPortfolio(guildId, startingCash) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.portfolio = createPortfolio(startingCash);
  saveAll(all);
  return guild.portfolio;
}

function savePortfolio(guildId, portfolio) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.portfolio = portfolio;
  saveAll(all);
}

function resetPortfolio(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.portfolio = null;
  saveAll(all);
}

module.exports = {
  getGuild, addTicker, addTickers, removeTicker, clearTickers, replaceTickers,
  getAutobuildLastRun, markAutobuildRun, setAutobuildSchedule, allGuildsWithAutobuildSchedule,
  setAutoscan, markAutoscanRun, allGuildsWithAutoscan,
  setAlerts, markAlertsRun, allGuildsWithAlerts, getLastVerdicts, saveVerdicts,
  logAlert, getAlertHistory,
  setAlertDigestSchedule, markAlertDigestRun, allGuildsWithAlertDigestSchedule,
  getPortfolio, startPortfolio, savePortfolio, resetPortfolio,
  normalizeSymbol, isValidTicker
};
