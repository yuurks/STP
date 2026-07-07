// One-off script: sets the bot's Discord profile picture to assets/logo.png.
// Run this once with `node src/set-avatar.js` — Discord rate-limits avatar changes
// (a couple per hour), so this isn't run automatically on every bot startup.

require("dotenv").config();
const path = require("path");
const { Client, GatewayIntentBits, Events } = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const logoPath = path.join(__dirname, "..", "assets", "logo.png");
    await client.user.setAvatar(logoPath);
    console.log(`Avatar updated for ${client.user.tag}.`);
  } catch (err) {
    console.error("Failed to set avatar:", err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
