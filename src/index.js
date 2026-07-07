require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");

const { analyze } = require("./lib/indicators");
const { fetchDailySeries } = require("./lib/marketData");
const watchlist = require("./lib/watchlist");
const { scanEmbed, logoAttachment } = require("./lib/embeds");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// pacing between symbol lookups so we don't blow through a free-tier market-data rate limit
const PACING_MS = 1000;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Discord messages cap out at 2000 characters. Defensive: even if a watchlist somehow grows
// huge, never build a reply that Discord will reject -- truncate and say how much got cut off.
const DISCORD_MESSAGE_LIMIT = 2000;
function formatTickerList(tickers) {
  if (!tickers.length) return "(empty)";
  let joined = tickers.join(", ");
  if (joined.length <= DISCORD_MESSAGE_LIMIT - 50) return joined;
  let shown = 0;
  let out = "";
  for (const t of tickers) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > DISCORD_MESSAGE_LIMIT - 50) break;
    out = next;
    shown++;
  }
  return `${out} (+${tickers.length - shown} more)`;
}

async function runScan(guildId) {
  const guild = watchlist.getGuild(guildId);
  const results = [];
  for (const symbol of guild.tickers) {
    try {
      const rows = await fetchDailySeries(symbol);
      if (rows.length >= 30) {
        const analysis = analyze(rows);
        results.push({ symbol, ...analysis });
      }
    } catch (err) {
      console.error(`Scan failed for ${symbol}: ${err.message}`);
    }
    await sleep(PACING_MS);
  }
  return results;
}

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag}`);

  // every minute, check whether any guild's auto-scan interval has elapsed
  setInterval(async () => {
    const now = Date.now();
    for (const [guildId, guildData] of watchlist.allGuildsWithAutoscan()) {
      const { channelId, intervalMinutes, lastRun } = guildData.autoscan;
      const due = !lastRun || now - lastRun >= intervalMinutes * 60 * 1000;
      if (!due) continue;

      try {
        const channel = await client.channels.fetch(channelId);
        const results = await runScan(guildId);
        if (results.length) await channel.send({ embeds: [scanEmbed(results)], files: [logoAttachment()] });
        watchlist.markAutoscanRun(guildId, now);
      } catch (err) {
        console.error(`Autoscan failed for guild ${guildId}: ${err.message}`);
      }
    }
  }, 60 * 1000);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "watch": {
        const sub = interaction.options.getSubcommand();
        if (sub === "add") {
          const ticker = interaction.options.getString("ticker");
          if (!watchlist.isValidTicker(ticker)) {
            await interaction.reply({
              content: "That doesn't look like a valid ticker — use a short symbol like `AAPL` or a pair like `BTC/USD`, not a list or free text.",
              ephemeral: true
            });
            break;
          }
          const tickers = watchlist.addTicker(interaction.guildId, ticker);
          await interaction.reply(`Added **${watchlist.normalizeSymbol(ticker)}**. Watchlist: ${formatTickerList(tickers)}`);
        } else if (sub === "remove") {
          const ticker = interaction.options.getString("ticker");
          if (!watchlist.isValidTicker(ticker)) {
            await interaction.reply({ content: "That doesn't look like a valid ticker.", ephemeral: true });
            break;
          }
          const tickers = watchlist.removeTicker(interaction.guildId, ticker);
          await interaction.reply(`Removed **${watchlist.normalizeSymbol(ticker)}**. Watchlist: ${formatTickerList(tickers)}`);
        } else if (sub === "list") {
          const guild = watchlist.getGuild(interaction.guildId);
          await interaction.reply(
            guild.tickers.length ? `Watching: ${formatTickerList(guild.tickers)}` : "Watchlist is empty — add one with `/watch add`."
          );
        } else if (sub === "clear") {
          watchlist.clearTickers(interaction.guildId);
          await interaction.reply("Watchlist cleared.");
        }
        break;
      }

      case "scan": {
        await interaction.deferReply();
        const guild = watchlist.getGuild(interaction.guildId);
        if (!guild.tickers.length) {
          await interaction.editReply("Watchlist is empty — add tickers first with `/watch add`.");
          break;
        }
        const results = await runScan(interaction.guildId);
        if (!results.length) {
          await interaction.editReply("Scan ran but returned no usable data — check your `TWELVE_DATA_API_KEY` and ticker symbols.");
          break;
        }
        await interaction.editReply({ embeds: [scanEmbed(results)], files: [logoAttachment()] });
        break;
      }

      case "autoscan": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const channel = interaction.options.getChannel("channel");
          const minutes = interaction.options.getInteger("interval_minutes") || 60;
          watchlist.setAutoscan(interaction.guildId, channel.id, minutes);
          await interaction.reply(`Auto-scan on: every ${minutes} min, posting to ${channel}.`);
        } else if (sub === "off") {
          watchlist.setAutoscan(interaction.guildId, null, null);
          await interaction.reply("Auto-scan turned off.");
        }
        break;
      }
    }
  } catch (err) {
    console.error(err);
    const msg = `Something went wrong: ${err.message}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
    else await interaction.reply({ content: msg, ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
