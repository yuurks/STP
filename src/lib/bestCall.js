// Finds the single best-performing past call across all four alert-history sources
// (/alerts, /discover, /degen, /breakout) for a guild, so /shorts can feature a real result
// ("this actually happened") instead of just today's live market movement. A losing call is
// never featured, no matter how "interesting" -- this only ever returns a genuine winner, or
// null if nothing eligible qualifies yet.
//
// Reuses the same evaluation rules the /x history commands already use (see index.js):
// /alerts and /discover are stop-aware (daily candles exist, so a 2x-ATR stop can be replayed);
// /degen and /breakout are raw current-price-vs-logged-price for finding the winner, since
// DexScreener itself has no historical candles -- but the winning pick gets a real-candle
// enrichment attempt from GeckoTerminal's free OHLCV API afterward (see geckoterminal.js),
// which does have real history for these pools. Falls back to an honest 2-point entry->now line
// if that's unavailable (an older logged alert with no stored pairAddress, a delisted/too-new
// pool, or the lookup just failing) -- never fabricated in between either way.

const watchlist = require("./watchlist");
const { fetchDailySeries } = require("./marketData");
const { fetchTokenTradingData } = require("./dexscreener");
const { fetchOhlcv } = require("./geckoterminal");

// Mirrors the thresholds index.js's /x history commands use -- an entry isn't evaluated until
// it's actually had time to produce a real result.
const ALERT_EVAL_MIN_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const DEX_EVAL_MIN_AGE_MS = 60 * 60 * 1000;
const ALERT_EVAL_LOOKBACK_DAYS = 120;
const MAX_SYMBOLS_PER_SOURCE = 30;

// Walks forward from the fire date checking the same 2x-ATR stop /scan shows, same as
// runAlertHistory in index.js -- scores at the stop price if it would have been hit, otherwise
// the latest close. Returns null if there's no forward data yet (shouldn't happen given the
// age-eligibility filter, but a real market gap/delisting could still leave rows short).
function evaluateStopAware(entry, rows) {
  const firedDate = new Date(entry.timestamp).toISOString().slice(0, 10);
  const forwardRows = rows.filter(r => r.date > firedDate);
  if (!forwardRows.length) return null;

  const isBuySide = entry.verdict.includes("Buy");
  let exitPrice = null;

  if (entry.atr) {
    const stopPrice = isBuySide ? entry.price - 2 * entry.atr : entry.price + 2 * entry.atr;
    for (const row of forwardRows) {
      const hitStop = isBuySide ? row.low <= stopPrice : row.high >= stopPrice;
      if (hitStop) { exitPrice = stopPrice; break; }
    }
  }
  if (exitPrice == null) exitPrice = forwardRows[forwardRows.length - 1].close;

  const pctChange = ((exitPrice - entry.price) / entry.price) * 100;
  // Trajectory since firing, for the chart -- the fired-on candle through today, real daily
  // OHLC, not synthetic. entryIndex is always 0: sinceFired starts exactly at the fired date by
  // construction, so the entry marker always sits on the first candle.
  const sinceFired = rows.filter(r => r.date >= firedDate);
  return {
    pctChange,
    currentPrice: exitPrice,
    closes: sinceFired.map(r => r.close),
    ohlc: sinceFired.map(r => ({ open: r.open, high: r.high, low: r.low, close: r.close })),
    entryIndex: 0
  };
}

// GeckoTerminal has real historical OHLCV for DEX pools -- including brand-new Solana pump.fun/
// PumpSwap pairs, confirmed live -- which DexScreener's own API cannot provide at all. This is
// what lets /degen and /breakout picks get real candlesticks too, not just a 2-point line, PROVIDED
// the alert was logged with a pairAddress (added alongside this feature -- older log entries
// won't have one and gracefully keep the 2-point line instead). Hourly bars over a week: coarse
// enough that a multi-day-old call still fits in the window, fine enough to look like a real
// chart. Never thrown on failure -- a missing/delisted/too-new pool just means no enrichment,
// not a broken /shorts run.
async function tryFetchRealOhlc(entry) {
  if (!entry.pairAddress) return null;
  try {
    const candles = await fetchOhlcv(entry.pairAddress, { timeframe: "hour", aggregate: 1, limit: 168 });
    if (candles.length < 2) return null;
    let entryIndex = candles.findIndex(c => c.time >= entry.timestamp);
    if (entryIndex === -1) entryIndex = candles.length - 1;
    return {
      ohlc: candles.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
      entryIndex
    };
  } catch (err) {
    console.error(`Best-call GeckoTerminal lookup failed for ${entry.symbol}: ${err.message}`);
    return null;
  }
}

