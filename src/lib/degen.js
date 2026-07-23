// /degen scan logic: brand-new Solana pairs showing real liquidity, real buy pressure, and a
// minimum market cap -- screened afterward against known rug-pull patterns via RugCheck. Momentum
// + volume + liquidity, not RSI/MACD/ADX -- DexScreener has no historical candles, so the
// indicator engine in indicators.js literally cannot run on this data. See dexscreener.js for
// that limitation and why this is a separate command from /discover, not an extension of it.
//
// This is meaningfully higher risk than everything else in this bot. The risk screen below
// (mint/freeze authority, RugCheck's own score, insider-wallet clustering, holder concentration)
// catches known rug-pull *patterns* -- it cannot guarantee a token isn't a scam. A coordinated
// team can pass every one of these checks and still dump on holders. Treat every alert as a
// starting point for your own research, not a verdict.

const { fetchNewSolanaTokens, fetchTokenTradingData } = require("./dexscreener");
const { fetchRiskReport } = require("./rugcheck");

// Real but still low -- meme coins routinely sit in the $5K-50K range. High enough to exclude
// pools too thin to be more than a trap, low enough to not exclude the entire asset class.
const MIN_LIQUIDITY_USD = 5000;
const MIN_MARKET_CAP_USD = 50_000;
// Buys at least 2x sells in the last hour -- real accumulation pressure, not a coin flip.
const MIN_BUY_SELL_RATIO = 2.0;
// Minimum h1 buy+sell count so the ratio isn't computed from a handful of trades (3 buys vs 1
// sell is a 3x ratio and means nothing).
const MIN_H1_TXNS = 20;
// A real gap this filter had until a live alert fired on a coin already rolling over (confirmed
// against real DexScreener data: it had more buy transactions than sell transactions in the hour
// leading up to the check, while the price itself was already reversing hard). Transaction COUNT
// favoring buys doesn't mean the PRICE went up -- many small buyers can still lose to fewer,
// bigger sellers. Require confirmed price appreciation over the hour, and reject anything already
// dropping in just the last 5 minutes even if the hour overall still looks fine.
const MIN_H1_PRICE_CHANGE_PCT = 5;
const MAX_M5_PRICE_DROP_PCT = -5;
// "New," not "been trading for a month" -- pairCreatedAt is a real on-chain timestamp.
const MAX_PAIR_AGE_HOURS = 48;
// RugCheck's own 0-100 risk score (higher = riskier). A judgment call, not a documented cutoff --
// legitimate tokens checked during development scored in the low single digits.
const MAX_RUGCHECK_SCORE = 50;
// No single wallet (besides the pool itself) should hold more than this share of supply -- an
// easy, sudden dump risk RugCheck's own score doesn't always flag (caught a real 42%-held
// copycat token during testing that still scored as "safe").
const MAX_TOP_HOLDER_PCT = 20;

// A token can have multiple pools (pairs); use whichever has the most liquidity as canonical.
function pickBestPair(pairs) {
  return pairs.reduce((best, p) => {
    const liq = p.liquidity?.usd || 0;
    return !best || liq > (best.liquidity?.usd || 0) ? p : best;
  }, null);
}

// Pump.fun tokens still on their bonding curve (not yet migrated to a real AMM pool) have no
// liquidity pool at all -- DexScreener omits the field entirely rather than reporting zero.
function isBondingCurve(pair) {
  return pair.dexId === "pumpfun" && pair.liquidity == null;
}

// A hard age cutoff applies even to the "closest" fallback below -- there's no version of "close
// to qualifying" that should include a coin that's just not new anymore.
function isTooOld(pair) {
  if (!pair.pairCreatedAt) return false;
  return (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60) > MAX_PAIR_AGE_HOURS;
}

// Everything /degen actually screens for EXCEPT age -- split out so /breakout (same liquidity/
// market-cap/buy-pressure/momentum/RugCheck bar, but deliberately no "must be new" requirement)
// can reuse the identical trading-criteria logic without inheriting the age cutoff too. The specs
// are the specs regardless of how old the coin is; only /degen cares about newness specifically.
function meetsTradingCriteria(pair) {
  if (!pair) return false;
  // Only enforce the liquidity floor on tokens that actually have a pool to measure; bonding-
  // curve tokens still have to clear market cap, buy pressure, price momentum, and the RugCheck
  // screen below like everything else.
  if (!isBondingCurve(pair) && (pair.liquidity?.usd || 0) < MIN_LIQUIDITY_USD) return false;
  if ((pair.marketCap || 0) < MIN_MARKET_CAP_USD) return false;

  const h1 = pair.txns?.h1;
  if (!h1) return false;
  if (h1.buys + h1.sells < MIN_H1_TXNS) return false;
  const ratio = h1.sells > 0 ? h1.buys / h1.sells : (h1.buys > 0 ? Infinity : 0);
  if (ratio < MIN_BUY_SELL_RATIO) return false;

  const h1Change = pair.priceChange?.h1;
  if (h1Change == null || h1Change < MIN_H1_PRICE_CHANGE_PCT) return false;
  const m5Change = pair.priceChange?.m5;
  if (m5Change != null && m5Change < MAX_M5_PRICE_DROP_PCT) return false;

  return true;
}

