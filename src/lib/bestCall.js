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

// A "winner" used to mean anything merely positive -- a 1.7% mover got exactly the same "Real
// Call" treatment as a real standout, which made every /shorts drop feel the same regardless of
// whether anything actually notable happened. Raised to a real bar: the call has to be up at
// least this much since it fired to be featured at all. Also used by index.js to gate the
// live-scan fallback (findMover) the same way, so neither path can post something this weak.
const MIN_FEATURE_PCT_CHANGE = 50;

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

// Granularity scales with how long ago the call fired -- a call from the last few hours gets
// the finest real detail GeckoTerminal offers (1-min bars), a multi-day-old one gets coarser bars
// wide enough to actually still contain the entry, rather than one fixed window that's either too
// sparse for a recent call or too narrow to reach back far enough for an old one. Only combos
// confirmed live against GeckoTerminal's real API (minute bars: 1/5/15 only -- 30 returns 400;
// hour bars: 1). Each window is sized well past the call's actual age, not just barely covering
// it, so there's real context on both sides of the entry marker rather than it sitting right at
// the edge. resampleOhlc below still caps what actually gets rendered (see MAX_RENDERED_CANDLES)
// -- fetching finer than that isn't wasted, it just means a young pool with under 48 real candles
// (the common case right after a call becomes eligible) shows all of what genuinely exists
// instead of being needlessly bucketed into fewer, coarser candles.
function pickGranularity(ageMs) {
  const ageHours = ageMs / 3600000;
  if (ageHours <= 4) return { timeframe: "minute", aggregate: 1, limit: 240 };  // ~4h window
  if (ageHours <= 24) return { timeframe: "minute", aggregate: 5, limit: 288 }; // 24h window
  if (ageHours <= 96) return { timeframe: "hour", aggregate: 1, limit: 384 };   // 16d window
  return { timeframe: "hour", aggregate: 1, limit: 500 }; // GeckoTerminal's practical max for hourly
}

// The chart is only ~700px wide -- 500 real candles crammed into that renders as unreadable
// noise, confirmed visually against a real render (BONK's actual multi-day history at hourly
// granularity). Groups every run of `bucketSize` real candles into one aggregated candle
// (open = the group's first open, close = the group's last close, high/low = the group's real
// extremes) rather than just dropping data -- a real resampling, the same thing every
// candlestick charting library does when zoomed out, not a fabrication. entryIndex is remapped
// to whichever resampled bucket the real entry candle landed in.
const MAX_RENDERED_CANDLES = 48;
function resampleOhlc(candles, entryIndex) {
  if (candles.length <= MAX_RENDERED_CANDLES) {
    return { candles: candles.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })), entryIndex };
  }

  const bucketSize = Math.ceil(candles.length / MAX_RENDERED_CANDLES);
  const resampled = [];
  let newEntryIndex = 0;
  for (let i = 0; i < candles.length; i += bucketSize) {
    const bucket = candles.slice(i, i + bucketSize);
    resampled.push({
      open: bucket[0].open,
      high: Math.max(...bucket.map(c => c.high)),
      low: Math.min(...bucket.map(c => c.low)),
      close: bucket[bucket.length - 1].close
    });
    if (entryIndex >= i && entryIndex < i + bucketSize) newEntryIndex = resampled.length - 1;
  }
  return { candles: resampled, entryIndex: newEntryIndex };
}

