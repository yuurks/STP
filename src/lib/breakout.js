// /breakout: candidates come from Raydium's full pool list (see raydium.js) instead of
// DexScreener's "newest profiles" feed, and there is deliberately no age cutoff -- /degen exists
// specifically for brand-new plays; this command exists specifically so "it's not new" isn't a
// disqualifier by itself. An established coin breaking out on real volume is a legitimate signal
// too, and shouldn't need to pretend to be a brand-new pair to get looked at.
//
// Three tiers, most to least confident:
//  - Confirmed Reload: the exact same momentum bar /degen uses (meetsTradingCriteria), just
//    gated by a much higher "proven" market-cap/liquidity floor than /degen's brand-new-coin bar
//    -- these are coins that already demonstrated real size, not ones merely too big to be a
//    trivial manipulation trap.
//  - Early Signal: same proven floor, but a softer momentum bar -- buy pressure ticking up and
//    price not falling, short of a confirmed 5%+/hr move. Lower confidence by design.
//  - Within Early Signal, a candidate additionally gets "off its peak" framing (real numbers, via
//    tokenPeaks.js) when its current market cap sits well below the highest this bot has itself
//    ever recorded for it -- e.g. a coin that ran to $20M and has since dumped to $5M still has
//    real room to climb back, which a single current snapshot can't show without that history.
//
// Same risk framing as /degen applies throughout: this is momentum + a RugCheck screen, not
// RSI/MACD/ADX (DexScreener has no historical candles for any of this to run on), and the
// RugCheck screen reduces exposure to known rug-pull patterns -- it does not guarantee anything.

const { fetchBreakoutCandidates } = require("./raydium");
const { fetchTokenTradingData } = require("./dexscreener");
const tokenPeaks = require("./tokenPeaks");
const {
  meetsTradingCriteria, pickBestPair, checkRisk, closenessScore, describeShortfalls,
  MAX_M5_PRICE_DROP_PCT
} = require("./degen");

// Meaningfully higher than /degen's brand-new-coin bar ($150K/$5K) -- these candidates are being
// asked to prove something different: not "is this liquid enough to not be a trivial trap," but
// "has this coin already demonstrated real size," which lowers (not removes) the risk of it going
// to zero. A judgment call, not a guarantee.
const MIN_PROVEN_MARKET_CAP_USD = 1_000_000;
const MIN_PROVEN_LIQUIDITY_USD = 25_000;

function meetsProvenFloor(pair) {
  return (pair.marketCap || 0) >= MIN_PROVEN_MARKET_CAP_USD &&
    (pair.liquidity?.usd || 0) >= MIN_PROVEN_LIQUIDITY_USD;
}

function meetsConfirmedReload(pair) {
  return meetsProvenFloor(pair) && meetsTradingCriteria(pair);
}

// Deliberately looser than the confirmed bar: real (if modest) buy pressure and a price that
// isn't actively falling, but no requirement that the +5%/hr move has actually happened yet.
// Plenty of coins that clear this never actually break out again -- that's the tradeoff for
// catching the ones that do before the move is already obvious.
const MIN_EARLY_BUY_SELL_RATIO = 1.3;
const MIN_EARLY_H1_TXNS = 15;

function meetsEarlySignal(pair) {
  if (!meetsProvenFloor(pair)) return false;
  if (meetsConfirmedReload(pair)) return false; // stronger tier already covers it

  const h1 = pair.txns?.h1;
  if (!h1) return false;
  if (h1.buys + h1.sells < MIN_EARLY_H1_TXNS) return false;
  const ratio = h1.sells > 0 ? h1.buys / h1.sells : (h1.buys > 0 ? Infinity : 0);
  if (ratio < MIN_EARLY_BUY_SELL_RATIO) return false;

  const h1Change = pair.priceChange?.h1;
  if (h1Change != null && h1Change < 0) return false; // not actively falling over the last hour
  const m5Change = pair.priceChange?.m5;
  if (m5Change != null && m5Change < MAX_M5_PRICE_DROP_PCT) return false; // reject a live dump

  return true;
}

// How far below its own recorded peak a coin needs to sit before it's worth framing as "off its
// highs, real room to climb back" rather than just "proven and basing near current levels."
const DIP_RECOVERY_MAX_RATIO = 0.6; // current marketCap <= 60% of the recorded peak (down 40%+)

function dipRecoveryInfo(pair, previousPeak) {
  if (!previousPeak) return null;
  const cap = pair.marketCap || 0;
  if (cap <= 0 || cap > previousPeak.marketCap * DIP_RECOVERY_MAX_RATIO) return null;
  return {
    peakMarketCap: previousPeak.marketCap,
    peakTimestamp: previousPeak.peakTimestamp,
    offPeakPct: (1 - cap / previousPeak.marketCap) * 100
  };
}