function qualifies(pair) {
  return meetsTradingCriteria(pair) && !isTooOld(pair);
}

// 0-1 "how close is this to qualifying" score across the soft (continuous) criteria, taking the
// WEAKEST one -- a coin that's great on liquidity but has terrible buy pressure isn't "close"
// just because one metric looks good. 1.0 on a given metric means it already clears that bar.
// Deliberately does NOT cover the RugCheck risk screen or the age cutoff -- those stay hard
// requirements even for the "closest" fallback (see findDegenCandidates), since "closest to
// qualifying" should never mean "closest except for the part where it might be a scam."
function closenessScore(pair) {
  const scores = [];

  if (!isBondingCurve(pair)) {
    scores.push(Math.min(1, (pair.liquidity?.usd || 0) / MIN_LIQUIDITY_USD));
  }
  scores.push(Math.min(1, (pair.marketCap || 0) / MIN_MARKET_CAP_USD));

  const h1 = pair.txns?.h1;
  const h1Total = h1 ? h1.buys + h1.sells : 0;
  if (h1Total > 0) {
    const ratio = h1.sells > 0 ? h1.buys / h1.sells : MIN_BUY_SELL_RATIO;
    scores.push(Math.min(1, ratio / MIN_BUY_SELL_RATIO));
    scores.push(Math.min(1, h1Total / MIN_H1_TXNS));
  } else {
    scores.push(0);
  }

  const h1Change = pair.priceChange?.h1;
  scores.push(h1Change != null ? Math.min(1, Math.max(0, h1Change) / MIN_H1_PRICE_CHANGE_PCT) : 0);

  const m5Change = pair.priceChange?.m5;
  if (m5Change == null || m5Change >= MAX_M5_PRICE_DROP_PCT) scores.push(1);
  else scores.push(Math.max(0, 1 + (m5Change - MAX_M5_PRICE_DROP_PCT) / 20));

  return Math.min(...scores);
}

// Human-readable list of exactly which criteria this candidate fell short on -- so a "closest"
// result shows its actual gaps instead of just a vague "didn't qualify."
function describeShortfalls(pair) {
  const gaps = [];
  if (!isBondingCurve(pair) && (pair.liquidity?.usd || 0) < MIN_LIQUIDITY_USD) {
    gaps.push(`Liquidity $${(pair.liquidity?.usd || 0).toFixed(0)} (need $${MIN_LIQUIDITY_USD.toLocaleString()})`);
  }
  if ((pair.marketCap || 0) < MIN_MARKET_CAP_USD) {
    gaps.push(`Market cap $${(pair.marketCap || 0).toFixed(0)} (need $${MIN_MARKET_CAP_USD.toLocaleString()})`);
  }
  const h1 = pair.txns?.h1 || { buys: 0, sells: 0 };
  const h1Total = h1.buys + h1.sells;
  if (h1Total < MIN_H1_TXNS) {
    gaps.push(`Only ${h1Total} trades in the last hour (need ${MIN_H1_TXNS}+)`);
  } else {
    const ratio = h1.sells > 0 ? h1.buys / h1.sells : Infinity;
    if (ratio < MIN_BUY_SELL_RATIO) gaps.push(`Buy/sell ratio ${ratio.toFixed(1)}x (need ${MIN_BUY_SELL_RATIO}x)`);
  }
  const h1Change = pair.priceChange?.h1;
  if (h1Change == null || h1Change < MIN_H1_PRICE_CHANGE_PCT) {
    gaps.push(`1h price change ${h1Change != null ? h1Change.toFixed(1) + "%" : "unknown"} (need +${MIN_H1_PRICE_CHANGE_PCT}%)`);
  }
  const m5Change = pair.priceChange?.m5;
  if (m5Change != null && m5Change < MAX_M5_PRICE_DROP_PCT) {
    gaps.push(`Dropping ${m5Change.toFixed(1)}% in the last 5min (already reversing)`);
  }
  return gaps;
}

