// ---------- indicator math (ported from the Signal Deck artifact) ----------

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) { out[i] = prev; continue; }
    if (prev == null) {
      if (i >= period - 1) {
        const slice = values.slice(i - period + 1, i + 1);
        prev = slice.reduce((a, b) => a + b, 0) / period;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      gains += gain; losses += loss;
      if (i === period) {
        const rs = losses === 0 ? 100 : (gains / period) / (losses / period);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
      const rs = losses === 0 ? 100 : gains / losses;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const validLine = line.map(v => (v == null ? 0 : v));
  const signalRaw = ema(validLine, signalP);
  const signal = line.map((v, i) => (v == null ? null : signalRaw[i]));
  const hist = line.map((v, i) => (v == null || signal[i] == null ? null : v - signal[i]));
  return { line, signal, hist };
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) continue;
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function trueRangeSeries(rows) {
  const tr = [0];
  for (let i = 1; i < rows.length; i++) {
    tr.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close)
    ));
  }
  return tr;
}

// Wilder's smoothing: first value is a plain sum of the first `period` entries, then each
// later value rolls the previous one forward (prev - prev/period + current).
function wilderSmooth(arr, period) {
  const n = arr.length;
  const out = new Array(n).fill(null);
  if (period >= n) return out;
  out[period] = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  for (let i = period + 1; i < n; i++) {
    out[i] = out[i - 1] - out[i - 1] / period + arr[i];
  }
  return out;
}

// Average True Range: the standard measure of a ticker's typical bar-to-bar range, used for
// sizing stops relative to how much a ticker actually moves rather than a fixed dollar/percent.
function atr(rows, period = 14) {
  const smoothed = wilderSmooth(trueRangeSeries(rows), period);
  return smoothed.map(v => (v == null ? null : v / period));
}

