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
      sc.setName("autobuild").setDescription("Replace the watchlist with the biggest potential movers from the crypto candidate pool")
        .addIntegerOption(o => o.setName("count").setDescription("How many of the biggest movers to keep, 1-50 (default 15)").setRequired(false))
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
    .addSubcommand(sc => sc.setName("history").setDescription("See how past alerts actually performed (needs ~5 days since they fired)"))
    .addSubcommand(sc =>
      sc.setName("digest-on").setDescription("Automatically post the alert performance report on a schedule")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post the digest in").setRequired(true))
        .addIntegerOption(o => o.setName("interval_days").setDescription("How often to post, in days, min 1 (default 7)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("digest-off").setDescription("Turn off the automatic alert performance digest")),

  new SlashCommandBuilder()
    .setName("backtest")
    .setDescription("Replay this bot's own signals over one ticker's history to see how they'd have done")
    .addStringOption(o => o.setName("ticker").setDescription("Ticker or crypto pair, e.g. AAPL or BTC/USD").setRequired(true))
    .addIntegerOption(o => o.setName("forward_days").setDescription("Days forward to measure each signal's return, 1-20 (default 5)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("autobuild")
    .setDescription("Automatically rebuild the watchlist from the biggest potential movers on a recurring schedule")
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on scheduled autobuild")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post results in").setRequired(true))
        .addIntegerOption(o => o.setName("interval_hours").setDescription("How often to rebuild, in hours, min 24 (default 24)").setRequired(false))
        .addIntegerOption(o => o.setName("count").setDescription("How many of the biggest movers to keep, 1-50 (default 15)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off scheduled autobuild")),

  new SlashCommandBuilder()
    .setName("shorts")
    .setDescription("Automatic daily YouTube Shorts assets: today's biggest small/mid-cap crypto winner & loser")
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on the daily Shorts drop (4pm and 8pm ET)")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post both daily drops in").setRequired(true))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off the daily Shorts drop"))
    .addSubcommand(sc => sc.setName("now").setDescription("Run a Shorts scan right now instead of waiting for the schedule")),

  new SlashCommandBuilder()
    .setName("portfolio")
    .setDescription("Simulated paper-trading portfolio driven by this bot's own signals (no real money)")
    .addSubcommand(sc =>
      sc.setName("start").setDescription("Start a new paper portfolio")
        .addNumberOption(o => o.setName("starting_cash").setDescription("Virtual starting cash, $100-$1,000,000 (default $10,000)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("status").setDescription("Show paper portfolio value, open positions, and recent trades"))
    .addSubcommand(sc => sc.setName("reset").setDescription("Wipe the paper portfolio and start over"))
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