// alertedAddresses: a Set of "address:tier" keys already surfaced in a previous run (composite,
// not just the bare address -- so a coin that already fired as Early Signal can still fire again
// once it actually confirms as Reload later; those are different, both-worth-seeing claims, not
// a repeat of the same one). includeClosest: only set by /breakout now, same reasoning as
// /degen now.
async function findBreakoutCandidates(alertedKeys, { includeClosest = false } = {}) {
  const addresses = await fetchBreakoutCandidates();
  if (!addresses.length) return { checked: 0, confirmed: [], earlySignal: [], closest: null };

  const allPairs = await fetchTokenTradingData("solana", addresses);

  const byToken = new Map();
  for (const pair of allPairs) {
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    if (!byToken.has(addr)) byToken.set(addr, []);
    byToken.get(addr).push(pair);
  }

  const bestByToken = new Map();
  for (const [addr, pairs] of byToken) {
    const best = pickBestPair(pairs);
    if (best) bestByToken.set(addr, best);
  }

  // Recorded against every token this scan actually saw, regardless of which (if any) tier it
  // qualifies for -- peak tracking needs to stay accurate independent of this run's filters.
  const previousPeaks = tokenPeaks.recordObservations(
    [...bestByToken.entries()].map(([addr, best]) => ({ address: addr, marketCap: best.marketCap || 0 }))
  );

  const preQualifiedConfirmed = [];
  const preQualifiedEarly = []; // { pair, dip }
  const nearMisses = []; // { pair, score } -- only populated when includeClosest is set
  for (const [addr, best] of bestByToken) {
    if (meetsConfirmedReload(best)) {
      if (!alertedKeys.has(`${addr}:confirmed`)) preQualifiedConfirmed.push(best);
    } else if (meetsEarlySignal(best)) {
      const dip = dipRecoveryInfo(best, previousPeaks.get(addr));
      // Dip-recovery gets its own dedup key, separate from a plain early-signal alert -- "this
      // coin is showing early momentum" and "this coin is now 51% off a real recorded peak, with
      // room to climb back" are different, both-worth-seeing claims about the same token, even
      // though they route through the same tier. Without this, a coin alerted once as plain early
      // signal (before it had any peak history yet) would stay permanently suppressed even after
      // it develops real, newsworthy dip info later -- confirmed against real data: CATE fired
      // once on the way up to its $47M peak, then never fired again even after dropping 51% off
      // that exact peak, because the single "early" flag was already used.
      const dedupKey = dip ? `${addr}:dip` : `${addr}:early`;
      if (!alertedKeys.has(dedupKey)) {
        preQualifiedEarly.push({ pair: best, dip });
      }
    } else if (includeClosest) {
      nearMisses.push({ pair: best, score: closenessScore(best) });
    }
  }

  const confirmed = [];
  for (const pair of preQualifiedConfirmed) {
    try {
      const { passed, reason, report, top5HolderPct } = await checkRisk(pair.baseToken.address);
      if (!passed) {
        console.error(`Breakout (confirmed) candidate rejected by risk screen: ${pair.baseToken.symbol} -- ${reason}`);
        continue;
      }
      confirmed.push({ ...pair, riskReport: report, top5HolderPct });
    } catch (err) {
      console.error(`Risk check failed for ${pair.baseToken.symbol}: ${err.message}`);
    }
  }

  const earlySignal = [];
  for (const { pair, dip } of preQualifiedEarly) {
    try {
      const { passed, reason, report, top5HolderPct } = await checkRisk(pair.baseToken.address);
      if (!passed) {
        console.error(`Breakout (early signal) candidate rejected by risk screen: ${pair.baseToken.symbol} -- ${reason}`);
        continue;
      }
      earlySignal.push({ ...pair, riskReport: report, top5HolderPct, dip });
    } catch (err) {
      console.error(`Risk check failed for ${pair.baseToken.symbol}: ${err.message}`);
    }
  }

  let closest = null;
  if (includeClosest && !confirmed.length && !earlySignal.length && nearMisses.length) {
    nearMisses.sort((a, b) => b.score - a.score);
    for (const { pair, score } of nearMisses.slice(0, 5)) {
      try {
        const { passed, report, top5HolderPct } = await checkRisk(pair.baseToken.address);
        if (passed) {
          closest = { ...pair, riskReport: report, top5HolderPct, closenessScore: score, shortfalls: describeShortfalls(pair) };
          break;
        }
      } catch (err) {
        console.error(`Risk check failed for ${pair.baseToken.symbol}: ${err.message}`);
      }
    }
  }

  return { checked: addresses.length, confirmed, earlySignal, closest };
}

module.exports = {
  findBreakoutCandidates,
  MIN_PROVEN_MARKET_CAP_USD, MIN_PROVEN_LIQUIDITY_USD,
  MIN_EARLY_BUY_SELL_RATIO, MIN_EARLY_H1_TXNS, DIP_RECOVERY_MAX_RATIO
};
