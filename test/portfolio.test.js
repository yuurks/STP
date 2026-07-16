const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  createPortfolio, applyResults, computeDrawdown, positionSizeMultiplier, MAX_POSITIONS
} = require("../src/lib/portfolio");

// score=4, volatility=2 are the "reference" values where positionSizeMultiplier is exactly
// 1.0x, so every existing dollar-amount assertion below (e.g. "20% of cash") still holds exactly
// unless a test deliberately overrides them to test sizing itself.
function result(symbol, verdict, close, low, atr = 2, score = 4, volatility = 2) {
  return { symbol, verdict, atr, score, volatility, last: { close, low: low != null ? low : close - 1 } };
}

describe("createPortfolio", () => {
  test("starts with full cash, no positions, no trades", () => {
    const p = createPortfolio(10000);
    assert.equal(p.cash, 10000);
    assert.equal(p.startingCash, 10000);
    assert.deepEqual(p.positions, {});
    assert.deepEqual(p.closedTrades, []);
  });
});

describe("applyResults - entries", () => {
  test("opens a position on Buy with enough cash and a real ATR", () => {
    const p = createPortfolio(10000);
    const { portfolio, events } = applyResults(p, [result("AAPL", "Buy", 100, 99, 2)], 1000);
    assert.ok(portfolio.positions.AAPL);
    assert.equal(portfolio.positions.AAPL.entryPrice, 100);
    assert.equal(portfolio.positions.AAPL.stopPrice, 100 - 2 * 2);
    assert.ok(Math.abs(portfolio.cash - (10000 - 2000)) < 1e-9); // 20% of 10000 allocated
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "open");
  });

  test("does not open a position on Neutral or Sell", () => {
    const p = createPortfolio(10000);
    const { portfolio, events } = applyResults(p, [
      result("AAPL", "Neutral", 100, 99),
      result("MSFT", "Sell", 200, 198)
    ]);
    assert.deepEqual(portfolio.positions, {});
    assert.equal(events.length, 0);
  });

  test("skips opening a position without an ATR value", () => {
    const p = createPortfolio(10000);
    const { portfolio, events } = applyResults(p, [{ symbol: "AAPL", verdict: "Buy", atr: null, last: { close: 100, low: 99 } }]);
    assert.deepEqual(portfolio.positions, {});
    assert.equal(events.length, 0);
  });

  test("does not open a duplicate position for a symbol already held", () => {
    const p = createPortfolio(10000);
    p.positions.AAPL = { entryPrice: 90, shares: 10, stopPrice: 80, verdict: "Buy", openedAt: 1 };
    const { portfolio, events } = applyResults(p, [result("AAPL", "Buy", 100, 99)]);
    assert.equal(Object.keys(portfolio.positions).length, 1);
    assert.equal(portfolio.positions.AAPL.entryPrice, 90); // untouched, not re-bought at the new price
    assert.equal(events.length, 0);
  });

  test("never opens more than MAX_POSITIONS at once", () => {
    const p = createPortfolio(1000000);
    const results = Array.from({ length: MAX_POSITIONS + 5 }, (_, i) => result(`SYM${i}`, "Buy", 100, 99));
    const { portfolio } = applyResults(p, results);
    assert.equal(Object.keys(portfolio.positions).length, MAX_POSITIONS);
  });

  test("stops opening new positions once cash runs out", () => {
    const p = createPortfolio(10); // trivially small starting cash
    const results = Array.from({ length: 5 }, (_, i) => result(`SYM${i}`, "Buy", 100, 99));
    const { portfolio } = applyResults(p, results);
    // 20% of $10 = $2 for the first position, then 20% of $8 = $1.60, etc. -- should still open
    // a couple before allocation drops under the $1 floor, but never go cash-negative.
    assert.ok(portfolio.cash >= 0);
  });
});

