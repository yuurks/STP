// Minimal JSON-file-backed watchlist store, one entry per Discord server (guild).
// Good enough for a single-process bot; swap for a real database if you outgrow it.

const fs = require("fs");
const path = require("path");
const { createPortfolio } = require("./portfolio");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "watchlists.json");
// Logged once at startup -- confirmed working against a real persistent volume (mounted at
// /app/data on Railway). If watchlist/portfolio/alert-history data ever appears to reset after
// a deploy again, check this path against RAILWAY_VOLUME_MOUNT_PATH first.
console.log(`Watchlist data file: ${DATA_FILE}`);

// This bot is crypto-only, but Twelve Data's underlying API still understands bare stock
// tickers, and this normalizer stays lenient (not just crypto pairs) so /watch remove can still
// clean up a stock ticker someone added back before the pivot. Real gating happens at
// isCryptoTicker below, used by /watch add and /backtest -- not here.
function normalizeSymbol(input) {
  let s = input.toUpperCase().trim();
  if (s.includes("/")) return s; // already in BASE/QUOTE form
  if (s.includes("-")) return s.replace("-", "/"); // BTC-USD -> BTC/USD
  return s; // anything else passed through as-is
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

// Every real crypto pair this bot works with (crypto.txt, DexScreener, Twelve Data's crypto
// endpoint) is written as BASE/QUOTE -- a bare symbol with no "/" or "-" is stock-shaped, not
// crypto-shaped (that's exactly how a leftover ticker like "AAPL" survived the pivot to
// crypto-only: /watch add never actually rejected it, and Twelve Data happily returns real
// price data for it, so it just sat on a watchlist getting scanned forever). Used by /watch add
// and /backtest; NOT used by /watch remove, which must stay able to clean up a ticker added
// before this existed.
function isCryptoTicker(input) {
  return isValidTicker(input) && /[/-]/.test(input.trim());
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

// /discover scans the crypto candidate pool (not the watchlist) and needs its own verdict-
// tracking bucket, separate from the watchlist's lastVerdicts -- same symbol could appear in
// both scopes, and mixing them would make a manual /scan's verdict suppress a /discover alert
// (or vice versa) for reasons that wouldn't make sense to someone reading the alert.
// Same idea as logAlert/getAlertHistory, kept in its own bucket for the same reason
// discoverVerdicts is separate from the watchlist's lastVerdicts -- a /discover alert and an
// /alerts alert on the same symbol are different claims and shouldn't be evaluated together.
const MAX_DISCOVER_ALERT_HISTORY = 200;
function logDiscoverAlert(guildId, symbol, verdict, price, atr) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.discoverAlertHistory = guild.discoverAlertHistory || [];
  guild.discoverAlertHistory.push({ symbol, verdict, price, atr: atr || null, timestamp: Date.now() });
  if (guild.discoverAlertHistory.length > MAX_DISCOVER_ALERT_HISTORY) {
    guild.discoverAlertHistory = guild.discoverAlertHistory.slice(-MAX_DISCOVER_ALERT_HISTORY);
  }
  saveAll(all);
}

function getDiscoverAlertHistory(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.discoverAlertHistory || [];
}

function getDiscoverVerdicts(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.discoverVerdicts || {};
}

function saveDiscoverVerdicts(guildId, verdicts) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.discoverVerdicts = { ...(guild.discoverVerdicts || {}), ...verdicts };
  saveAll(all);
}

function setDiscoverSchedule(guildId, config) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.discoverSchedule = config;
  saveAll(all);
  return guild.discoverSchedule;
}

function markDiscoverRun(guildId, timestamp) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  if (guild.discoverSchedule) guild.discoverSchedule.lastRun = timestamp;
  saveAll(all);
}

function allGuildsWithDiscoverSchedule() {
  const all = loadAll();
  return Object.entries(all).filter(([, g]) => g.discoverSchedule);
}

// /degen tracks which Solana token addresses have already been alerted on, so the same token
// doesn't get re-alerted every scan just for still being in DexScreener's rolling "newest
// profiles" feed. Capped the same way alert history is, so this can't grow forever.
const MAX_DEGEN_ALERTED = 500;
function getDegenAlerted(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.degenAlerted || [];
}

function addDegenAlerted(guildId, addresses) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.degenAlerted = [...new Set([...(guild.degenAlerted || []), ...addresses])].slice(-MAX_DEGEN_ALERTED);
  saveAll(all);
}

// Real performance tracking for /degen, same spirit as logAlert but a different shape --
// there's no verdict (every degen alert is the same "cleared the bar" claim) and price is
// stored under `price` (not `priceUsd`) to stay consistent with the alerts/discover history
// schema. address is what /degen history uses to re-look-up the token on DexScreener later.
const MAX_DEGEN_ALERT_HISTORY = 200;
function logDegenAlert(guildId, address, symbol, price, url) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.degenAlertHistory = guild.degenAlertHistory || [];
  guild.degenAlertHistory.push({ address, symbol, price, url, timestamp: Date.now() });
  if (guild.degenAlertHistory.length > MAX_DEGEN_ALERT_HISTORY) {
    guild.degenAlertHistory = guild.degenAlertHistory.slice(-MAX_DEGEN_ALERT_HISTORY);
  }
  saveAll(all);
}

function getDegenAlertHistory(guildId) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  return guild.degenAlertHistory || [];
}

function setDegenSchedule(guildId, config) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.degenSchedule = config;
  saveAll(all);
  return guild.degenSchedule;
}

function markDegenRun(guildId, timestamp) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  if (guild.degenSchedule) guild.degenSchedule.lastRun = timestamp;
  saveAll(all);
}

function allGuildsWithDegenSchedule() {
  const all = loadAll();
  return Object.entries(all).filter(([, g]) => g.degenSchedule);
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

// Recurring config for /shorts on -- two fixed daily crypto drops (4pm and 8pm ET; see
// src/index.js) rather than a configurable interval, since the times aren't something worth
// exposing as an option.
function setShortsSchedule(guildId, config) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  guild.shortsSchedule = config;
  saveAll(all);
  return guild.shortsSchedule;
}

function allGuildsWithShortsSchedule() {
  const all = loadAll();
  return Object.entries(all).filter(([, g]) => g.shortsSchedule);
}

// slot: "1" (4pm) | "2" (8pm) -- tracked separately since they fire at different times of day.
function markShortRun(guildId, slot, dateStr) {
  const all = loadAll();
  const guild = ensureGuild(all, guildId);
  if (!guild.shortsSchedule) return;
  guild.shortsSchedule[slot === "2" ? "lastRunDate2" : "lastRunDate1"] = dateStr;
  saveAll(all);
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
  setShortsSchedule, allGuildsWithShortsSchedule, markShortRun,
  getDiscoverVerdicts, saveDiscoverVerdicts, logDiscoverAlert, getDiscoverAlertHistory,
  setDiscoverSchedule, markDiscoverRun, allGuildsWithDiscoverSchedule,
  getDegenAlerted, addDegenAlerted, setDegenSchedule, markDegenRun, allGuildsWithDegenSchedule,
  logDegenAlert, getDegenAlertHistory,
  getPortfolio, startPortfolio, savePortfolio, resetPortfolio,
  normalizeSymbol, isValidTicker, isCryptoTicker
};