// Wilder's Average Directional Index: measures trend *strength*, independent of direction.
// Below ~20 is Wilder's own convention for "no real trend" -- the classic failure mode for
// moving-average-crossover systems is firing on a crossover during a range-bound market.
function adx(rows, period = 14) {
  const n = rows.length;
  const plusDM = [0], minusDM = [0];

  for (let i = 1; i < n; i++) {
    const highDiff = rows[i].high - rows[i - 1].high;
    const lowDiff = rows[i - 1].low - rows[i].low;
    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
  }

  const trS = wilderSmooth(trueRangeSeries(rows), period);
  const plusDMS = wilderSmooth(plusDM, period);
  const minusDMS = wilderSmooth(minusDM, period);

  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!trS[i]) continue;
    const plusDI = 100 * (plusDMS[i] / trS[i]);
    const minusDI = 100 * (minusDMS[i] / trS[i]);
    const diSum = plusDI + minusDI;
    dx[i] = diSum ? 100 * Math.abs(plusDI - minusDI) / diSum : 0;
  }

  const out = new Array(n).fill(null);
  let sum = 0, count = 0;
  for (let i = period; i < n; i++) {
    if (dx[i] == null) continue;
    if (count < period) {
      sum += dx[i];
      count++;
      if (count === period) out[i] = sum / period;
    } else {
      out[i] = (out[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return out;
}

// Downgrades an otherwise-actionable verdict to Neutral when it isn't backed by a real trend
// (weak ADX) or above-average volume -- the two most common causes of a false crossover signal.
// Leaves the raw score/notes alone and just appends why it got suppressed, so /scan still shows
// what almost fired.
const ADX_TREND_THRESHOLD = 20;
function applyConfidenceFilter({ score, verdict, notes }, adxValue, lastVolume, avgVolume) {
  if (verdict === "Neutral") return { score, verdict, notes };

  const reasons = [];
  if (adxValue == null || adxValue < ADX_TREND_THRESHOLD) {
    reasons.push(`weak trend, ADX ${adxValue != null ? adxValue.toFixed(0) : "n/a"}`);
  }
  if (avgVolume == null || lastVolume < avgVolume) {
    reasons.push("below-average volume");
  }
  if (!reasons.length) return { score, verdict, notes };

  return {
    score, verdict: "Neutral",
    notes: [...notes, `Signal suppressed (${verdict}) — ${reasons.join(", ")}`]
  };
}

// score -> verdict thresholds, shared everywhere
function verdictFromScore(score) {
  if (score >= 4) return "Strong Buy";
  if (score >= 2) return "Buy";
  if (score <= -4) return "Strong Sell";
  if (score <= -2) return "Sell";
  return "Neutral";
}

function verdictSide(verdict) {
  if (verdict.includes("Buy")) return "buy";
  if (verdict.includes("Sell")) return "sell";
  return "neutral";
}

// composite scoring rule, callable at any historical index of an enriched row array
function scoreAt(enrichedRows, i) {
  const last = enrichedRows[i], prev = enrichedRows[i - 1];
  if (!prev) return { score: 0, verdict: "Neutral", notes: [] };

  let score = 0;
  const notes = [];

  // Golden Cross / Death Cross: the 50-day SMA crossing the 200-day SMA. A specifically-named,
  // widely-watched longer-horizon signal, distinct from the faster 20/50 pair below -- checked
  // first so it isn't crowded out of the truncated "top 2 notes" shown in Discord embeds.
  if (prev.sma50 != null && prev.sma200 != null && last.sma50 != null && last.sma200 != null) {
    if (prev.sma50 <= prev.sma200 && last.sma50 > last.sma200) { score += 2; notes.push("Golden Cross: 50-SMA crossed above 200-SMA"); }
    else if (prev.sma50 >= prev.sma200 && last.sma50 < last.sma200) { score -= 2; notes.push("Death Cross: 50-SMA crossed below 200-SMA"); }
  }

  if (last.sma20 != null && last.sma50 != null) {
    if (last.sma20 > last.sma50) { score += 1; notes.push("20-SMA above 50-SMA (uptrend)"); }
    else { score -= 1; notes.push("20-SMA below 50-SMA (downtrend)"); }
  }
  if (prev.ema12 != null && prev.ema26 != null && last.ema12 != null && last.ema26 != null) {
    if (prev.ema12 <= prev.ema26 && last.ema12 > last.ema26) { score += 2; notes.push("Bullish EMA crossover"); }
    else if (prev.ema12 >= prev.ema26 && last.ema12 < last.ema26) { score -= 2; notes.push("Bearish EMA crossover"); }
  }
  if (last.rsi != null) {
    if (last.rsi < 30) { score += 2; notes.push(`RSI oversold (${last.rsi.toFixed(0)})`); }
    else if (last.rsi > 70) { score -= 2; notes.push(`RSI overbought (${last.rsi.toFixed(0)})`); }
  }
  if (prev.macd != null && prev.macdSignal != null && last.macd != null && last.macdSignal != null) {
    if (prev.macd <= prev.macdSignal && last.macd > last.macdSignal) { score += 2; notes.push("MACD bullish crossover"); }
    else if (prev.macd >= prev.macdSignal && last.macd < last.macdSignal) { score -= 2; notes.push("MACD bearish crossover"); }
  }
  if (last.bbUpper != null && last.bbLower != null) {
    if (last.close > last.bbUpper) { score -= 1; notes.push("Price above upper Bollinger Band"); }
    else if (last.close < last.bbLower) { score += 1; notes.push("Price below lower Bollinger Band"); }
  }

  return { score, verdict: verdictFromScore(score), notes };
}

// stddev of daily % returns over the given closes, as a percentage -- a simple, standard
// measure of how much a ticker actually moves day to day (higher = more volatile).
function volatility(closes) {
  if (closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

// Finds the most recent unfilled price gap: a day whose low/high jumped clean past the prior
// day's high/low, with no trading in between. A gap up is "filled" once price later trades back
// down to the pre-gap level; a gap down, once price trades back up to it. Scans backward from
// the latest bar so it reports the most recent gap that's still open, not the biggest ever.
function findUnfilledGap(rows) {
  for (let i = rows.length - 1; i > 0; i--) {
    const today = rows[i], prev = rows[i - 1];
    let type = null, level = null;
    if (today.low > prev.high) { type = "up"; level = prev.high; }
    else if (today.high < prev.low) { type = "down"; level = prev.low; }
    if (!type) continue;

    let filled = false;
    for (let j = i + 1; j < rows.length; j++) {
      if (type === "up" && rows[j].low <= level) { filled = true; break; }
      if (type === "down" && rows[j].high >= level) { filled = true; break; }
    }
    if (filled) continue;

    const lastClose = rows[rows.length - 1].close;
    const distance = Math.max(0, type === "up" ? lastClose - level : level - lastClose);
    return {
      type, level, date: today.date,
      direction: type === "up" ? "down" : "up",
      distance, pct: (distance / lastClose) * 100
    };
  }
  return null;
}

// full pipeline: raw OHLC rows -> enriched rows + latest score/verdict/notes
function analyze(rows) {
  const closes = rows.map(r => r.close);
  // sma200 needs 200 bars to ever produce a value -- null (and the Golden/Death Cross check
  // that depends on it) until there's enough history, same graceful degradation as every other
  // indicator here.
  const smaData = { s20: sma(closes, 20), s50: sma(closes, 50), s200: sma(closes, 200) };
  const emaData = { e12: ema(closes, 12), e26: ema(closes, 26) };
  const rsiData = rsi(closes, 14);
  const macdData = macd(closes);
  const bbData = bollinger(closes, 20, 2);

  const enriched = rows.map((r, i) => ({
    ...r,
    sma20: smaData.s20[i], sma50: smaData.s50[i], sma200: smaData.s200[i],
    ema12: emaData.e12[i], ema26: emaData.e26[i],
    rsi: rsiData[i],
    macd: macdData.line[i], macdSignal: macdData.signal[i], macdHist: macdData.hist[i],
    bbUpper: bbData.upper[i], bbLower: bbData.lower[i], bbMid: bbData.mid[i]
  }));

  const n = enriched.length - 1;
  const raw = scoreAt(enriched, n);

  const adxData = adx(rows, 14);
  const avgVolumeData = sma(rows.map(r => r.volume), 20);
  const filtered = applyConfidenceFilter(raw, adxData[n], rows[n].volume, avgVolumeData[n]);

  return {
    rows: enriched, ...filtered, last: enriched[n],
    volatility: volatility(closes), gap: findUnfilledGap(rows),
    adx: adxData[n], atr: atr(rows, 14)[n]
  };
}

// Replays analyze() day by day over already-fetched history and checks what happened
// `forwardDays` later, to see whether this bot's own signals have actually meant anything.
// Only ever looks at rows[0..i] when producing the verdict for day i -- same causal analyze()
// used live, just called repeatedly, so there's no lookahead leaking into the result.
//
// Stop-aware: walks day-by-day through the forward window and checks whether the same 2x-ATR
// stop shown in /scan's "Suggested stop" line would have been hit first. If so, the outcome is
// the stop-level return, not the forwardDays close -- otherwise a signal that spent day 2 down
// 5% and recovered by day 5 would misreport as a win, when a real stop would have exited it.
function backtest(rows, forwardDays = 5) {
  const MIN_LOOKBACK = 50; // enough bars for SMA50/MACD/ADX/volume-SMA to have real values
  const signals = [];

  for (let i = MIN_LOOKBACK; i < rows.length - forwardDays; i++) {
    const { verdict, atr: atrValue } = analyze(rows.slice(0, i + 1));
    if (verdict === "Neutral") continue;

    const entry = rows[i].close;
    const isBuySide = verdict.includes("Buy");
    let forwardReturn = null;
    let stoppedOut = false;

    if (atrValue) {
      const stopPrice = isBuySide ? entry - 2 * atrValue : entry + 2 * atrValue;
      for (let j = i + 1; j <= i + forwardDays; j++) {
        const hitStop = isBuySide ? rows[j].low <= stopPrice : rows[j].high >= stopPrice;
        if (hitStop) {
          forwardReturn = ((stopPrice - entry) / entry) * 100;
          stoppedOut = true;
          break;
        }
      }
    }

    if (forwardReturn == null) {
      const exit = rows[i + forwardDays].close;
      forwardReturn = ((exit - entry) / entry) * 100;
    }

    signals.push({ date: rows[i].date, verdict, forwardReturn, stoppedOut });
  }

  const byVerdict = {};
  for (const s of signals) (byVerdict[s.verdict] ||= []).push(s);

  const summary = Object.entries(byVerdict).map(([verdict, entries]) => {
    const isBuySide = verdict.includes("Buy");
    const wins = entries.filter(e => (isBuySide ? e.forwardReturn > 0 : e.forwardReturn < 0)).length;
    return {
      verdict, count: entries.length,
      winRate: (wins / entries.length) * 100,
      avgReturn: entries.reduce((a, e) => a + e.forwardReturn, 0) / entries.length,
      stoppedCount: entries.filter(e => e.stoppedOut).length
    };
  });

  return { forwardDays, totalSignals: signals.length, summary, signals };
}

module.exports = { analyze, scoreAt, verdictFromScore, verdictSide, findUnfilledGap, backtest, atr, adx };
