// Simulated paper-trading portfolio, driven entirely by this bot's own signals. No real money,
// no brokerage -- just tracking what would have happened if you'd mechanically followed every
// Buy/Strong Buy and exited on every Sell/Strong Sell or 2x-ATR stop hit, long-only.
//
// Pure and deterministic given its inputs (never mutates the portfolio it's handed, never
// touches the filesystem or network) so it can be unit tested directly, the same way the
// indicator math is.

const ALLOCATION_PCT = 0.20; // % of current cash committed to each new position
const MAX_POSITIONS = 8;
const MAX_CLOSED_TRADES = 100;

function createPortfolio(startingCash) {
  return { startingCash, cash: startingCash, startedAt: Date.now(), positions: {}, closedTrades: [] };
}

// results: the same array /scan, /autoscan, and /alerts already produce -- {symbol, verdict,
// last: {close, low, ...}, atr, ...} per ticker. now: injected for testability, defaults to real time.
function applyResults(portfolio, results, now = Date.now()) {
  const next = {
    ...portfolio,
    positions: { ...portfolio.positions },
    closedTrades: [...portfolio.closedTrades]
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

  // Entries: Buy/Strong Buy on anything not already held, up to the position cap, sized as a
  // fixed % of *current* cash (so position size shrinks/grows with the portfolio's own history,
  // rather than a fixed dollar amount that ignores how it's actually doing).
  for (const r of results) {
    if (Object.keys(next.positions).length >= MAX_POSITIONS) break;
    if (next.positions[r.symbol]) continue;
    // A stop-hit exit this same pass is a risk-management event, not a signal reversal -- the
    // verdict can easily still read "Buy" right after, and without this guard the position would
    // get bought right back at (about) the same price it was just stopped out of.
    if (closedThisPass.has(r.symbol)) continue;
    if (r.verdict !== "Buy" && r.verdict !== "Strong Buy") continue;
    if (!r.atr) continue; // no ATR means no way to size a stop -- skip rather than guess

    const allocation = next.cash * ALLOCATION_PCT;
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

  return { portfolio: next, events };
}

module.exports = { createPortfolio, applyResults, ALLOCATION_PCT, MAX_POSITIONS };