// Returns { passed, reason, report } -- reason is set (and passed=false) the first known
// rug-pull pattern is found; report is always returned (even on failure) so callers can show
// real numbers, not just a pass/fail.
async function checkRisk(mintAddress) {
  const report = await fetchRiskReport(mintAddress);

  if (report.rugged) return { passed: false, reason: "RugCheck has already flagged this token as rugged", report };
  if (report.token?.mintAuthority) return { passed: false, reason: "Mint authority not renounced (supply can be inflated)", report };
  if (report.token?.freezeAuthority) return { passed: false, reason: "Freeze authority not renounced (accounts can be frozen)", report };
  if (report.graphInsidersDetected) return { passed: false, reason: "RugCheck detected a connected/insider wallet cluster", report };
  if ((report.score_normalised ?? report.score ?? 0) > MAX_RUGCHECK_SCORE) {
    return { passed: false, reason: `RugCheck risk score too high (${report.score_normalised ?? report.score})`, report };
  }
  const topHolderPct = report.topHolders?.[0]?.pct || 0;
  if (topHolderPct > MAX_TOP_HOLDER_PCT) {
    return { passed: false, reason: `Top holder controls ${topHolderPct.toFixed(0)}% of supply`, report };
  }

  return { passed: true, reason: null, report };
}

// alertedAddresses: a Set of token addresses already surfaced in a previous run, so the same
// token doesn't get re-alerted every scan just for still being in DexScreener's rolling
// "newest profiles" feed. includeClosest: only set by /degen now (the manual, on-demand
// trigger) -- when nothing fully qualifies, finds the single closest candidate (by
// closenessScore, still required to pass the RugCheck risk screen and the age cutoff) so a
// manual request always returns something to look at. Scheduled runs never pass this: showing a
// "closest, still failed" coin automatically every few minutes would spam and defeat the point
// of the filter -- the fallback only makes sense when a human explicitly asked right now.
async function findDegenCandidates(alertedAddresses, { includeClosest = false } = {}) {
  const newTokens = await fetchNewSolanaTokens();
  if (!newTokens.length) return { checked: 0, candidates: [], closest: null };

  const addresses = newTokens.map(t => t.tokenAddress);
  const allPairs = await fetchTokenTradingData("solana", addresses);

  const byToken = new Map();
  for (const pair of allPairs) {
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    if (!byToken.has(addr)) byToken.set(addr, []);
    byToken.get(addr).push(pair);
  }

  // DexScreener-side qualification first (cheap, one batched call already done above) --
  // RugCheck is only called for candidates that already cleared liquidity/market cap/buy
  // pressure/age, to keep the risk-screen call count small.
  const preQualified = [];
  const nearMisses = []; // { pair, score } -- only populated when includeClosest is set
  for (const [addr, pairs] of byToken) {
    if (alertedAddresses.has(addr)) continue;
    const best = pickBestPair(pairs);
    if (!best || isTooOld(best)) continue;

    if (qualifies(best)) preQualified.push(best);
    else if (includeClosest) nearMisses.push({ pair: best, score: closenessScore(best) });
  }

  const candidates = [];
  for (const pair of preQualified) {
    try {
      const { passed, reason, report } = await checkRisk(pair.baseToken.address);
      if (!passed) {
        console.error(`Degen candidate rejected by risk screen: ${pair.baseToken.symbol} -- ${reason}`);
        continue;
      }
      candidates.push({ ...pair, riskReport: report });
    } catch (err) {
      console.error(`Risk check failed for ${pair.baseToken.symbol}: ${err.message}`);
    }
  }

  let closest = null;
  if (includeClosest && !candidates.length && nearMisses.length) {
    nearMisses.sort((a, b) => b.score - a.score);
    // Try the top few by closeness score, in case the single closest one fails the risk screen
    // too -- the risk screen is never skipped just because nothing else qualified.
    for (const { pair, score } of nearMisses.slice(0, 5)) {
      try {
        const { passed, report } = await checkRisk(pair.baseToken.address);
        if (passed) {
          closest = { ...pair, riskReport: report, closenessScore: score, shortfalls: describeShortfalls(pair) };
          break;
        }
      } catch (err) {
        console.error(`Risk check failed for ${pair.baseToken.symbol}: ${err.message}`);
      }
    }
  }

  return { checked: newTokens.length, candidates, closest };
}

module.exports = {
  findDegenCandidates,
  MIN_LIQUIDITY_USD, MIN_MARKET_CAP_USD, MIN_BUY_SELL_RATIO, MIN_H1_TXNS, MAX_PAIR_AGE_HOURS,
  MIN_H1_PRICE_CHANGE_PCT, MAX_M5_PRICE_DROP_PCT,
  MAX_RUGCHECK_SCORE, MAX_TOP_HOLDER_PCT,
  // Exposed for /breakout (src/lib/breakout.js) to reuse the exact same qualification and risk-
  // screen logic against a different (not-age-restricted) candidate source.
  meetsTradingCriteria, pickBestPair, checkRisk, closenessScore, describeShortfalls
};