// GeckoTerminal has real historical OHLCV for DEX pools -- including brand-new Solana pump.fun/
// PumpSwap pairs, confirmed live -- which DexScreener's own API cannot provide at all. This is
// what lets /degen and /breakout picks get real candlesticks too, not just a 2-point line, PROVIDED
// the alert was logged with a pairAddress (added alongside this feature -- older log entries
// won't have one and gracefully keep the 2-point line instead). Never thrown on failure -- a
// missing/delisted/too-new pool just means no enrichment, not a broken /shorts run.
//
// livePairAddress is the pool bestFromDexScreenerSource's currentPrice actually came from --
// whatever pool DexScreener currently considers canonical for this token (highest liquidity) --
// which is preferred over entry.pairAddress (frozen at whatever pool existed when the alert first
// logged) whenever it's available. A pump.fun token commonly starts on a near-zero-liquidity
// bonding-curve pool that GeckoTerminal has no real candle history for at all, then migrates to a
// real AMM pool with actual trading volume soon after -- querying the live pool instead fixes
// that directly, and as a bonus the two prices can no longer diverge since they're now the same
// pool. entry.pairAddress remains the fallback for the rare case DexScreener's lookup didn't
// return a pairAddress. The divergence check below stays anyway as a last-resort safety net (e.g.
// GeckoTerminal's own data lagging real-time), just no longer the primary defense.
const MAX_PRICE_DIVERGENCE_RATIO = 0.5;
async function tryFetchRealOhlc(entry, currentPrice, livePairAddress) {
  const pairAddress = livePairAddress || entry.pairAddress;
  if (!pairAddress) return null;
  try {
    const candles = await fetchOhlcv(pairAddress, pickGranularity(Date.now() - entry.timestamp));
    if (candles.length < 2) {
      console.error(`Best-call GeckoTerminal data for ${entry.symbol} (${pairAddress}) returned too few candles (${candles.length}) -- likely a too-thin/unindexed pool, skipping enrichment`);
      return null;
    }
    // If even the OLDEST fetched candle is already newer than the entry, the entry genuinely
    // isn't visible in this window -- that's a real "not enough history" case, not "it's at the
    // start," and showing a marker on the wrong candle would be worse than showing none.
    if (candles[0].time > entry.timestamp) {
      console.error(`Best-call GeckoTerminal data for ${entry.symbol} (${pairAddress}) starts after the entry's own timestamp -- not enough history at this granularity, skipping enrichment`);
      return null;
    }

    const lastClose = candles[candles.length - 1].close;
    if (currentPrice > 0 && Math.abs(lastClose - currentPrice) / currentPrice > MAX_PRICE_DIVERGENCE_RATIO) {
      console.error(`Best-call GeckoTerminal data for ${entry.symbol} (${pairAddress}) disagrees with confirmed current price (pool close ${lastClose} vs ${currentPrice}) -- likely a stale pairAddress from before a migration, skipping enrichment`);
      return null;
    }

    const rawEntryIndex = candles.findIndex(c => c.time >= entry.timestamp);
    const { candles: resampled, entryIndex } = resampleOhlc(
      candles, rawEntryIndex === -1 ? candles.length - 1 : rawEntryIndex
    );
    return { ohlc: resampled, entryIndex };
  } catch (err) {
    console.error(`Best-call GeckoTerminal lookup failed for ${entry.symbol} (${pairAddress}): ${err.message}`);
    return null;
  }
}

// Ranks a list of winner candidates and picks the strongest one, but skips any symbol in
// recentSymbols (the last few /shorts drops -- see watchlist.js's shortsFeaturedHistory) when a
// non-repeat option exists, so the same coin doesn't dominate every drop just for having the
// strongest all-time gain. Falls back to the best repeat anyway when every candidate is recent --
// showing the same real winner again beats showing nothing.
function pickBestWithRotation(candidates, recentSymbols) {
  if (!candidates.length) return null;
  const fresh = candidates.filter(c => !recentSymbols.has(c.symbol));
  const pool = fresh.length ? fresh : candidates;
  return pool.reduce((best, c) => (!best || c.pctChange > best.pctChange ? c : best), null);
}

// /alerts and /discover both fire off daily-candle signals against the same evaluation rules --
// only the history bucket and the label shown differ.
async function bestFromCandleSource(guildId, source, getHistory, recentSymbols) {
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

  const candidates = [];
  for (const entry of eligible) {
    const rows = seriesBySymbol[entry.symbol];
    if (!rows) continue;
    const result = evaluateStopAware(entry, rows);
    if (!result) continue;
    candidates.push({
      source, symbol: entry.symbol, verdict: entry.verdict,
      entryPrice: entry.price, currentPrice: result.currentPrice,
      pctChange: result.pctChange, firedAt: entry.timestamp,
      closes: result.closes, ohlc: result.ohlc, entryIndex: result.entryIndex
    });
  }
  return pickBestWithRotation(candidates, recentSymbols);
}

