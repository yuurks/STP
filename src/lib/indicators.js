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
  const smaData = { s20: sma(closes, 20), s50: sma(closes, 50) };
  const emaData = { e12: ema(closes, 12), e26: ema(closes, 26) };
  const rsiData = rsi(closes, 14);
  const macdData = macd(closes);
  const bbData = bollinger(closes, 20, 2);

  const enriched = rows.map((r, i) => ({
    ...r,
    sma20: smaData.s20[i], sma50: smaData.s50[i],
    ema12: emaData.e12[i], ema26: emaData.e26[i],
    rsi: rsiData[i],
    macd: macdData.line[i], macdSignal: macdData.signal[i], macdHist: macdData.hist[i],
    bbUpper: bbData.upper[i], bbLower: bbData.lower[i], bbMid: bbData.mid[i]
  }));

  const n = enriched.length - 1;
  const { score, verdict, notes } = scoreAt(enriched, n);
  return {
    rows: enriched, score, verdict, notes, last: enriched[n],
    volatility: volatility(closes), gap: findUnfilledGap(rows)
  };
}

module.exports = { analyze, scoreAt, verdictFromScore, verdictSide, findUnfilledGap };
