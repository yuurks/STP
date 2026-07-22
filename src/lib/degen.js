// /degen scan logic: brand-new Solana pairs showing real liquidity and real buy pressure.
// Momentum + volume + liquidity, not RSI/MACD/ADX -- DexScreener has no historical candles, so
// the indicator engine in indicators.js literally cannot run on this data. See dexscreener.js
// for that limitation and why this is a separate command from /discover, not an extension of it.
//
// This is meaningfully higher risk than everything else in this bot: rug pulls, honeypot
// contracts (can't sell), and wash-traded fake volume are common in brand-new low-liquidity
// pools, and nothing here can detect any of those in advance. A liquidity floor and a real
// buy-pressure requirement filter out some obvious noise, not those specific risks.

const { fetchNewSolanaTokens, fetchTokenTradingData } = require("./dexscreener");

// Real but still low -- meme coins routinely sit in the $5K-50K range. High enough to exclude
// pools too thin to be more than a trap, low enough to not exclude the entire asset class.
const MIN_LIQUIDITY_USD = 5000;
// Buys at least 2x sells in the last hour -- real accumulation pressure, not a coin flip.
const MIN_BUY_SELL_RATIO = 2.0;
// Minimum h1 buy+sell count so the ratio isn't computed from a handful of trades (3 buys vs 1
// sell is a 3x ratio and means nothing).
const MIN_H1_TXNS = 20;
// "New," not "been trading for a month" -- pairCreatedAt is a real on-chain timestamp.
const MAX_PAIR_AGE_HOURS = 48;

// A token can have multiple pools (pairs); use whichever has the most liquidity as canonical.
function pickBestPair(pairs) {
  return pairs.reduce((best, p) => {
    const liq = p.liquidity?.usd || 0;
    return !best || liq > (best.liquidity?.usd || 0) ? p : best;
  }, null);
}

function qualifies(pair) {
  if (!pair) return false;
  if ((pair.liquidity?.usd || 0) < MIN_LIQUIDITY_USD) return false;

  const h1 = pair.txns?.h1;
  if (!h1) return false;
  if (h1.buys + h1.sells < MIN_H1_TXNS) return false;
  const ratio = h1.sells > 0 ? h1.buys / h1.sells : (h1.buys > 0 ? Infinity : 0);
  if (ratio < MIN_BUY_SELL_RATIO) return false;

  if (pair.pairCreatedAt) {
    const ageHours = (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60);
    if (ageHours > MAX_PAIR_AGE_HOURS) return false;
  }

  return true;
}

// alertedAddresses: a Set of token addresses already surfaced in a previous run, so the same
// token doesn't get re-alerted every scan just for still being in DexScreener's rolling
// "newest profiles" feed.
async function findDegenCandidates(alertedAddresses) {
  const newTokens = await fetchNewSolanaTokens();
  if (!newTokens.length) return { checked: 0, candidates: [] };

  const addresses = newTokens.map(t => t.tokenAddress);
  const allPairs = await fetchTokenTradingData("solana", addresses);

  const byToken = new Map();
  for (const pair of allPairs) {
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    if (!byToken.has(addr)) byToken.set(addr, []);
    byToken.get(addr).push(pair);
  }

  const candidates = [];
  for (const [addr, pairs] of byToken) {
    if (alertedAddresses.has(addr)) continue;
    const best = pickBestPair(pairs);
    if (qualifies(best)) candidates.push(best);
  }

  return { checked: newTokens.length, candidates };
}

module.exports = {
  findDegenCandidates,
  MIN_LIQUIDITY_USD, MIN_BUY_SELL_RATIO, MIN_H1_TXNS, MAX_PAIR_AGE_HOURS
};
