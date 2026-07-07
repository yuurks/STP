// Pulls daily OHLC candles from Twelve Data's free API. Works for stocks (AAPL), and for
// crypto/forex pairs written as BASE/QUOTE (e.g. BTC/USD) — same endpoint, same free tier.
// Swap this out for Alpha Vantage, Polygon.io, etc. if you'd rather use a different provider —
// just make fetchDailySeries() resolve to the same { date, open, high, low, close, volume }[] shape,
// sorted oldest -> newest.

async function fetchDailySeries(symbol, outputsize = 120) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVE_DATA_API_KEY in your .env file");

  // encode normally, but keep "/" literal — Twelve Data's own docs show pairs like BTC/USD
  // unencoded in the query string, and some deployments are picky about %2F
  const encodedSymbol = encodeURIComponent(symbol).replace(/%2F/g, "/");
  const url = `https://api.twelvedata.com/time_series?symbol=${encodedSymbol}&interval=1day&outputsize=${outputsize}&apikey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || `No data returned for "${symbol}"`);
  }

  return data.values
    .map(v => ({
      date: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseInt(v.volume, 10) || 0
    }))
    .reverse(); // Twelve Data returns newest-first; indicators expect oldest-first
}

module.exports = { fetchDailySeries };
