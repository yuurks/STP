// GeckoTerminal's free public API (api.geckoterminal.com, no key, no OAuth) -- provides real
// historical OHLCV candles for DEX pools, including brand-new Solana pump.fun/PumpSwap pairs.
// This is what makes real candlestick charts possible for /degen and /breakout picks in
// bestCall.js, which DexScreener's own API cannot do at all (no historical data there -- see
// dexscreener.js). Confirmed live against several real tokens before building on this.

const BASE_URL = "https://api.geckoterminal.com/api/v2";

// timeframe: "minute" | "hour" | "day". aggregate: bucket size within that unit (e.g. 15 for
// 15-minute bars). Returns oldest-first (the API itself returns newest-first) as
// { time (ms), open, high, low, close } -- volume is dropped, nothing here needs it.
async function fetchOhlcv(poolAddress, { timeframe = "minute", aggregate = 15, limit = 96 } = {}) {
  const url = `${BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV lookup returned ${res.status}`);
  const data = await res.json();
  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list
    .slice()
    .reverse()
    .map(([time, open, high, low, close]) => ({ time: time * 1000, open, high, low, close }));
}

module.exports = { fetchOhlcv };
