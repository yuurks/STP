const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const path = require("path");
const { computeDrawdown } = require("./portfolio");
const { formatMoney } = require("./format");

const LOGO_PATH = path.join(__dirname, "..", "..", "assets", "logo.png");

const VERDICT_COLOR = {
  "Strong Buy": 0x21c08f,
  "Buy": 0x5fd1a8,
  "Neutral": 0xe0a93e,
  "Sell": 0xeb7c6e,
  "Strong Sell": 0xe2493d
};

// Discord embeds can't point at a local file directly — you attach the file to the message,
// then reference it in the embed as "attachment://<filename>". This builds both pieces together.
function logoAttachment() {
  return new AttachmentBuilder(LOGO_PATH, { name: "logo.png" });
}

// One extra line describing the nearest unfilled price gap, if any -- blank otherwise so it's
// safe to always append.
function gapLine(gap) {
  if (!gap) return "";
  return `\nGap to fill: ${formatMoney(gap.distance)} (${gap.pct.toFixed(1)}%) ${gap.direction} to ${formatMoney(gap.level)}`;
}

// A suggested stop-loss at 2x ATR from the close, sized to the ticker's own typical range
// rather than a flat percentage. A starting point, not a guarantee -- blank on Neutral/no ATR.
function stopLossLine(r) {
  if (!r.atr || r.verdict === "Neutral") return "";
  const isBuySide = r.verdict.includes("Buy");
  const stopPrice = isBuySide ? r.last.close - 2 * r.atr : r.last.close + 2 * r.atr;
  return `\nSuggested stop (2x ATR): ${formatMoney(Math.max(0, stopPrice))}`;
}

function scanEmbed(results) {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const embed = new EmbedBuilder()
    .setTitle("📡 Signal Deck — Scan Results")
    .setColor(0x5b8def)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: "Technical pattern signals, not financial advice" })
    .setTimestamp();

  sorted.slice(0, 25).forEach(r => {
    embed.addFields({
      name: `${r.symbol} · ${formatMoney(r.last.close)} — ${r.verdict}`,
      value: `Score ${r.score >= 0 ? "+" : ""}${r.score} · ${r.notes.slice(0, 2).join(" · ") || "No strong signals"}${gapLine(r.gap)}${stopLossLine(r)}`,
      inline: false
    });
  });

  return embed;
}

function alertEmbed(fired) {
  const embed = new EmbedBuilder()
    .setTitle("🚨 Signal Alert")
    .setColor(0xffb020)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: "Technical pattern signals, not financial advice" })
    .setTimestamp();

  fired.forEach(r => {
    embed.addFields({
      name: `${r.symbol} · ${formatMoney(r.last.close)} — ${r.verdict}`,
      value: `Score ${r.score >= 0 ? "+" : ""}${r.score} · ${r.notes.slice(0, 2).join(" · ") || "No strong signals"}${gapLine(r.gap)}${stopLossLine(r)}`,
      inline: false
    });
  });

  return embed;
}

function discoverEmbed(fired) {
  const embed = new EmbedBuilder()
    .setTitle("🔍 Discover — New Buy Signals")
    .setColor(0x21c08f)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: "Found in the crypto candidate pool, not your watchlist. Technical pattern signals, not financial advice -- not a prediction, just what qualifies right now." })
    .setTimestamp();

  fired.forEach(r => {
    const surgeNote = r.volumeSurgeRatio ? ` · ${r.volumeSurgeRatio.toFixed(1)}× normal volume` : "";
    embed.addFields({
      name: `${r.symbol} · ${formatMoney(r.last.close)} — ${r.verdict}`,
      value: `Score ${r.score >= 0 ? "+" : ""}${r.score}${surgeNote} · ${r.notes.slice(0, 2).join(" · ") || "No strong signals"}${gapLine(r.gap)}${stopLossLine(r)}`,
      inline: false
    });
  });

  return embed;
}

