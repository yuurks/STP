const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  findUnfilledGap, atr, adx, backtest, scoreAt,
  dailyReturns, correlation, avgDollarVolume, selectDiversified
} = require("../src/lib/indicators");

function row(date, high, low, close, volume = 1000000) {
  return { date, open: (high + low) / 2, high, low, close, volume };
}

describe("findUnfilledGap", () => {
  test("no gap when ranges overlap", () => {
    const rows = [
      row("d1", 10, 9, 9.5),
      row("d2", 10.5, 9.2, 10)
    ];
    assert.equal(findUnfilledGap(rows), null);
  });

  test("gap up stays unfilled if nothing trades back down to it", () => {
    const rows = [
      row("d1", 10, 9, 9.5),
      row("d2", 12, 11, 11.5) // low 11 > prev high 10 -> gap up
    ];
    const gap = findUnfilledGap(rows);
    assert.ok(gap);
    assert.equal(gap.type, "up");
    assert.equal(gap.direction, "down");
    assert.equal(gap.level, 10);
    assert.ok(Math.abs(gap.distance - 1.5) < 1e-9);
  });

  test("gap up disappears once a later low trades back through it", () => {
    const rows = [
      row("d1", 10, 9, 9.5),
      row("d2", 12, 11, 11.5), // gap up, level 10
      row("d3", 11, 9.5, 10)   // low 9.5 <= 10 -> fills it
    ];
    assert.equal(findUnfilledGap(rows), null);
  });

  test("gap down stays unfilled if nothing trades back up to it", () => {
    const rows = [
      row("d1", 10, 9, 9.5),
      row("d2", 8, 7, 7.5) // high 8 < prev low 9 -> gap down
    ];
    const gap = findUnfilledGap(rows);
    assert.ok(gap);
    assert.equal(gap.type, "down");
    assert.equal(gap.direction, "up");
    assert.equal(gap.level, 9);
    assert.ok(Math.abs(gap.distance - 1.5) < 1e-9);
  });
});

describe("atr", () => {
  test("matches a hand-calculated Wilder ATR for a tiny series", () => {
    // Constant true range of 1 for three bars, then a bar with TR 1.5.
    const rows = [
      row("d0", 10, 9, 9.5),
      row("d1", 10.5, 9.5, 10),
      row("d2", 11, 10, 10.5),
      row("d3", 11.5, 10.5, 11),
      row("d4", 12.5, 11, 12)
    ];
    const result = atr(rows, 3);
    // First 3 TRs are all 1 -> Wilder sum = 3, ATR = 3/3 = 1.0
    assert.ok(Math.abs(result[3] - 1.0) < 1e-9, `expected ~1.0, got ${result[3]}`);
    // Next: smoothed = 3 - 3/3 + 1.5 = 3.5 -> ATR = 3.5/3
    assert.ok(Math.abs(result[4] - 3.5 / 3) < 1e-9, `expected ~1.1667, got ${result[4]}`);
  });

  test("returns nulls before the period has enough data", () => {
    const rows = [row("d0", 10, 9, 9.5), row("d1", 10.5, 9.5, 10)];
    const result = atr(rows, 3);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
  });
});

describe("adx", () => {
  function series(mode, n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      let close;
      if (mode === "trend") {
        close = 100 + i * 2;
      } else {
        // sawtooth: oscillates but goes nowhere overall
        close = 100 + (i % 2 === 0 ? 3 : -3);
      }
      rows.push(row(`d${i}`, close + 1, close - 1, close));
    }
    return rows;
  }

  test("a clean uptrend produces a high ADX", () => {
    const result = adx(series("trend", 40), 14);
    const last = result[result.length - 1];
    assert.ok(last != null, "expected a computed ADX value");
    assert.ok(last > 25, `expected strong-trend ADX > 25, got ${last}`);
  });

  test("a directionless sawtooth produces a low ADX", () => {
    const result = adx(series("choppy", 40), 14);
    const last = result[result.length - 1];
    assert.ok(last != null, "expected a computed ADX value");
    assert.ok(last < 20, `expected no-trend ADX < 20, got ${last}`);
  });

  test("trend ADX is clearly higher than choppy ADX on the same data length", () => {
    const trendLast = adx(series("trend", 40), 14).at(-1);
    const choppyLast = adx(series("choppy", 40), 14).at(-1);
    assert.ok(trendLast > choppyLast, `expected trend (${trendLast}) > choppy (${choppyLast})`);
  });
});

