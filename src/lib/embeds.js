const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const path = require("path");

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

module.exports = {
  scanEmbed, alertEmbed, volatilityEmbed, backtestEmbed, alertHistoryEmbed,
  logoAttachment, VERDICT_COLOR
};
