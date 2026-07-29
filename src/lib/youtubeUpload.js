// Uploads a /shorts video straight to YouTube via the real Data API v3 -- the fully-automated
// path, no manual download/upload step. Requires a one-time human OAuth consent (see
// scripts/youtube-authorize.js) that can never be skipped or automated further: Google requires
// the channel owner to explicitly grant an app upload access before any unattended upload can
// happen, the same way every other YouTube upload tool works. Once YOUTUBE_CLIENT_ID/
// YOUTUBE_CLIENT_SECRET/YOUTUBE_REFRESH_TOKEN are set, everything after that is unattended.
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { Readable } = require("stream");

// YouTube Data API's default daily quota is 10,000 units; videos.insert costs 1,600 -- so 6
// uploads/day is the real ceiling without requesting a quota increase from Google (a manual
// request on their side, not something this code can do). Tracked in its own small file, not
// per-guild in watchlist.js, since every /shorts drop across every Discord server this bot runs
// in uploads to the same one real YouTube channel these credentials are authorized for.
const MAX_UPLOADS_PER_DAY = 6;
const QUOTA_FILE = path.join(__dirname, "..", "..", "data", "youtube-quota.json");

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function loadQuota() {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function saveQuota(state) {
  fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(state, null, 2));
}

function uploadsRemainingToday() {
  const state = loadQuota();
  if (state.date !== todayKey()) return MAX_UPLOADS_PER_DAY;
  return Math.max(0, MAX_UPLOADS_PER_DAY - state.count);
}

function recordUpload() {
  let state = loadQuota();
  if (state.date !== todayKey()) state = { date: todayKey(), count: 0 };
  state.count += 1;
  saveQuota(state);
}

function getOAuthClient() {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) return null;
  const client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  return client;
}

// "25" = News & Politics, a reasonable default for market/trading content -- overridable via env
// var since this is ultimately a judgment call, not something with one objectively correct value.
const CATEGORY_ID = process.env.YOUTUBE_CATEGORY_ID || "25";

// Throws on any reason it can't upload (not configured, quota exhausted, API error) -- callers
// are expected to catch and fall back to handing the file over for manual upload instead, same
// as every other best-effort step in the /shorts pipeline (see postShortsHighlight in index.js).
async function uploadShort({ videoBuffer, title, description }) {
  const auth = getOAuthClient();
  if (!auth) {
    throw new Error("YouTube upload not configured -- missing YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET/YOUTUBE_REFRESH_TOKEN");
  }
  if (uploadsRemainingToday() <= 0) {
    throw new Error(`YouTube daily upload quota reached (${MAX_UPLOADS_PER_DAY}/day) -- resets at UTC midnight`);
  }

  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description, categoryId: CATEGORY_ID },
      // Public, not private/unlisted -- the whole point of full automation is that it actually
      // goes live without a manual publish step. selfDeclaredMadeForKids is a required field on
      // every upload, not optional metadata.
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
    },
    media: { body: Readable.from(videoBuffer) }
  });

  recordUpload();
  const videoId = res.data.id;
  return { videoId, url: `https://youtube.com/shorts/${videoId}` };
}

module.exports = { uploadShort, uploadsRemainingToday };