describe("scoreAt - Golden Cross / Death Cross", () => {
  // scoreAt takes already-enriched rows (sma50/sma200 etc. precomputed), so these are built by
  // hand rather than needing hundreds of days of raw OHLC just to get two SMA values to cross.
  function enriched(sma50, sma200) {
    return { sma50, sma200, sma20: null, ema12: null, ema26: null, rsi: null, macd: null, macdSignal: null, bbUpper: null, bbLower: null, close: 100 };
  }

  test("scores a golden cross when 50-SMA crosses above 200-SMA", () => {
    const rows = [enriched(95, 100), enriched(101, 100)];
    const { score, notes } = scoreAt(rows, 1);
    assert.ok(notes.some(n => n.includes("Golden Cross")));
    assert.ok(score >= 2);
  });

  test("scores a death cross when 50-SMA crosses below 200-SMA", () => {
    const rows = [enriched(101, 100), enriched(99, 100)];
    const { score, notes } = scoreAt(rows, 1);
    assert.ok(notes.some(n => n.includes("Death Cross")));
    assert.ok(score <= -2);
  });

  test("does not fire when 50-SMA stays on the same side of 200-SMA", () => {
    const rows = [enriched(105, 100), enriched(106, 100)];
    const { notes } = scoreAt(rows, 1);
    assert.ok(!notes.some(n => n.includes("Cross")));
  });

  test("does not fire without 200 days of history (sma200 null)", () => {
    const rows = [enriched(95, null), enriched(101, null)];
    const { notes } = scoreAt(rows, 1);
    assert.ok(!notes.some(n => n.includes("Cross")));
  });
});

describe("backtest", () => {
  test("reports zero signals on perfectly flat data", () => {
    // Genuinely constant price and volume -- no crossovers, no RSI extremes, no volatility,
    // nothing for any indicator to react to.
    const rows = [];
    for (let i = 0; i < 80; i++) {
      rows.push(row(`d${i}`, 100.3, 99.7, 100, 1000000));
    }
    const result = backtest(rows, 5);
    assert.equal(result.totalSignals, 0);
    assert.deepEqual(result.summary, []);
  });

  test("verdict and stop outcome for early signals are unaffected by what happens later (no lookahead)", () => {
    const buildBase = () => {
      const rows = [];
      for (let i = 0; i < 60; i++) {
        const close = 100 + Math.sin(i / 4) * 2; // choppy, no trend
        rows.push(row(`d${i}`, close + 0.5, close - 0.5, close, 500000));
      }
      for (let i = 60; i < 90; i++) {
        const close = 100 + (i - 60) * 2.5; // sustained uptrend
        rows.push(row(`d${i}`, close + 1, close - 1, close, 2000000 + i * 5000));
      }
      return rows;
    };

    const baseRows = buildBase();
    const divergedRows = buildBase();
    // Replace only the last 10 days with a wild crash -- days 0-79 stay byte-for-byte identical.
    for (let i = 80; i < 90; i++) {
      const close = 50 - (i - 80) * 3;
      divergedRows[i] = row(`d${i}`, close + 1, close - 1, close, 5000000);
    }

    const baseResult = backtest(baseRows, 5);
    const divergedResult = backtest(divergedRows, 5);
    assert.ok(baseResult.totalSignals > 0, "test setup needs the base series to actually produce signals");

    const divergedByDate = new Map(divergedResult.signals.map(s => [s.date, s]));
    let checkedVerdicts = 0;

    for (const s of baseResult.signals) {
      const dayIndex = baseRows.findIndex(r => r.date === s.date);
      const match = divergedByDate.get(s.date);
      assert.ok(match, `signal on ${s.date} present in base run but missing in diverged run`);

      if (dayIndex <= 79) {
        // rows[0..79] are identical between the two series, so a verdict computed from that
        // prefix alone must be identical too, no matter what happens afterward.
        assert.equal(match.verdict, s.verdict, `verdict for ${s.date} changed based on future data`);
        checkedVerdicts++;
      }
      if (dayIndex <= 74) {
        // forward window (dayIndex+1 .. dayIndex+5) also falls entirely within the identical
        // prefix here, so the stop outcome must match too.
        assert.equal(match.stoppedOut, s.stoppedOut, `stop outcome for ${s.date} changed based on data beyond its own forward window`);
        assert.ok(
          Math.abs(match.forwardReturn - s.forwardReturn) < 1e-9,
          `forward return for ${s.date} changed based on data beyond its own forward window`
        );
      }
    }
    assert.ok(checkedVerdicts > 0, "test setup needs at least one signal before day 80 to be meaningful");
  });

  test("a signal contradicted by a strong sustained move afterward gets marked stopped out", () => {
    // Decline for 40 days, then a strong sustained reversal for 40 more. Verified empirically:
    // this shape produces Sell signals a little way into the reversal (a real, if unfortunate,
    // whipsaw case -- exactly the kind of thing the ADX/volume filter is meant to reduce, not
    // eliminate) which the continued rally then blows straight through their stop.
    const rows = [];
    for (let i = 0; i < 40; i++) {
      const close = 150 - i;
      rows.push(row(`d${i}`, close + 0.8, close - 0.8, close, 700000));
    }
    for (let i = 40; i < 80; i++) {
      const close = 110 + (i - 40) * 1.5;
      rows.push(row(`d${i}`, close + 1, close - 1, close, 900000 + (i - 40) * 30000));
    }

    const result = backtest(rows, 5);
    assert.ok(result.totalSignals > 0, "test setup needs this shape to actually produce signals");

    const sellEntry = result.summary.find(s => s.verdict === "Sell");
    assert.ok(sellEntry, "expected at least one Sell signal from this whipsaw shape");
    assert.equal(sellEntry.stoppedCount, sellEntry.count, "expected every Sell signal here to get stopped out by the sustained rally");
    assert.ok(sellEntry.avgReturn > 0, "a stopped-out Sell's recorded return should reflect the adverse (upward) move, not the day-N close");
  });
});