describe("applyResults - exits", () => {
  test("closes a position at the stop price when the day's low breaches it, not at the close", () => {
    const p = createPortfolio(10000);
    p.positions.AAPL = { entryPrice: 100, shares: 20, stopPrice: 96, verdict: "Buy", openedAt: 1 };
    // Verdict still says Buy, but price dipped below the stop intraday (low 95, close 101).
    const { portfolio, events } = applyResults(p, [result("AAPL", "Buy", 101, 95, 2)], 2000);
    assert.equal(portfolio.positions.AAPL, undefined);
    assert.equal(portfolio.closedTrades.length, 1);
    const trade = portfolio.closedTrades[0];
    assert.equal(trade.exitPrice, 96); // stop price, not the 101 close
    assert.equal(trade.reason, "stop");
    assert.ok(Math.abs(trade.pnl - (96 - 100) * 20) < 1e-9);
    assert.equal(events[0].type, "close");
    assert.equal(events[0].reason, "stop");
  });

  test("closes a position at the close price on a Sell/Strong Sell verdict", () => {
    const p = createPortfolio(10000);
    p.positions.AAPL = { entryPrice: 100, shares: 10, stopPrice: 90, verdict: "Buy", openedAt: 1 };
    const { portfolio } = applyResults(p, [result("AAPL", "Sell", 110, 105, 2)]);
    assert.equal(portfolio.positions.AAPL, undefined);
    assert.equal(portfolio.closedTrades[0].exitPrice, 110);
    assert.equal(portfolio.closedTrades[0].reason, "sell-signal");
  });

  test("leaves a held position open on Buy or Neutral with no stop breach", () => {
    const p = createPortfolio(10000);
    p.positions.AAPL = { entryPrice: 100, shares: 10, stopPrice: 90, verdict: "Buy", openedAt: 1 };
    const { portfolio, events } = applyResults(p, [result("AAPL", "Neutral", 105, 102)]);
    assert.ok(portfolio.positions.AAPL);
    assert.equal(events.length, 0);
  });

  test("leaves a position untouched if the symbol has no data this scan", () => {
    const p = createPortfolio(10000);
    p.positions.AAPL = { entryPrice: 100, shares: 10, stopPrice: 90, verdict: "Buy", openedAt: 1 };
    const { portfolio, events } = applyResults(p, [result("MSFT", "Buy", 200, 198)]);
    assert.ok(portfolio.positions.AAPL);
    assert.equal(events.length, 1); // MSFT position opened, AAPL just left alone
    assert.equal(events[0].symbol, "MSFT");
  });

  test("a stop-out does not immediately re-open the same position in the same pass", () => {
    // The verdict can easily still read "Buy" the instant after a stop hits -- a stop is a risk
    // event, not a signal reversal, and re-buying in the very same scan would be a whipsaw loop.
    const p = createPortfolio(10000);
    p.positions.AAPL = { entryPrice: 100, shares: 20, stopPrice: 96, verdict: "Buy", openedAt: 1 };
    const { portfolio, events } = applyResults(p, [result("AAPL", "Buy", 101, 95, 2)], 2);
    assert.equal(portfolio.positions.AAPL, undefined, "AAPL should be closed, not immediately re-bought");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "close");
  });

  test("a full round trip at an unchanged price conserves total value exactly", () => {
    const p = createPortfolio(10000);
    const { portfolio: afterOpen } = applyResults(p, [result("AAPL", "Buy", 100, 99, 2)], 1);
    // Price never moves; a Sell signal arrives and closes it at the same 100.
    const { portfolio: afterClose } = applyResults(afterOpen, [result("AAPL", "Sell", 100, 98, 2)], 2);
    assert.equal(Object.keys(afterClose.positions).length, 0);
    assert.ok(Math.abs(afterClose.cash - 10000) < 1e-9, `expected cash back to 10000, got ${afterClose.cash}`);
    assert.equal(afterClose.closedTrades[0].pnl, 0);
  });
});

describe("positionSizeMultiplier", () => {
  test("is exactly 1.0x at reference conviction and volatility", () => {
    assert.ok(Math.abs(positionSizeMultiplier(4, 2) - 1.0) < 1e-9);
  });

  test("a higher-conviction score gets a bigger multiplier than a bare Buy", () => {
    const strong = positionSizeMultiplier(8, 2);
    const bare = positionSizeMultiplier(2, 2);
    assert.ok(strong > bare, `expected strong-conviction (${strong}) > bare (${bare})`);
  });

  test("a more volatile ticker gets a smaller multiplier at the same conviction", () => {
    const calm = positionSizeMultiplier(4, 1);
    const wild = positionSizeMultiplier(4, 8);
    assert.ok(calm > wild, `expected calm (${calm}) > wild (${wild})`);
  });
});

