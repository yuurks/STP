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
      value: `Score ${r.score >= 0 ? "+" : ""}${r.score} · ${r.notes.slice(0, 2).join(" · ") || "No strong signals"}`,
      inline: false
    });
  });

  return embed;
}

module.exports = { scanEmbed, logoAttachment, VERDICT_COLOR };
