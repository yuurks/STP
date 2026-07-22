// DexScreener's free API -- no key required, 60 req/min. Used only by /degen (src/lib/degen.js)
// for brand-new Solana pairs, which Twelve Data has no coverage of at all. Unlike marketData.js,
// this has no historical OHLC candles -- only a live snapshot (price, volume/liquidity/buy-sell
// counts over rolling 5m/1h/6h/24h windows, and pairCreatedAt). That's a hard ceiling: nothing
// built on this data can ever feed the RSI/MACD/ADX engine in indicators.js, and it can never be
// backtested the way /backtest validates everything else -- there's no history to replay.

const BASE_URL = "https://api.dexscreener.com";

// Newest token profiles across every chain DexScreener tracks -- filtered here to Solana only.
// This is a rolling feed (typically the last ~15-30 minutes of activity), not a paginated
// archive, and it only includes tokens whose creator submitted profile metadata (icon,
// description, links) -- not literally every pair that's ever launched.
async function fetchNewSolanaTokens() {
  const res = await fetch(`${BASE_URL}/token-profiles/latest/v1`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter(t => t.chainId === "solana" && t.tokenAddress)
    .map(t => ({ tokenAddress: t.tokenAddress, url: t.url, updatedAt: t.updatedAt }));
}

// Real trading data for up to ~30 token addresses in one call (comma-separated, confirmed
// batching support). Returns one entry per pair DexScreener has for these tokens -- a token can
// have more than one pair (multiple pools); callers should pick the highest-liquidity pair per
// token if they care about a single canonical price.
async function fetchTokenTradingData(chainId, addresses) {
  if (!addresses.length) return [];
  const joined = addresses.join(",");
  const res = await fetch(`${BASE_URL}/tokens/v1/${chainId}/${joined}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

module.exports = { fetchNewSolanaTokens, fetchTokenTradingData };
