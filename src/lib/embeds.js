const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const path = require("path");
const { computeDrawdown } = require("./portfolio");

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
  return `\nGap to fill: $${gap.distance.toFixed(2)} (${gap.pct.toFixed(1)}%) ${gap.direction} to $${gap.level.toFixed(2)}`;
}

// A suggested stop-loss at 2x ATR from the close, sized to the ticker's own typical range
// rather than a flat percentage. A starting point, not a guarantee -- blank on Neutral/no ATR.
function stopLossLine(r) {
  if (!r.atr || r.verdict === "Neutral") return "";
  const isBuySide = r.verdict.includes("Buy");
  const stopPrice = isBuySide ? r.last.close - 2 * r.atr : r.last.close + 2 * r.atr;
  return `\nSuggested stop (2x ATR): $${Math.max(0, stopPrice).toFixed(2)}`;
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
      name: `${r.symbol} · $${r.last.close.toFixed(2)} — ${r.verdict}`,
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
      name: `${r.symbol} · $${r.last.close.toFixed(2)} — ${r.verdict}`,
      value: `Score ${r.score >= 0 ? "+" : ""}${r.score} · ${r.notes.slice(0, 2).join(" · ") || "No strong signals"}${gapLine(r.gap)}${stopLossLine(r)}`,
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
      name: `${r.symbol} · $${r.last.close.toFixed(2)} — ${r.volatility.toFixed(1)}% daily volatility`,
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
      name: `${symbol} · ${pos.shares.toFixed(4)} shares @ $${pos.entryPrice.toFixed(2)}`,
      value: price != null
        ? `Now $${price.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%) · Stop $${pos.stopPrice.toFixed(2)}`
        : `Current price unavailable · Stop $${pos.stopPrice.toFixed(2)}`,
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

function formatDollarVolume(v) {
  if (!v) return null;
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  return `$${(v / 1_000_000).toFixed(1)}M`;
}

function shortsEmbed(winner, loser, label) {
  const embed = new EmbedBuilder()
    .setTitle(`🎬 Today's Biggest Movers — ${label}`)
    .setColor(0x0ca34a)
    .setThumbnail("attachment://logo.png")
    .setFooter({ text: "Technical pattern data, not financial advice. Attached file is the ready-to-record Short -- open it locally in a browser." })
    .setTimestamp();

  embed.addFields(
    {
      name: `🟢 Winner: ${winner.symbol} · ${winner.pctChange >= 0 ? "+" : ""}${winner.pctChange.toFixed(1)}%`,
      value: `Open $${winner.intraday.closes[0].toFixed(2)} → Now $${winner.price.toFixed(2)}` +
        (formatDollarVolume(winner.dollarVolume) ? ` · Avg. volume: ${formatDollarVolume(winner.dollarVolume)}/day` : ""),
      inline: false
    },
    {
      name: `🔴 Loser: ${loser.symbol} · ${loser.pctChange >= 0 ? "+" : ""}${loser.pctChange.toFixed(1)}%`,
      value: `Open $${loser.intraday.closes[0].toFixed(2)} → Now $${loser.price.toFixed(2)}` +
        (formatDollarVolume(loser.dollarVolume) ? ` · Avg. volume: ${formatDollarVolume(loser.dollarVolume)}/day` : ""),
      inline: false
    }
  );

  return embed;
}

module.exports = {
  scanEmbed, alertEmbed, volatilityEmbed, backtestEmbed, alertHistoryEmbed, portfolioEmbed,
  shortsEmbed, logoAttachment, VERDICT_COLOR
};
