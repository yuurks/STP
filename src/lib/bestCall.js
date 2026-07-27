// Finds the single best-performing past call across all four alert-history sources
// (/alerts, /discover, /degen, /breakout) for a guild, so /shorts can feature a real result
// ("this actually happened") instead of just today's live market movement. A losing call is
// never featured, no matter how "interesting" -- this only ever returns a genuine winner, or
// null if nothing eligible qualifies yet.
//
// Reuses the same evaluation rules the /x history commands already use (see index.js):
// /alerts and /discover are stop-aware (daily candles exist, so a 2x-ATR stop can be replayed);
// /degen and /breakout are raw current-price-vs-logged-price (no candles exist for either).

const watchlist = require("./watchlist");
const { fetchDailySeries } = require("./marketData");
const { fetchTokenTradingData } = require("./dexscreener");

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
  // closes, not synthetic.
  const sinceFired = rows.filter(r => r.date >= firedDate);
  return {
    pctChange,
    currentPrice: exitPrice,
    closes: sinceFired.map(r => r.close)
  };
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
        pctChange: result.pctChange, firedAt: entry.timestamp, closes: result.closes
      };
    }
  }
  return best;
}

// /degen and /breakout have no historical candles at all (see dexscreener.js) -- just a raw
// current-price-vs-logged-price comparison, same as their own /x history commands.
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
        // No candle history exists for these -- an honest 2-point line (entry -> now), not a
        // fabricated trajectory in between.
        closes: [entry.price, currentPrice]
      };
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
