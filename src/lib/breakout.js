// /breakout: the same liquidity/market-cap/buy-pressure/momentum bar and RugCheck risk screen as
// /degen, but candidates come from Raydium's full pool list (see raydium.js) instead of
// DexScreener's "newest profiles" feed, and there is deliberately no age cutoff -- /degen exists
// specifically for brand-new plays; this command exists specifically so "it's not new" isn't a
// disqualifier by itself. An established coin breaking out on real volume is a legitimate signal
// too, and shouldn't need to pretend to be a brand-new pair to get looked at.
//
// Same risk framing as /degen applies here: this is momentum + a RugCheck screen, not RSI/MACD/
// ADX (DexScreener has no historical candles for either command to run that on), and the RugCheck
// screen reduces exposure to known rug-pull patterns -- it does not guarantee anything.

const { fetchBreakoutCandidates } = require("./raydium");
const { fetchTokenTradingData } = require("./dexscreener");
const {
  meetsTradingCriteria, pickBestPair, checkRisk, closenessScore, describeShortfalls
} = require("./degen");

// alertedAddresses: a Set of token addresses already surfaced in a previous run (same purpose as
// /degen's -- Raydium's volume-sorted list is stable enough that the same top coin could show up
// scan after scan). includeClosest: only set by /breakout now, same reasoning as /degen now.
async function findBreakoutCandidates(alertedAddresses, { includeClosest = false } = {}) {
  const addresses = await fetchBreakoutCandidates();
  if (!addresses.length) return { checked: 0, candidates: [], closest: null };

  const allPairs = await fetchTokenTradingData("solana", addresses);

  const byToken = new Map();
  for (const pair of allPairs) {
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    if (!byToken.has(addr)) byToken.set(addr, []);
    byToken.get(addr).push(pair);
  }

  const preQualified = [];
  const nearMisses = []; // { pair, score } -- only populated when includeClosest is set
  for (const [addr, pairs] of byToken) {
    if (alertedAddresses.has(addr)) continue;
    const best = pickBestPair(pairs);
    if (!best) continue;

    if (meetsTradingCriteria(best)) preQualified.push(best);
    else if (includeClosest) nearMisses.push({ pair: best, score: closenessScore(best) });
  }

  const candidates = [];
  for (const pair of preQualified) {
    try {
      const { passed, reason, report, top5HolderPct } = await checkRisk(pair.baseToken.address);
      if (!passed) {
        console.error(`Breakout candidate rejected by risk screen: ${pair.baseToken.symbol} -- ${reason}`);
        continue;
      }
      candidates.push({ ...pair, riskReport: report, top5HolderPct });
    } catch (err) {
      console.error(`Risk check failed for ${pair.baseToken.symbol}: ${err.message}`);
    }
  }

  let closest = null;
  if (includeClosest && !candidates.length && nearMisses.length) {
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

  return { checked: addresses.length, candidates, closest };
}

module.exports = { findBreakoutCandidates };
