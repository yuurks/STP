// Simulated paper-trading portfolio, driven entirely by this bot's own signals. No real money,
// no brokerage -- just tracking what would have happened if you'd mechanically followed every
// Buy/Strong Buy and exited on every Sell/Strong Sell or 2x-ATR stop hit, long-only.
//
// Pure and deterministic given its inputs (never mutates the portfolio it's handed, never
// touches the filesystem or network) so it can be unit tested directly, the same way the
// indicator math is.

const BASE_ALLOCATION_PCT = 0.20; // % of current cash at the "reference" conviction/volatility
const MAX_ALLOCATION_PCT = 0.40; // hard cap per position no matter how the multiplier scales it
const MAX_POSITIONS = 8;
const MAX_CLOSED_TRADES = 100;
const MIN_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // don't record equity more than once/hour
const MAX_EQUITY_POINTS = 1000; // ~41 days at 1/hour

function createPortfolio(startingCash) {
  const startedAt = Date.now();
  return {
    startingCash, cash: startingCash, startedAt, positions: {}, closedTrades: [],
    equityCurve: [{ timestamp: startedAt, value: startingCash }]
  };
}

// Scales the base allocation by conviction (score magnitude -- a bare Buy at score 2 gets less
// than a Strong Buy at score 6+) and inversely by volatility (a calmer ticker gets a bigger slice
// than a wild one, so two positions carry roughly similar dollar risk instead of similar dollar
// size). Both factors are clamped so neither can push the multiplier to an extreme on its own.
const REFERENCE_VOLATILITY = 2; // % daily stdev treated as "normal"
function positionSizeMultiplier(score, volatility) {
  const convictionFactor = Math.min(1.4, Math.max(0.6, Math.abs(score) / 4));
  const volatilityFactor = Math.min(1.5, Math.max(0.5, REFERENCE_VOLATILITY / Math.max(volatility, 0.5)));
  return convictionFactor * volatilityFactor;
}

// Max peak-to-trough decline in the recorded equity curve, plus how far below the all-time peak
// the most recent point sits. The single most important number for judging whether a strategy's
// *path* to a given return was smooth or harrowing -- something the current-value snapshot alone
// can't tell you.
function computeDrawdown(equityCurve) {
  if (!equityCurve.length) return { maxDrawdownPct: 0, currentDrawdownPct: 0, peakValue: null };
  let peak = equityCurve[0].value;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.value > peak) peak = point.value;
    const drawdown = peak > 0 ? (peak - point.value) / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  const latest = equityCurve[equityCurve.length - 1].value;
  const currentDrawdown = peak > 0 ? (peak - latest) / peak : 0;
  return { maxDrawdownPct: maxDrawdown * 100, currentDrawdownPct: currentDrawdown * 100, peakValue: peak };
}

// results: the same array /scan, /autoscan, and /alerts already produce -- {symbol, verdict,
// last: {close, low, ...}, atr, score, volatility, ...} per ticker. now: injected for
// testability, defaults to real time.
function applyResults(portfolio, results, now = Date.now()) {
  const next = {
    ...portfolio,
    positions: { ...portfolio.positions },
    closedTrades: [...portfolio.closedTrades],
    equityCurve: [...(portfolio.equityCurve || [])]
  };
  const events = [];
  const bySymbol = new Map(results.map(r => [r.symbol, r]));
  const closedThisPass = new Set();

  // Exits first: a stop hit or an active sell signal on anything currently held.
  for (const [symbol, pos] of Object.entries(next.positions)) {
    const r = bySymbol.get(symbol);
    if (!r) continue; // no fresh data for this symbol this scan -- leave the position alone

    let exitPrice = null;
    let reason = null;
    if (r.last.low <= pos.stopPrice) {
      exitPrice = pos.stopPrice;
      reason = "stop";
    } else if (r.verdict === "Sell" || r.verdict === "Strong Sell") {
      exitPrice = r.last.close;
      reason = "sell-signal";
    }

    if (exitPrice != null) {
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;
      next.cash += pos.shares * exitPrice;
      next.closedTrades.push({
        symbol, entryPrice: pos.entryPrice, exitPrice, shares: pos.shares,
        openedAt: pos.openedAt, closedAt: now, reason,
        pnl, pnlPct: (pnl / (pos.entryPrice * pos.shares)) * 100
      });
      delete next.positions[symbol];
      closedThisPass.add(symbol);
      events.push({ type: "close", symbol, reason, pnl });
    }
  }
  if (next.closedTrades.length > MAX_CLOSED_TRADES) {
    next.closedTrades = next.closedTrades.slice(-MAX_CLOSED_TRADES);
  }

  // Entries: Buy/Strong Buy on anything not already held, up to the position cap. Sized as a %
  // of *current* cash (so size shrinks/grows with the portfolio's own history) scaled by
  // conviction and volatility rather than a single flat percentage for every signal.
  for (const r of results) {
    if (Object.keys(next.positions).length >= MAX_POSITIONS) break;
    if (next.positions[r.symbol]) continue;
    // A stop-hit exit this same pass is a risk-management event, not a signal reversal -- the
    // verdict can easily still read "Buy" right after, and without this guard the position would
    // get bought right back at (about) the same price it was just stopped out of.
    if (closedThisPass.has(r.symbol)) continue;
    if (r.verdict !== "Buy" && r.verdict !== "Strong Buy") continue;
    if (!r.atr) continue; // no ATR means no way to size a stop -- skip rather than guess

    const multiplier = positionSizeMultiplier(r.score, r.volatility ?? REFERENCE_VOLATILITY);
    const allocation = Math.min(next.cash * MAX_ALLOCATION_PCT, next.cash * BASE_ALLOCATION_PCT * multiplier);
    if (allocation < 1) continue; // effectively out of cash
    const shares = allocation / r.last.close;
    next.cash -= allocation;
    next.positions[r.symbol] = {
      entryPrice: r.last.close, shares,
      stopPrice: r.last.close - 2 * r.atr,
      verdict: r.verdict, openedAt: now
    };
    events.push({ type: "open", symbol: r.symbol, shares, price: r.last.close });
  }

  // Equity snapshot, throttled to at most once/hour: values each open position at this scan's
  // fresh price where available, falling back to its entry price for positions this particular
  // scan didn't cover (e.g. held but off the current watchlist).
  const lastSnapshot = next.equityCurve[next.equityCurve.length - 1];
  if (!lastSnapshot || now - lastSnapshot.timestamp >= MIN_SNAPSHOT_INTERVAL_MS) {
    let marketValue = 0;
    for (const [symbol, pos] of Object.entries(next.positions)) {
      const price = bySymbol.get(symbol)?.last.close ?? pos.entryPrice;
      marketValue += pos.shares * price;
    }
    next.equityCurve.push({ timestamp: now, value: next.cash + marketValue });
    if (next.equityCurve.length > MAX_EQUITY_POINTS) {
      next.equityCurve = next.equityCurve.slice(-MAX_EQUITY_POINTS);
    }
  }

  return { portfolio: next, events };
}

module.exports = {
  createPortfolio, applyResults, computeDrawdown, positionSizeMultiplier,
  BASE_ALLOCATION_PCT, MAX_ALLOCATION_PCT, MAX_POSITIONS
};
