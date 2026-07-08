// Run this once (and again any time you change a command's shape):
//   npm run deploy-commands

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Manage this server's scanner watchlist")
    .addSubcommand(sc =>
      sc.setName("add").setDescription("Add one or more tickers/crypto pairs to the watchlist")
        .addStringOption(o => o.setName("ticker").setDescription("e.g. AAPL, or BTC/USD -- comma or space separated for multiple, up to 50").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("remove").setDescription("Remove a ticker from the watchlist")
        .addStringOption(o => o.setName("ticker").setDescription("Stock ticker or crypto pair to remove").setRequired(true))
    )
    .addSubcommand(sc => sc.setName("list").setDescription("Show the current watchlist"))
    .addSubcommand(sc => sc.setName("clear").setDescription("Remove every ticker from the watchlist"))
    .addSubcommand(sc =>
      sc.setName("autobuild").setDescription("Replace the watchlist with the most volatile tickers from a candidate pool")
        .addStringOption(o =>
          o.setName("universe").setDescription("Candidate pool to sample from (default: both)").setRequired(false)
            .addChoices(
              { name: "Stocks", value: "stocks" },
              { name: "Crypto", value: "crypto" },
              { name: "Both", value: "both" }
            )
        )
        .addIntegerOption(o => o.setName("sample").setDescription("How many random candidates to check, 10-300 (default 100)").setRequired(false))
        .addIntegerOption(o => o.setName("count").setDescription("How many of the most volatile to keep, 1-50 (default 15)").setRequired(false))
    ),

  new SlashCommandBuilder()
    .setName("scan")
    .setDescription("Run the technical scanner on this server's watchlist right now"),

  new SlashCommandBuilder()
    .setName("autoscan")
    .setDescription("Configure automatic recurring scans")
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on auto-scan")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post results in").setRequired(true))
        .addIntegerOption(o => o.setName("interval_minutes").setDescription("How often to scan, in minutes (default: fastest your watchlist size allows)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off auto-scan")),

  new SlashCommandBuilder()
    .setName("alerts")
    .setDescription("Get pinged only when a ticker's signal changes to Buy/Sell")
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on signal alerts")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post alerts in").setRequired(true))
        .addIntegerOption(o => o.setName("interval_minutes").setDescription("How often to check for changes, in minutes (default: fastest your watchlist size allows)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off signal alerts"))
    .addSubcommand(sc => sc.setName("history").setDescription("See how past alerts actually performed (needs ~5 days since they fired)")),

  new SlashCommandBuilder()
    .setName("backtest")
    .setDescription("Replay this bot's own signals over one ticker's history to see how they'd have done")
    .addStringOption(o => o.setName("ticker").setDescription("Ticker or crypto pair, e.g. AAPL or BTC/USD").setRequired(true))
    .addIntegerOption(o => o.setName("forward_days").setDescription("Days forward to measure each signal's return, 1-20 (default 5)").setRequired(false))
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log("Done. Commands can take up to an hour to show up everywhere the first time.");
  } catch (err) {
    console.error(err);
  }
})();