// /degen and /breakout have no historical candles from DexScreener itself (see dexscreener.js)
// -- the winning pick, if any, gets a real-candle enrichment attempt from GeckoTerminal below;
// this part is just the raw current-price-vs-logged-price comparison used to find the winner,
// same as their own /x history commands.
async function bestFromDexScreenerSource(guildId, source, getHistory, recentSymbols) {
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

  const candidates = [];
  for (const entry of eligible) {
    const current = currentByAddress.get(entry.address);
    const currentPrice = current ? parseFloat(current.priceUsd) : NaN;
    if (!current || !currentPrice || !entry.price) continue;
    const pctChange = ((currentPrice - entry.price) / entry.price) * 100;
    candidates.push({
      source, symbol: entry.symbol, verdict: null,
      entryPrice: entry.price, currentPrice,
      pctChange, firedAt: entry.timestamp,
      // Honest 2-point line (entry -> now) by default, not a fabricated trajectory --
      // replaced below with real candles if GeckoTerminal has them for this pool.
      closes: [entry.price, currentPrice], ohlc: null, entryIndex: 0,
      // `current.pairAddress` is DexScreener's *currently* highest-liquidity pool for this
      // token -- not necessarily the same pool `entry.pairAddress` pointed at when the alert
      // first logged (a token that started on a thin pump.fun bonding-curve pool and later
      // migrated to a real AMM will have a totally different, far more liquid pool by now).
      // Fetching candles from the SAME pool `currentPrice` itself came from means the two can
      // never disagree, and a live, high-liquidity pool is far more likely to actually have
      // OHLC history on GeckoTerminal than a stale, possibly near-zero-liquidity original one.
      // Both underscore-prefixed fields are internal-only, stripped off before returning below.
      _entry: entry, _livePairAddress: current.pairAddress
    });
  }

  const best = pickBestWithRotation(candidates, recentSymbols);
  if (!best) return null;
  const winningEntry = best._entry;
  const winningLivePairAddress = best._livePairAddress;
  delete best._entry;
  delete best._livePairAddress;

  // Only the single winning pick ever gets a real-candle lookup -- never spent on every
  // eligible candidate, so this stays cheap regardless of how much history exists.
  if (best && winningEntry) {
    const enriched = await tryFetchRealOhlc(winningEntry, best.currentPrice, winningLivePairAddress);
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
  const recentSymbols = new Set(watchlist.getRecentShortsFeatured(guildId).map(h => h.symbol));

  const results = await Promise.all([
    bestFromCandleSource(guildId, "Alerts", watchlist.getAlertHistory, recentSymbols),
    bestFromCandleSource(guildId, "Discover", watchlist.getDiscoverAlertHistory, recentSymbols),
    bestFromDexScreenerSource(guildId, "Degen", watchlist.getDegenAlertHistory, recentSymbols),
    bestFromDexScreenerSource(guildId, "Breakout", watchlist.getBreakoutAlertHistory, recentSymbols)
  ]);

  const winners = results.filter(r => r && r.pctChange >= MIN_FEATURE_PCT_CHANGE);
  // Each per-source result is already rotation-aware on its own, but a source can still come back
  // with a forced repeat if that source alone had no fresh alternative (e.g. Degen's only winner
  // ever is the one just featured) -- re-applying rotation across all four combined still prefers
  // any fresh pick from another source over that forced repeat, even one with a smaller gain.
  const best = pickBestWithRotation(winners, recentSymbols);
  // isFresh tells a caller whether this is a genuinely new pick versus a forced repeat (nothing
  // else currently qualifies) -- /shorts's event-driven auto-post only fires on isFresh results,
  // so the same real winner doesn't get posted again just because a scheduled check happened to
  // run and it's still technically "the best." Manual /shorts now ignores this and always posts.
  if (best) best.isFresh = !recentSymbols.has(best.symbol);
  return best;
}

module.exports = { findBestCall, MIN_FEATURE_PCT_CHANGE };