// /alerts and /discover both fire off daily-candle signals against the same evaluation rules --
// only the history bucket and the label shown differ.
async function bestFromCandleSource(guildId, source, getHistory) {
  const history = getHistory(guildId);
  const eligible = history.filter(h => Date.now() - h.timestamp >= ALERT_EVAL_MIN_AGE_MS);
  if (!eligible.length) return null;

  const uniqueSymbols = [...new Set(eligible.map(h => h.symbol))].slice(0, MAX_SYMBOLS_PER_SOURCE);
  const seriesBySymbol = {};
  for (const symbol of uniqueSymbols) {
    try {
      const rows = await fetchDailySeries(symbol, ALERT_EVAL_LOOKBACK_DAYS);
      if (rows.length) seriesBySymbol[symbol] = rows;
    } catch (err) {
      console.error(`Best-call lookup failed for ${symbol}: ${err.message}`);
    }
  }

  let best = null;
  for (const entry of eligible) {
    const rows = seriesBySymbol[entry.symbol];
    if (!rows) continue;
    const result = evaluateStopAware(entry, rows);
    if (!result) continue;
    if (!best || result.pctChange > best.pctChange) {
      best = {
        source, symbol: entry.symbol, verdict: entry.verdict,
        entryPrice: entry.price, currentPrice: result.currentPrice,
        pctChange: result.pctChange, firedAt: entry.timestamp,
        closes: result.closes, ohlc: result.ohlc, entryIndex: result.entryIndex
      };
    }
  }
  return best;
}

// /degen and /breakout have no historical candles from DexScreener itself (see dexscreener.js)
// -- the winning pick, if any, gets a real-candle enrichment attempt from GeckoTerminal below;
// this part is just the raw current-price-vs-logged-price comparison used to find the winner,
// same as their own /x history commands.
async function bestFromDexScreenerSource(guildId, source, getHistory) {
  const history = getHistory(guildId);
  const eligible = history.filter(h => Date.now() - h.timestamp >= DEX_EVAL_MIN_AGE_MS);
  if (!eligible.length) return null;

  const addresses = [...new Set(eligible.map(h => h.address))];
  const currentByAddress = new Map();
  try {
    const pairs = await fetchTokenTradingData("solana", addresses);
    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      if (!addr) continue;
      const liq = pair.liquidity?.usd || 0;
      const existing = currentByAddress.get(addr);
      if (!existing || liq > (existing.liquidity?.usd || 0)) currentByAddress.set(addr, pair);
    }
  } catch (err) {
    console.error(`Best-call DexScreener lookup failed: ${err.message}`);
    return null;
  }

  let best = null;
  let winningEntry = null;
  for (const entry of eligible) {
    const current = currentByAddress.get(entry.address);
    const currentPrice = current ? parseFloat(current.priceUsd) : NaN;
    if (!current || !currentPrice || !entry.price) continue;
    const pctChange = ((currentPrice - entry.price) / entry.price) * 100;
    if (!best || pctChange > best.pctChange) {
      best = {
        source, symbol: entry.symbol, verdict: null,
        entryPrice: entry.price, currentPrice,
        pctChange, firedAt: entry.timestamp,
        // Honest 2-point line (entry -> now) by default, not a fabricated trajectory --
        // replaced below with real candles if GeckoTerminal has them for this pool.
        closes: [entry.price, currentPrice], ohlc: null, entryIndex: 0
      };
      winningEntry = entry;
    }
  }

  // Only the single winning pick ever gets a real-candle lookup -- never spent on every
  // eligible candidate, so this stays cheap regardless of how much history exists.
  if (best && winningEntry) {
    const enriched = await tryFetchRealOhlc(winningEntry);
    if (enriched) {
      best.ohlc = enriched.ohlc;
      best.entryIndex = enriched.entryIndex;
    }
  }

  return best;
}

// Returns the single best-performing eligible call across all four sources, or null if nothing
// eligible is a genuine winner yet (either no history old enough, or everything eligible is
// currently flat/negative -- a loser is never returned here, by design).
async function findBestCall(guildId) {
  const results = await Promise.all([
    bestFromCandleSource(guildId, "Alerts", watchlist.getAlertHistory),
    bestFromCandleSource(guildId, "Discover", watchlist.getDiscoverAlertHistory),
    bestFromDexScreenerSource(guildId, "Degen", watchlist.getDegenAlertHistory),
    bestFromDexScreenerSource(guildId, "Breakout", watchlist.getBreakoutAlertHistory)
  ]);

  const winners = results.filter(r => r && r.pctChange > 0);
  if (!winners.length) return null;
  return winners.reduce((best, r) => (r.pctChange > best.pctChange ? r : best));
}

module.exports = { findBestCall };
