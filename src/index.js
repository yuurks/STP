require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");

const { analyze } = require("./lib/indicators");
const { fetchDailySeries } = require("./lib/marketData");
const watchlist = require("./lib/watchlist");
const { scanEmbed, alertEmbed, logoAttachment } = require("./lib/embeds");

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

// Fires only for tickers whose verdict is actionable (not Neutral) and has changed since the
// last check -- so a ticker sitting at "Buy" doesn't re-alert every interval, only on the
// Neutral->Buy (or Buy->Sell, etc.) transition.
function findFiredAlerts(guildId, results) {
  const lastVerdicts = watchlist.getLastVerdicts(guildId);
  const fired = results.filter(r => r.verdict !== "Neutral" && lastVerdicts[r.symbol] !== r.verdict);

  const newVerdicts = {};
  for (const r of results) newVerdicts[r.symbol] = r.verdict;
  watchlist.saveVerdicts(guildId, newVerdicts);

  return fired;
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

    for (const [guildId, guildData] of watchlist.allGuildsWithAlerts()) {
      const { channelId, intervalMinutes, lastRun } = guildData.alerts;
      const due = !lastRun || now - lastRun >= intervalMinutes * 60 * 1000;
      if (!due) continue;

      try {
        const results = await runScan(guildId);
        const fired = findFiredAlerts(guildId, results);
        if (fired.length) {
          const channel = await client.channels.fetch(channelId);
          await channel.send({ embeds: [alertEmbed(fired)], files: [logoAttachment()] });
        }
        watchlist.markAlertsRun(guildId, now);
      } catch (err) {
        console.error(`Alert check failed for guild ${guildId}: ${err.message}`);
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
          const input = interaction.options.getString("ticker");
          const candidates = input.split(/[\s,]+/).filter(Boolean);

          const MAX_PER_CALL = 50;
          if (candidates.length > MAX_PER_CALL) {
            await interaction.reply({
              content: `That's ${candidates.length} tickers in one go — please add at most ${MAX_PER_CALL} at a time.`,
              ephemeral: true
            });
            break;
          }

          const valid = candidates.filter(c => watchlist.isValidTicker(c));
          const invalid = candidates.filter(c => !watchlist.isValidTicker(c));

          if (!valid.length) {
            await interaction.reply({
              content: "None of that looked like a valid ticker — use short symbols like `AAPL` or pairs like `BTC/USD`, comma or space separated.",
              ephemeral: true
            });
            break;
          }

          const tickers = watchlist.addTickers(interaction.guildId, valid);
          const addedNote = `Added ${valid.length} ticker${valid.length === 1 ? "" : "s"}.`;
          const skippedNote = invalid.length ? ` Skipped ${invalid.length} invalid: ${formatTickerList(invalid)}.` : "";
          await interaction.reply(`${addedNote}${skippedNote} Watchlist: ${formatTickerList(tickers)}`);
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

      case "alerts": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const channel = interaction.options.getChannel("channel");
          const minutes = interaction.options.getInteger("interval_minutes") || 60;
          watchlist.setAlerts(interaction.guildId, channel.id, minutes);
          await interaction.reply(
            `Signal alerts on: checking every ${minutes} min, posting to ${channel} only when a ticker's verdict changes to Buy/Sell.`
          );
        } else if (sub === "off") {
          watchlist.setAlerts(interaction.guildId, null, null);
          await interaction.reply("Signal alerts turned off.");
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
