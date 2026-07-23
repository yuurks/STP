const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { isCryptoTicker, normalizeSymbol } = require("../src/lib/watchlist");

describe("isCryptoTicker", () => {
  test("accepts a BASE/QUOTE pair", () => {
    assert.equal(isCryptoTicker("BTC/USD"), true);
  });

  test("accepts a BASE-QUOTE pair", () => {
    assert.equal(isCryptoTicker("BTC-USD"), true);
  });

  test("rejects a bare stock-shaped ticker", () => {
    // The exact bug this guards against: a stock ticker like AAPL, added back before this bot
    // went crypto-only, used to pass validation and would sit on a watchlist getting scanned
    // forever since nothing ever rejected it.
    assert.equal(isCryptoTicker("AAPL"), false);
  });

  test("rejects garbage that isn't a well-formed ticker at all", () => {
    assert.equal(isCryptoTicker(""), false);
    assert.equal(isCryptoTicker("this is not a ticker"), false);
  });
});

describe("normalizeSymbol", () => {
  test("leaves an already-slashed pair alone", () => {
    assert.equal(normalizeSymbol("btc/usd"), "BTC/USD");
  });

  test("converts a dash-separated pair to slash form", () => {
    assert.equal(normalizeSymbol("btc-usd"), "BTC/USD");
  });

  test("still normalizes a legacy bare ticker (so /watch remove can clean it up)", () => {
    assert.equal(normalizeSymbol("aapl"), "AAPL");
  });
});
