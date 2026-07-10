const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { createPortfolio, applyResults, MAX_POSITIONS } = require("../src/lib/portfolio");

function result(symbol, verdict, close, low, atr = 2) {
  return { symbol, verdict, atr, last: { close, low: low != null ? low : close - 1 } };
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
