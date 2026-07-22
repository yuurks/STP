// Shared price formatting. A flat 2 decimals (the obvious default) shows "$0.00" for any
// sub-half-cent price -- which most of this bot's actual candidate pool trades at, now that it's
// crypto-only and specifically skewed toward small/mid-cap coins (e.g. DGB/USD around $0.003).
// Scales decimal places to the price's own magnitude so a real, non-zero number always shows.
// Not for aggregate dollar amounts (portfolio cash, total value, P&L) -- those are legitimately
// fine at 2 decimals since they're dollar sums, not a single coin's per-unit price.
function formatMoney(n) {
  const abs = Math.abs(n);
  let decimals = 2;
  if (abs > 0 && abs < 1) {
    decimals = Math.min(8, Math.max(2, -Math.floor(Math.log10(abs)) + 2));
  }
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

module.exports = { formatMoney };