describe("dailyReturns", () => {
  test("computes simple percentage returns between consecutive closes", () => {
    const returns = dailyReturns([100, 110, 99]);
    assert.equal(returns.length, 2);
    assert.ok(Math.abs(returns[0] - 0.10) < 1e-9);
    assert.ok(Math.abs(returns[1] - (-0.10)) < 1e-9);
  });
});

describe("correlation", () => {
  test("is ~1 for two identical series", () => {
    const a = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02];
    assert.ok(Math.abs(correlation(a, a) - 1) < 1e-9);
  });

  test("is ~-1 for two exactly inverse series", () => {
    const a = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02];
    const b = a.map(v => -v);
    assert.ok(Math.abs(correlation(a, b) - (-1)) < 1e-9);
  });

  test("is near 0 for genuinely unrelated series", () => {
    const a = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.015, -0.025];
    const b = [0.02, 0.01, -0.03, 0.02, 0.01, -0.015, -0.01, 0.005];
    assert.ok(Math.abs(correlation(a, b)) < 0.6, `expected low correlation, got ${correlation(a, b)}`);
  });

  test("returns 0 instead of throwing on degenerate input", () => {
    assert.equal(correlation([], []), 0);
    assert.equal(correlation([0.01], [0.02]), 0); // too short
    assert.equal(correlation([0, 0, 0], [0.01, 0.02, 0.03]), 0); // zero variance
  });
});

describe("avgDollarVolume", () => {
  test("averages price * volume over the trailing window", () => {
    const rows = [
      row("d0", 10, 9, 10, 1000),
      row("d1", 10, 9, 20, 2000),
      row("d2", 10, 9, 30, 3000)
    ];
    // (10*1000 + 20*2000 + 30*3000) / 3 = (10000 + 40000 + 90000) / 3
    assert.ok(Math.abs(avgDollarVolume(rows, 3) - (10000 + 40000 + 90000) / 3) < 1e-6);
  });

  test("returns 0 for an empty series", () => {
    assert.equal(avgDollarVolume([], 20), 0);
  });
});

describe("selectDiversified", () => {
  function candidate(symbol, volatility, returns) {
    return { symbol, volatility, returns };
  }

  test("picks the highest-volatility candidates when nothing is correlated", () => {
    const candidates = [
      candidate("A", 10, [0.01, 0.02, -0.01]),
      candidate("B", 5, [0.03, -0.02, 0.01]),
      candidate("C", 15, [-0.01, 0.01, 0.02])
    ];
    const picked = selectDiversified(candidates, 2, 0.99);
    assert.deepEqual(picked.map(c => c.symbol), ["C", "A"]);
  });

  test("skips a candidate too correlated with one already picked", () => {
    const base = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02];
    const candidates = [
      candidate("HIGH_VOL", 20, base),
      candidate("CLONE", 18, base), // near-identical returns to HIGH_VOL -- should be skipped
      // Note: this series happens to be ~-0.71 correlated with `base`, not just "different" --
      // that's deliberate, see the negative-correlation test below.
      candidate("DIFFERENT", 10, [-0.02, 0.01, -0.03, 0.02, 0.01, -0.015])
    ];
    const picked = selectDiversified(candidates, 2, 0.7);
    assert.ok(picked.some(c => c.symbol === "HIGH_VOL"));
    assert.ok(!picked.some(c => c.symbol === "CLONE"), "CLONE should be skipped as too correlated with HIGH_VOL");
    assert.ok(picked.some(c => c.symbol === "DIFFERENT"));
  });

  test("does not skip a candidate that's strongly *negatively* correlated -- that's good diversification, not bad", () => {
    const base = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02];
    const inverse = base.map(v => -v); // correlation ~-1 with base
    const candidates = [
      candidate("HIGH_VOL", 20, base),
      candidate("INVERSE", 15, inverse)
    ];
    const picked = selectDiversified(candidates, 2, 0.7);
    assert.equal(picked.length, 2);
    assert.ok(picked.some(c => c.symbol === "INVERSE"), "a strongly anti-correlated candidate should be kept, not excluded");
  });

  test("backfills from correlated candidates rather than returning fewer than requested", () => {
    const base = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02];
    const candidates = [
      candidate("A", 20, base),
      candidate("B", 18, base), // correlated with A
      candidate("C", 15, base)  // also correlated with A and B
    ];
    // With a strict correlation cap, only A would normally qualify -- but there are only 3
    // candidates total, so requesting 2 must backfill rather than returning just 1.
    const picked = selectDiversified(candidates, 2, 0.5);
    assert.equal(picked.length, 2);
  });
});