describe("applyResults - sizing", () => {
  test("a Strong Buy allocates more cash than a bare Buy at the same volatility", () => {
    const p1 = createPortfolio(10000);
    const { portfolio: afterBare } = applyResults(p1, [result("AAPL", "Buy", 100, 99, 2, 2, 2)]);
    const bareAllocation = 10000 - afterBare.cash;

    const p2 = createPortfolio(10000);
    const { portfolio: afterStrong } = applyResults(p2, [result("MSFT", "Strong Buy", 100, 99, 2, 8, 2)]);
    const strongAllocation = 10000 - afterStrong.cash;

    assert.ok(strongAllocation > bareAllocation, `expected Strong Buy (${strongAllocation}) > Buy (${bareAllocation})`);
  });

  test("never allocates more than MAX_ALLOCATION_PCT of cash to one position, even at max multiplier", () => {
    const p = createPortfolio(10000);
    // score=8 (near-max conviction) + volatility=0.5 (near-max multiplier) -> should hit the cap
    const { portfolio } = applyResults(p, [result("AAPL", "Strong Buy", 100, 99, 2, 8, 0.5)]);
    const allocation = 10000 - portfolio.cash;
    assert.ok(allocation <= 10000 * 0.40 + 1e-6, `expected allocation (${allocation}) capped at 40% of cash`);
  });
});

describe("computeDrawdown", () => {
  test("zero drawdown on a strictly rising curve", () => {
    const curve = [{ timestamp: 1, value: 100 }, { timestamp: 2, value: 110 }, { timestamp: 3, value: 120 }];
    const { maxDrawdownPct, currentDrawdownPct } = computeDrawdown(curve);
    assert.equal(maxDrawdownPct, 0);
    assert.equal(currentDrawdownPct, 0);
  });

  test("reports the correct max drawdown from a peak, even after partial recovery", () => {
    const curve = [
      { timestamp: 1, value: 100 },
      { timestamp: 2, value: 200 }, // peak
      { timestamp: 3, value: 100 }, // -50% from peak
      { timestamp: 4, value: 150 }  // recovers partway -- current drawdown is -25%, not -50%
    ];
    const { maxDrawdownPct, currentDrawdownPct } = computeDrawdown(curve);
    assert.ok(Math.abs(maxDrawdownPct - 50) < 1e-9, `expected max drawdown 50%, got ${maxDrawdownPct}`);
    assert.ok(Math.abs(currentDrawdownPct - 25) < 1e-9, `expected current drawdown 25%, got ${currentDrawdownPct}`);
  });

  test("handles an empty curve without throwing", () => {
    const { maxDrawdownPct, currentDrawdownPct, peakValue } = computeDrawdown([]);
    assert.equal(maxDrawdownPct, 0);
    assert.equal(currentDrawdownPct, 0);
    assert.equal(peakValue, null);
  });
});

describe("equity curve recording", () => {
  test("starts with one snapshot at the starting cash", () => {
    const p = createPortfolio(5000);
    assert.equal(p.equityCurve.length, 1);
    assert.equal(p.equityCurve[0].value, 5000);
  });

  test("records a new snapshot after the throttle interval has passed", () => {
    const p = createPortfolio(10000);
    const HOUR = 60 * 60 * 1000;
    const { portfolio } = applyResults(p, [result("AAPL", "Neutral", 100, 99)], p.startedAt + HOUR + 1);
    assert.equal(portfolio.equityCurve.length, 2);
  });

  test("does not record a second snapshot within the throttle interval", () => {
    const p = createPortfolio(10000);
    const { portfolio } = applyResults(p, [result("AAPL", "Neutral", 100, 99)], p.startedAt + 1000);
    assert.equal(portfolio.equityCurve.length, 1);
  });
});
