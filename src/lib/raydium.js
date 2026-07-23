// Raydium's public pool-list API -- free, no key required. Used only by /breakout
// (src/lib/breakout.js) as a candidate source that isn't limited to brand-new pairs the way
// DexScreener's "newest profiles" feed is: sorted by 24h volume, one page of 1000 pools already
// reaches down to ~$20-30K TVL / low-thousands-a-day-volume pools (confirmed against live data),
// spanning from blue-chip pairs down to small-cap ones DexScreener's feed would never surface
// because they aren't new.

const BASE_URL = "https://api-v3.raydium.io";

// Real, established reference assets that show up on one side of nearly every serious pool (as
// the quote asset). Alerting on SOL or USDC itself because a SOL/USDC pool has volume would be
// meaningless -- these are the market's own reference points, not degen plays.
const MAJOR_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL (wrapped)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"  // RAY
]);

// The Raydium API's own page-size ceiling; confirmed pageSize=1000 returns exactly 1000 items
// with hasNextPage still true, so there's real depth being left on the table here, but one page
// is already broad enough to include real small-cap coins alongside majors.
const PAGE_SIZE = 1000;

// Returns a deduped list of token mint addresses -- one candidate per pool, whichever side isn't
// a known major (both sides added if neither is; neither added if both are, e.g. a SOL/USDC
// pool itself). These still have to clear /degen's actual liquidity/market-cap/buy-pressure/
// momentum bar and the RugCheck screen afterward -- this just decides what gets checked.
async function fetchBreakoutCandidates() {
  const url = `${BASE_URL}/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=${PAGE_SIZE}&page=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Raydium pool list returned ${res.status}`);
  const json = await res.json();
  const pools = json?.data?.data;
  if (!Array.isArray(pools)) return [];

  const addresses = new Set();
  for (const pool of pools) {
    const a = pool.mintA?.address;
    const b = pool.mintB?.address;
    if (a && !MAJOR_MINTS.has(a)) addresses.add(a);
    if (b && !MAJOR_MINTS.has(b)) addresses.add(b);
  }
  return [...addresses];
}

module.exports = { fetchBreakoutCandidates };
