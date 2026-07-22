// RugCheck's free API (no key, 3 req/sec) -- a real, but not guaranteed, scam-risk screen for
// Solana tokens, used only by /degen after a candidate already passes the DexScreener liquidity/
// buy-pressure/age filters (see degen.js). Checks things that are actually verifiable on-chain:
// whether mint/freeze authority was renounced, whether RugCheck has already flagged the token as
// rugged, whether it detected clustered insider wallets, and raw holder concentration.
//
// This can reduce exposure to known rug patterns. It cannot guarantee a token isn't a scam --
// a coordinated team can pass every one of these checks and still dump on holders. Treat this as
// a filter, not a verdict.

async function fetchRiskReport(mintAddress) {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`);
  if (!res.ok) throw new Error(`RugCheck returned ${res.status} for ${mintAddress}`);
  return res.json();
}

module.exports = { fetchRiskReport };