function formatDexScreenerVolume(usd) {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

// /degen's candidates are almost always well under 48h old, where hours read naturally; /breakout
// has no age cutoff at all, so the same field needs to read sensibly for a coin that's months old.
function formatAge(pairCreatedAt) {
  if (!pairCreatedAt) return "?";
  const hours = (Date.now() - pairCreatedAt) / 3600000;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(0)}d`;
}

// Shared per-candidate field content for /degen and /breakout's real-alert and closest-match
// embeds alike -- same underlying DexScreener pair shape either way, just framed differently in
// the embed around it. extraLine is appended last (used for shortfalls).
function formatDegenField(pair, extraLine = "") {
  const symbol = pair.baseToken?.symbol || "?";
  const h1 = pair.txns?.h1 || { buys: 0, sells: 0 };
  const ratio = h1.sells > 0 ? (h1.buys / h1.sells).toFixed(1) : "∞";
  const age = formatAge(pair.pairCreatedAt);
  const report = pair.riskReport;
  // Read the actual authority state rather than assuming "renounced" -- true today only
  // because checkRisk() already filtered out anything where it wasn't, but this line
  // shouldn't silently go stale if that filter logic ever changes.
  const authorityLabel = report && !report.token?.mintAuthority && !report.token?.freezeAuthority
    ? "mint/freeze renounced" : "mint/freeze: check manually";
  const riskLine = report
    ? `\nRisk screen: score ${report.score_normalised ?? report.score ?? "?"}/100 · ` +
      `top holder ${(report.topHolders?.[0]?.pct || 0).toFixed(1)}% · ${authorityLabel}`
    : "";
  const h1Change = pair.priceChange?.h1;
  const m5Change = pair.priceChange?.m5;
  const changeLine = h1Change != null
    ? ` · 1h: ${h1Change >= 0 ? "+" : ""}${h1Change.toFixed(1)}% · 5m: ${m5Change != null ? (m5Change >= 0 ? "+" : "") + m5Change.toFixed(1) + "%" : "?"}`
    : "";
  return {
    name: `${symbol} · ${formatMoney(parseFloat(pair.priceUsd) || 0)}`,
    value: `Liquidity: ${formatDexScreenerVolume(pair.liquidity?.usd || 0)} · ` +
      `Market cap: ${formatDexScreenerVolume(pair.marketCap || 0)} · ` +
      `1h buys/sells: ${h1.buys}/${h1.sells} (${ratio}×)${changeLine} · Age: ${age}${riskLine}${extraLine}\n` +
      `[View on DexScreener](${pair.url})`,
    inline: false
  };
}

// Brand-new Solana pairs from DexScreener -- momentum/liquidity/buy-pressure, not RSI/MACD/ADX
// (impossible here, no historical data exists -- see src/lib/degen.js). Meaningfully higher risk
// than every other alert this bot sends: rug pulls, honeypot contracts, and wash-traded volume
// are common in this exact category. A RugCheck-based screen (mint/freeze authority, insider
// clustering, holder concentration) has already been applied by the time a candidate reaches
// this embed -- it reduces exposure to known patterns, it does not guarantee anything. The risk
// warning is in the title and footer deliberately, not just buried in a caveat line.
function degenEmbed(candidates) {
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Degen — New Solana Pairs (High Risk)")
    .setColor(0xe0433d)
    .setThumbnail("attachment://logo.png")
    .setFooter({
      text: "UNVALIDATED, HIGH RISK: passed a liquidity/buy-pressure/market-cap filter and a " +
        "RugCheck-based risk screen -- neither is a guarantee against rugs, honeypots, or wash-traded volume. " +
        "This can never be backtested -- there's no history to replay. Not financial advice."
    })
    .setTimestamp();

  candidates.forEach(pair => embed.addFields(formatDegenField(pair)));
  return embed;
}

// The /degen now fallback when nothing actually clears the bar -- deliberately a different
// color and explicit "did not qualify" framing so it can never be mistaken for a real alert.
// Still passed the RugCheck risk screen (never skipped just because nothing else qualified) --
// see findDegenCandidates in degen.js -- but everything else about it fell short somewhere,
// listed explicitly below rather than left as a vague "closest."
function degenClosestEmbed(pair) {
  const embed = new EmbedBuilder()
    .setTitle("🔍 Degen — Closest Match (Did Not Clear the Bar)")
    .setColor(0x6b7280)
    .setThumbnail("attachment://logo.png")
    .setFooter({
      text: "This did NOT pass the real filters -- it's just the closest candidate this scan found. " +
        "Still passed the RugCheck risk screen, but the gaps below are real. Not an alert, not a recommendation."
    })
    .setTimestamp();

  const shortfalls = pair.shortfalls?.length
    ? `\nShortfalls: ${pair.shortfalls.join("; ")}`
    : "";
  embed.addFields(formatDegenField(pair, shortfalls));
  return embed;
}

// /breakout: same trading-criteria + RugCheck bar as /degen (see degen.js's meetsTradingCriteria/
// checkRisk, reused as-is by breakout.js), sourced from Raydium's volume-ranked pool list instead
// of DexScreener's newest-pairs feed, and deliberately with no age requirement -- an established
// coin breaking out is exactly what this command is for, so the framing below never claims "new."
function breakoutEmbed(candidates) {
  const embed = new EmbedBuilder()
    .setTitle("🚀 Breakout — Solana Momentum (High Risk)")
    .setColor(0xf5a623)
    .setThumbnail("attachment://logo.png")
    .setFooter({
      text: "UNVALIDATED, HIGH RISK: not necessarily a new coin -- sourced from Raydium's volume-ranked " +
        "pool list, screened against the same liquidity/buy-pressure/market-cap/momentum bar and " +
        "RugCheck-based risk screen as /degen, just without an age requirement. Neither is a guarantee " +
        "against rugs, honeypots, or wash-traded volume. This can never be backtested the way /backtest " +
        "validates everything else -- there's no history to replay. Not financial advice."
    })
    .setTimestamp();

  candidates.forEach(pair => embed.addFields(formatDegenField(pair)));
  return embed;
}

// The /breakout now fallback when nothing actually clears the bar -- same visual language as
// degenClosestEmbed (distinct gray color, explicit "did not qualify" framing) so it can never be
// mistaken for a real alert.
function breakoutClosestEmbed(pair) {
  const embed = new EmbedBuilder()
    .setTitle("🔍 Breakout — Closest Match (Did Not Clear the Bar)")
    .setColor(0x6b7280)
    .setThumbnail("attachment://logo.png")
    .setFooter({
      text: "This did NOT pass the real filters -- it's just the closest candidate this scan found. " +
        "Still passed the RugCheck risk screen, but the gaps below are real. Not an alert, not a recommendation."
    })
    .setTimestamp();

  const shortfalls = pair.shortfalls?.length
    ? `\nShortfalls: ${pair.shortfalls.join("; ")}`
    : "";
  embed.addFields(formatDegenField(pair, shortfalls));
  return embed;
}

// Same shape as degenHistoryEmbed -- no verdict to group by, no stop-loss simulation possible
// (no intraday path data), and excluded (no-longer-returned-by-DexScreener) alerts are surfaced
// as a count rather than silently dropped, since dropping them biases the win rate optimistic.
function breakoutHistoryEmbed(evaluated, excludedCount) {
  const embed = new EmbedBuilder()
    .setTitle("🚀 Breakout History — Real Performance")
    .setColor(0x8a63d2)
    .setThumbnail("attachment://logo.png")
    .setTimestamp();

  const wins = evaluated.filter(e => e.returnPct > 0).length;
  const winRate = (wins / evaluated.length) * 100;
  const avgReturn = evaluated.reduce((a, e) => a + e.returnPct, 0) / evaluated.length;
  const sorted = [...evaluated].sort((a, b) => b.returnPct - a.returnPct);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  embed.addFields({
    name: `${evaluated.length} alert(s) evaluated`,
    value:
      `Win rate: ${winRate.toFixed(0)}% · Avg return: ${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(1)}%\n` +
      `Best: ${best.symbol} ${best.returnPct >= 0 ? "+" : ""}${best.returnPct.toFixed(1)}% · ` +
      `Worst: ${worst.symbol} ${worst.returnPct >= 0 ? "+" : ""}${worst.returnPct.toFixed(1)}%`,
    inline: false
  });

  const excludedNote = excludedCount > 0
    ? `${excludedCount} logged alert(s) excluded -- DexScreener no longer returns them, almost always because the token died or got rugged, which means this win rate likely skews optimistic, not pessimistic. `
    : "";
  embed.setFooter({
    text: `${excludedNote}Raw price-then vs. price-now -- no stop-loss simulation (no intraday path data exists to check one against). High risk, unvalidated. Not financial advice.`
  });
  return embed;
}

function volatilityEmbed(results) {
  const sorted = [...results].sort((a, b) => b.volatility - a.volatility);
  const embed = new EmbedBuilder()
    .setTitle("📡 Signal Deck — Volatility Scan Results")
    .setColor(0x5b8def)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: "Technical pattern signals, not financial advice" })
    .setTimestamp();

  sorted.slice(0, 25).forEach(r => {
    embed.addFields({
      name: `${r.symbol} · ${formatMoney(r.last.close)} — ${r.volatility.toFixed(1)}% daily volatility`,
      value: `${r.verdict} · Score ${r.score >= 0 ? "+" : ""}${r.score} · ${r.notes.slice(0, 2).join(" · ") || "No strong signals"}${gapLine(r.gap)}${stopLossLine(r)}`,
      inline: false
    });
  });

  return embed;
}

function summaryFields(embed, summary, label) {
  summary
    .sort((a, b) => b.count - a.count)
    .forEach(s => {
      const stopNote = s.stoppedCount != null ? ` · Stopped out: ${s.stoppedCount}/${s.count}` : "";
      embed.addFields({
        name: `${s.verdict} · ${s.count} signal${s.count === 1 ? "" : "s"}`,
        value: `Win rate: ${s.winRate.toFixed(0)}% · Avg return ${label}: ${s.avgReturn >= 0 ? "+" : ""}${s.avgReturn.toFixed(2)}%${stopNote}`,
        inline: false
      });
    });
}

function backtestEmbed(symbol, result) {
  const embed = new EmbedBuilder()
    .setTitle(`📊 Backtest — ${symbol}`)
    .setColor(0x8a63d2)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: "Stop-aware, small sample, historical only -- not a guarantee of future results. Not financial advice." })
    .setTimestamp();

  summaryFields(embed, result.summary, `(${result.forwardDays}-day, stop-aware)`);
  return embed;
}

function alertHistoryEmbed(summary, evaluatedCount) {
  const embed = new EmbedBuilder()
    .setTitle("📈 Alert History — Real Performance")
    .setColor(0x8a63d2)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: `${evaluatedCount} past alerts evaluated -- small sample. Not financial advice.` })
    .setTimestamp();

  summaryFields(embed, summary, "(since firing, stop-aware)");
  return embed;
}

// Same stop-aware evaluation as alertHistoryEmbed, just a distinct title/footer so a /discover
// result is never mistaken for an /alerts one -- they scan different pools (candidate pool vs.
// this server's watchlist) and shouldn't be read as the same track record.
function discoverHistoryEmbed(summary, evaluatedCount) {
  const embed = new EmbedBuilder()
    .setTitle("🔎 Discover History — Real Performance")
    .setColor(0x8a63d2)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: `${evaluatedCount} past Discover alerts evaluated -- small sample. Not financial advice.` })
    .setTimestamp();

  summaryFields(embed, summary, "(since firing, stop-aware)");
  return embed;
}

// Degen's performance tracking can't reuse summaryFields: there's no verdict to group by (every
// degen alert is the same "cleared the bar" claim), no ATR/stop simulation is possible (no
// intraday price path exists for a raw DexScreener snapshot, only current vs. logged), and the
// excluded count matters enough to say out loud -- a token DexScreener no longer returns is
// almost always dead/rugged, not a data hiccup, so silently dropping it from the average would
// make the win rate look better than reality, not worse.
function degenHistoryEmbed(evaluated, excludedCount) {
  const embed = new EmbedBuilder()
    .setTitle("💀 Degen History — Real Performance")
    .setColor(0x8a63d2)
    .setThumbnail("attachment://logo.png")
    .setTimestamp();

  const wins = evaluated.filter(e => e.returnPct > 0).length;
  const winRate = (wins / evaluated.length) * 100;
  const avgReturn = evaluated.reduce((a, e) => a + e.returnPct, 0) / evaluated.length;
  const sorted = [...evaluated].sort((a, b) => b.returnPct - a.returnPct);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  embed.addFields({
    name: `${evaluated.length} alert(s) evaluated`,
    value:
      `Win rate: ${winRate.toFixed(0)}% · Avg return: ${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(1)}%\n` +
      `Best: ${best.symbol} ${best.returnPct >= 0 ? "+" : ""}${best.returnPct.toFixed(1)}% · ` +
      `Worst: ${worst.symbol} ${worst.returnPct >= 0 ? "+" : ""}${worst.returnPct.toFixed(1)}%`,
    inline: false
  });

  const excludedNote = excludedCount > 0
    ? `${excludedCount} logged alert(s) excluded -- DexScreener no longer returns them, almost always because the token died or got rugged, which means this win rate likely skews optimistic, not pessimistic. `
    : "";
  embed.setFooter({
    text: `${excludedNote}Raw price-then vs. price-now -- no stop-loss simulation (no intraday path data exists to check one against). High risk, unvalidated. Not financial advice.`
  });
  return embed;
}

function portfolioEmbed(portfolio, currentPrices) {
  const embed = new EmbedBuilder()
    .setTitle("📒 Paper Portfolio")
    .setColor(0x3fa796)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: "Simulated only -- no real money, not financial advice." })
    .setTimestamp();

  let marketValue = 0;
  const positionEntries = Object.entries(portfolio.positions);
  const positionFields = positionEntries.map(([symbol, pos]) => {
    const price = currentPrices[symbol];
    const value = price != null ? pos.shares * price : pos.shares * pos.entryPrice;
    marketValue += value;
    const pnlPct = price != null ? ((price - pos.entryPrice) / pos.entryPrice) * 100 : null;
    return {
      name: `${symbol} · ${pos.shares.toFixed(4)} shares @ ${formatMoney(pos.entryPrice)}`,
      value: price != null
        ? `Now ${formatMoney(price)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%) · Stop ${formatMoney(pos.stopPrice)}`
        : `Current price unavailable · Stop ${formatMoney(pos.stopPrice)}`,
      inline: false
    };
  });

  const totalValue = portfolio.cash + marketValue;
  const totalReturnPct = ((totalValue - portfolio.startingCash) / portfolio.startingCash) * 100;
  const wins = portfolio.closedTrades.filter(t => t.pnl > 0).length;
  const losses = portfolio.closedTrades.filter(t => t.pnl <= 0).length;
  const { maxDrawdownPct, currentDrawdownPct } = computeDrawdown(portfolio.equityCurve || []);

  embed.addFields({
    name: "Summary",
    value:
      `Cash: $${portfolio.cash.toFixed(2)} · Open positions value: $${marketValue.toFixed(2)}\n` +
      `Total value: $${totalValue.toFixed(2)} (${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}% since start)\n` +
      `Closed trades: ${portfolio.closedTrades.length} (${wins}W / ${losses}L)\n` +
      `Max drawdown: -${maxDrawdownPct.toFixed(1)}% · Current drawdown: -${currentDrawdownPct.toFixed(1)}%`,
    inline: false
  });

  positionFields.forEach(f => embed.addFields(f));

  if (portfolio.closedTrades.length) {
    const recent = [...portfolio.closedTrades].slice(-5).reverse();
    embed.addFields({
      name: "Recent closed trades",
      value: recent.map(t => `${t.symbol}: ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} (${t.reason})`).join("\n"),
      inline: false
    });
  }

  return embed;
}

function formatSurge(ratio) {
  return ratio ? `${ratio.toFixed(1)}× its normal volume` : null;
}

function shortsEmbed(winner, loser, label, imageFilename) {
  const embed = new EmbedBuilder()
    .setTitle(`🎬 Today's Biggest Movers — ${label}`)
    .setColor(0x0ca34a)
    .setImage(`attachment://${imageFilename}`)
    .setFooter({ text: "Technical pattern data, not financial advice. Save the image above for your Short." })
    .setTimestamp();

  embed.addFields(
    {
      name: `🟢 Winner: ${winner.symbol} · ${winner.pctChange >= 0 ? "+" : ""}${winner.pctChange.toFixed(1)}%`,
      value: `Open ${formatMoney(winner.intraday.closes[0])} → Now ${formatMoney(winner.price)}` +
        (formatSurge(winner.volumeSurgeRatio) ? ` · Trading at ${formatSurge(winner.volumeSurgeRatio)}` : ""),
      inline: false
    },
    {
      name: `🔴 Loser: ${loser.symbol} · ${loser.pctChange >= 0 ? "+" : ""}${loser.pctChange.toFixed(1)}%`,
      value: `Open ${formatMoney(loser.intraday.closes[0])} → Now ${formatMoney(loser.price)}` +
        (formatSurge(loser.volumeSurgeRatio) ? ` · Trading at ${formatSurge(loser.volumeSurgeRatio)}` : ""),
      inline: false
    }
  );

  return embed;
}

module.exports = {
  scanEmbed, alertEmbed, discoverEmbed, degenEmbed, degenClosestEmbed, volatilityEmbed, backtestEmbed,
  alertHistoryEmbed, discoverHistoryEmbed, degenHistoryEmbed, portfolioEmbed,
  breakoutEmbed, breakoutClosestEmbed, breakoutHistoryEmbed,
  shortsEmbed, logoAttachment, VERDICT_COLOR
};
