// Run this once (and again any time you change a command's shape):
//   npm run deploy-commands

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

// Discord only lets a command be restricted as a whole -- there's no per-subcommand permission
// API. Commands that are entirely "change server config" (no read-only subcommand mixed in) get
// this at the top level. /alerts and /portfolio mix a read-only subcommand (history, status)
// with state-changing ones (on/off/digest-*, start/reset) -- those two stay open here and get an
// in-code check instead (see requireManageGuild in index.js), so the read-only half stays usable
// by everyone while the rest is still gated.
const MANAGE_GUILD_ONLY = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Manage this server's scanner watchlist")
    .setDefaultMemberPermissions(MANAGE_GUILD_ONLY)
    .addSubcommand(sc =>
      sc.setName("add").setDescription("Add one or more crypto pairs to the watchlist")
        .addStringOption(o => o.setName("ticker").setDescription("Crypto pair, e.g. BTC/USD -- comma or space separated for multiple, up to 50").setRequired(true))
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
    .setDefaultMemberPermissions(MANAGE_GUILD_ONLY)
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
    .addStringOption(o => o.setName("ticker").setDescription("Crypto pair, e.g. BTC/USD").setRequired(true))
    .addIntegerOption(o => o.setName("forward_days").setDescription("Days forward to measure each signal's return, 1-20 (default 5)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("autobuild")
    .setDescription("Automatically rebuild the watchlist from the biggest potential movers on a recurring schedule")
    .setDefaultMemberPermissions(MANAGE_GUILD_ONLY)
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
    .setDefaultMemberPermissions(MANAGE_GUILD_ONLY)
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on the daily Shorts drop (4pm and 8pm ET)")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post both daily drops in").setRequired(true))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off the daily Shorts drop"))
    .addSubcommand(sc => sc.setName("now").setDescription("Run a Shorts scan right now instead of waiting for the schedule")),

  new SlashCommandBuilder()
    .setName("discover")
    .setDescription("Scans the crypto pool and alerts when RSI/MACD/EMA scoring and ADX trend line up into a fresh Buy")
    .setDefaultMemberPermissions(MANAGE_GUILD_ONLY)
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on recurring Discover scans")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post qualifying signals in").setRequired(true))
        .addIntegerOption(o => o.setName("interval_hours").setDescription("How often to scan, in hours (default 4; rejected if too fast for the daily request budget)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off recurring Discover scans"))
    .addSubcommand(sc => sc.setName("now").setDescription("Run a Discover scan right now instead of waiting for the schedule"))
    .addSubcommand(sc => sc.setName("history").setDescription("See how past Discover alerts actually performed (needs ~5 days since they fired)")),

  new SlashCommandBuilder()
    .setName("degen")
    .setDescription("HIGH RISK: new Solana pairs passing liquidity/buy-pressure + a RugCheck risk screen (unvalidated)")
    .setDefaultMemberPermissions(MANAGE_GUILD_ONLY)
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on recurring Degen scans")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post qualifying pairs in").setRequired(true))
        .addIntegerOption(o => o.setName("interval_minutes").setDescription("How often to scan, in minutes, min 2 (default 10)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off recurring Degen scans"))
    .addSubcommand(sc => sc.setName("now").setDescription("Run a Degen scan right now instead of waiting for the schedule"))
    .addSubcommand(sc => sc.setName("history").setDescription("See how past Degen alerts actually performed (needs ~1 hour since they fired)")),

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

// Note for next time this happens: discord.js's SlashCommandBuilder already throws immediately
// (ExpectedConstraintError) the moment .setDescription()/.setName() is called with a string
// outside Discord's length limits (100 chars for descriptions, 32 for names) -- confirmed by
// testing it directly. That's what actually happened once: /degen's description grew past 100
// chars in a later edit, so building the `commands` array itself threw before this script ever
// reached rest.put() -- meaning /degen never registered at all -- while the other 9 commands
// kept showing up in Discord, because an earlier, still-valid deploy had already registered
// them (Discord keeps whatever was last successfully applied; this script never got that far
// again until the description was shortened). No extra validation needed here -- the builder
// already fails fast and points at the exact line. If you see "ExpectedConstraintError: Invalid
// string length" running this script, that's what it means -- check description/name lengths
// on whatever command you just touched.

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
