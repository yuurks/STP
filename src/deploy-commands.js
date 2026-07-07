// Run this once (and again any time you change a command's shape):
//   npm run deploy-commands

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Manage this server's scanner watchlist")
    .addSubcommand(sc =>
      sc.setName("add").setDescription("Add a ticker or crypto pair to the watchlist")
        .addStringOption(o => o.setName("ticker").setDescription("e.g. AAPL, or a crypto pair like BTC/USD or BTC-USD").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("remove").setDescription("Remove a ticker from the watchlist")
        .addStringOption(o => o.setName("ticker").setDescription("Stock ticker or crypto pair to remove").setRequired(true))
    )
    .addSubcommand(sc => sc.setName("list").setDescription("Show the current watchlist")),

  new SlashCommandBuilder()
    .setName("scan")
    .setDescription("Run the technical scanner on this server's watchlist right now"),

  new SlashCommandBuilder()
    .setName("autoscan")
    .setDescription("Configure automatic recurring scans")
    .addSubcommand(sc =>
      sc.setName("on").setDescription("Turn on auto-scan")
        .addChannelOption(o => o.setName("channel").setDescription("Channel to post results in").setRequired(true))
        .addIntegerOption(o => o.setName("interval_minutes").setDescription("How often to scan, in minutes (default 60)").setRequired(false))
    )
    .addSubcommand(sc => sc.setName("off").setDescription("Turn off auto-scan"))
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
