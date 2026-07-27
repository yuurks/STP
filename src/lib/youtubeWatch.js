// Watches a YouTube channel for new uploads using only public endpoints -- no API key or OAuth
// needed, and no actual upload automation: this only notices a video exists and announces it.
// Uploading the video itself is still on a human (see shorts.js/bestCall.js for the image-
// generation side of this bot, which is as far as it goes).

// YouTube serves a stripped-down page (no embedded channel data at all) to Node's default fetch
// User-Agent -- confirmed directly: the exact same URL returns full data with a real browser UA
// and effectively nothing without one. Needed for resolveChannelId below.
const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CHANNEL_ID_SHAPE = /^UC[\w-]{22}$/;

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// A handle (@name) is just a display alias, not the channel ID the RSS feed actually needs --
// this accepts a bare channel ID, a /channel/UC.../ URL, a handle, or a handle's full URL, and
// resolves all of them down to the real UC... ID via the canonical link every channel page
// embeds (confirmed stable against a real channel; more reliable than scraping an internal JSON
// field, which is more likely to shift under YouTube's own redesigns).
async function resolveChannelId(input) {
  const trimmed = input.trim();
  if (CHANNEL_ID_SHAPE.test(trimmed)) return trimmed;

  const directMatch = trimmed.match(/\/channel\/(UC[\w-]{22})/);
  if (directMatch) return directMatch[1];

  const url = trimmed.startsWith("http") ? trimmed : `https://www.youtube.com/@${trimmed.replace(/^@/, "")}`;
  const res = await fetch(url, { headers: { "User-Agent": REALISTIC_USER_AGENT } });
  if (!res.ok) throw new Error(`Couldn't load that YouTube channel page (${res.status})`);
  const html = await res.text();
  const canonical = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/);
  if (!canonical) throw new Error("Couldn't find a channel ID on that page -- check the URL/handle");
  return canonical[1];
}

// Pure parsing, separated from the fetch below so it's directly testable without a live network
// call. Only the single most recent entry is needed -- this exists purely to detect "is there
// something newer than the last one seen," not to list history. The entry's own <link
// rel="alternate"> is used as-is (not reconstructed) since YouTube gives Shorts a real
// /shorts/<id> URL there, not /watch?v=<id> -- reconstructing it would silently lose that.
function parseLatestEntry(xml) {
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;
  const entry = entryMatch[1];

  const videoId = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
  const title = entry.match(/<title>(.*?)<\/title>/)?.[1];
  const url = entry.match(/<link rel="alternate" href="([^"]+)"/)?.[1];
  const publishedAt = entry.match(/<published>(.*?)<\/published>/)?.[1];
  if (!videoId || !url) return null;

  return {
    videoId,
    title: title ? decodeXmlEntities(title) : "(untitled)",
    url,
    publishedAt,
    isShort: url.includes("/shorts/")
  };
}

// The channel's public Atom feed -- confirmed live against a real channel: no key, no OAuth,
// lists roughly the 15 most recent uploads. Returns null if the channel has no videos at all.
async function fetchLatestVideo(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`YouTube feed lookup returned ${res.status}`);
  const xml = await res.text();
  return parseLatestEntry(xml);
}

module.exports = { resolveChannelId, fetchLatestVideo, parseLatestEntry, decodeXmlEntities };
