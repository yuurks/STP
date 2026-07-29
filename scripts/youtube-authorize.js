// One-time setup: mints a YOUTUBE_REFRESH_TOKEN so the bot can upload /shorts videos to YouTube
// completely unattended. This step can't be skipped or automated further -- Google requires the
// channel owner to explicitly grant an app upload access once before any unattended upload can
// happen, no matter what tool is doing the uploading.
//
// Before running this:
//   1. Go to https://console.cloud.google.com -> create a project (or reuse one) -> APIs &
//      Services -> Library -> enable "YouTube Data API v3".
//   2. APIs & Services -> OAuth consent screen -> configure it (External is fine). It can stay
//      in "Testing" mode -- add the Google account that owns your YouTube channel as a test
//      user under that screen; you don't need to publish/verify the app just for your own use.
//   3. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> Application
//      type "Web application" -> under Authorized redirect URIs add exactly:
//        http://localhost:53682/oauth2callback
//   4. Put the resulting Client ID and Client Secret into .env as YOUTUBE_CLIENT_ID and
//      YOUTUBE_CLIENT_SECRET.
//
// Then run:  node scripts/youtube-authorize.js
// It prints a URL -- open it, sign in with the Google account that owns the channel, and approve
// access. This script catches the redirect automatically and prints a refresh token: save that as
// YOUTUBE_REFRESH_TOKEN both in .env (for local testing) and in Railway's environment variables
// (for the real deployed bot). Only needs to run again if that token is ever revoked.
require("dotenv").config();
const http = require("http");
const { google } = require("googleapis");

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET } = process.env;
if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
  console.error(
    "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first -- see the setup steps in the " +
    "comment at the top of this file."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline", // required to get a refresh_token back, not just a short-lived access token
  prompt: "consent",      // forces the consent screen even on a repeat run, which is what actually guarantees a refresh_token comes back this time too
  scope: ["https://www.googleapis.com/auth/youtube.upload"]
});

console.log("\nOpen this URL, sign in with the Google account that owns your YouTube channel, and approve access:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  if (!code) {
    res.end("No code received -- check the terminal and try again.");
    return;
  }
  res.end("Done -- you can close this tab and go back to the terminal.");
  server.close();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      console.error(
        "\nGoogle didn't return a refresh token. This usually means this Google account already " +
        "authorized this exact app before -- go to https://myaccount.google.com/permissions, " +
        "remove access for this app, and run this script again."
      );
      process.exit(1);
    }
    console.log("\nSave this as YOUTUBE_REFRESH_TOKEN (in .env locally AND in Railway's environment variables):\n");
    console.log(tokens.refresh_token + "\n");
  } catch (err) {
    console.error("Token exchange failed:", err.message);
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Waiting for the redirect on http://localhost:${PORT} ...`);
});
