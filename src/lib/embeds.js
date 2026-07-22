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

// Brand-new Solana pairs from DexScreener -- momentum/liquidity/buy-pressure, not RSI/MACD/ADX
// (impossible here, no historical data exists -- see src/lib/degen.js). Meaningfully higher risk
// than every other alert this bot sends: rug pulls, honeypot contracts, and wash-traded volume
// are common in this exact category, and nothing here can detect any of those in advance. The
// risk warning is in the title and footer deliberately, not just buried in a caveat line.
function degenEmbed(candidates) {
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Degen — New Solana Pairs (High Risk)")
    .setColor(0xe0433d)
    .setThumbnail("attachment://logo.png")
    .setFooter({
      text: "UNVALIDATED, HIGH RISK: brand-new pairs can be rugged, honeypotted, or wash-traded. " +
        "Liquidity/buy-pressure filters, not a safety check. This can never be backtested -- there's no history to replay. Not financial advice."
    })
    .setTimestamp();

  candidates.forEach(pair => {
    const symbol = pair.baseToken?.symbol || "?";
    const h1 = pair.txns?.h1 || { buys: 0, sells: 0 };
    const ratio = h1.sells > 0 ? (h1.buys / h1.sells).toFixed(1) : "∞";
    const ageHours = pair.pairCreatedAt ? ((Date.now() - pair.pairCreatedAt) / 3600000).toFixed(1) : "?";
    embed.addFields({
      name: `${symbol} · ${formatMoney(parseFloat(pair.priceUsd) || 0)}`,
      value: `Liquidity: ${formatDexScreenerVolume(pair.liquidity?.usd || 0)} · ` +
        `1h buys/sells: ${h1.buys}/${h1.sells} (${ratio}×) · Age: ${ageHours}h\n` +
        `[View on DexScreener](${pair.url})`,
      inline: false
    });
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
  scanEmbed, alertEmbed, discoverEmbed, degenEmbed, volatilityEmbed, backtestEmbed, alertHistoryEmbed, portfolioEmbed,
  shortsEmbed, logoAttachment, VERDICT_COLOR
};
