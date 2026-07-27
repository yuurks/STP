const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { parseLatestEntry, decodeXmlEntities } = require("../src/lib/youtubeWatch");

// Trimmed but structurally real shape (matches a live channel feed fetched during development),
// with two entries -- the parser must return only the first (most recent).
function feed({ videoId = "abc123", title = "A Title", url = "https://www.youtube.com/shorts/abc123", published = "2026-07-27T13:00:08+00:00" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <entry>
  <id>yt:video:${videoId}</id>
  <yt:videoId>${videoId}</yt:videoId>
  <yt:channelId>UC_x5XG1OV2P6uZZ5FSM9Ttw</yt:channelId>
  <title>${title}</title>
  <link rel="alternate" href="${url}"/>
  <published>${published}</published>
  <updated>${published}</updated>
  <media:group><media:title>${title}</media:title></media:group>
 </entry>
 <entry>
  <id>yt:video:older999</id>
  <yt:videoId>older999</yt:videoId>
  <title>Older video</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=older999"/>
  <published>2026-07-20T10:00:00+00:00</published>
 </entry>
</feed>`;
}

describe("parseLatestEntry", () => {
  test("returns the first (most recent) entry, not the older one", () => {
    const result = parseLatestEntry(feed());
    assert.equal(result.videoId, "abc123");
  });

  test("uses the entry's own link, not a reconstructed watch URL -- preserves /shorts/ URLs", () => {
    const result = parseLatestEntry(feed({ url: "https://www.youtube.com/shorts/abc123" }));
    assert.equal(result.url, "https://www.youtube.com/shorts/abc123");
    assert.equal(result.isShort, true);
  });

  test("flags a regular /watch?v= video as not a Short", () => {
    const result = parseLatestEntry(feed({ url: "https://www.youtube.com/watch?v=abc123" }));
    assert.equal(result.isShort, false);
  });

  test("decodes XML entities in the title", () => {
    const result = parseLatestEntry(feed({ title: "R&amp;D Update &lt;beta&gt;" }));
    assert.equal(result.title, "R&D Update <beta>");
  });

  test("returns null when the feed has no entries at all", () => {
    const empty = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;
    assert.equal(parseLatestEntry(empty), null);
  });
});

describe("decodeXmlEntities", () => {
  test("decodes the standard XML entity set", () => {
    assert.equal(decodeXmlEntities("Tom &amp; Jerry &lt;3&gt; &quot;fun&quot; &#39;times&#39;"), "Tom & Jerry <3> \"fun\" 'times'");
  });
});
