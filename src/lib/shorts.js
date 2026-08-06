// Shared logic behind both the manual scripts/find-movers.js + scripts/generate-short.js dev
// tools and the bot's own scheduled "Shorts" job (see src/index.js) -- scans a candidate pool
// for today's single biggest gainer/loser, then fills the HTML template with real numbers.
// Kept out of index.js so the CLI scripts and the bot never drift into two implementations of
// the same scan.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Text rendering went through two real bugs on Railway before landing here -- both only visible
// by actually rendering the deployed output, never from reading the code:
//   1. Tofu boxes (empty glyph outlines): fontconfig couldn't write its cache because HOME pointed
//      at something unwritable in the container. Fixed by forcing HOME/XDG_CACHE_HOME below.
//   2. Wrong, garbled (CJK-looking) glyphs -- worse, in a way, because it *looked* like text had
//      rendered: once fontconfig could actually run, our @font-face-embedded "STPSans"/"STPMono"
//      names still didn't resolve (librsvg's CSS support for @font-face + base64 data URIs is
//      known to be inconsistent across versions -- it silently failed to register the family
//      instead of erroring), so fontconfig fell back to matching "sans-serif" against whatever
//      real font happened to be installed in the container for unrelated reasons -- in this case
//      a CJK font, which has glyphs for basically every codepoint but the wrong shapes entirely.
// The fix for #2: stop asking librsvg to parse embedded font bytes at all. Instead, point
// fontconfig directly at our actual DejaVu .ttf files on disk (already committed under
// assets/fonts/) via a generated fonts.conf, and reference their real family names ("DejaVu
// Sans" / "DejaVu Sans Mono") in the SVG. This is fontconfig's normal, well-supported font
// discovery path -- the same one that finds real system fonts on a dev machine -- so it doesn't
// depend on librsvg's CSS parser at all.
process.env.HOME = os.tmpdir();
process.env.XDG_CACHE_HOME = os.tmpdir();

const fontconfigCacheDir = path.join(os.tmpdir(), "stp-fontconfig-cache");
fs.mkdirSync(fontconfigCacheDir, { recursive: true });
const fontconfigConfPath = path.join(os.tmpdir(), "stp-fonts.conf");
fs.writeFileSync(fontconfigConfPath, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${path.join(__dirname, "..", "..", "assets", "fonts")}</dir>
  <cachedir>${fontconfigCacheDir}</cachedir>
</fontconfig>
`);
process.env.FONTCONFIG_FILE = fontconfigConfPath;

const sharp = require("sharp");
const { fetchDailySeries, fetchIntradaySeries } = require("./marketData");
const { formatMoney } = require("./format");
const universe = require("./universe");

const PACING_MS = 7500; // same as the bot -- stays under Twelve Data's free 8 req/min
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Crypto trades round the clock, so "intraday" means a trailing 24h window: 96 bars at 15min each.
const INTRADAY_BAR_COUNT = 96;

// Scans a random sample of the given universe (see universe.js for the "kind" options) for the
// day's single biggest gainer and loser, then fetches each one's intraday bars for the chart.
// NOT filtered/ranked by volume: Twelve Data doesn't return volume data for crypto pairs
// (confirmed 2026-07-22 -- the field is absent/zero everywhere tried, not a free-tier gap), so a
// volume-surge requirement here would silently exclude every candidate, always. This used to
// carry that filter; it never actually did anything since every candidate's volume reads as 0,
// so it always fell back to this exact behavior anyway -- just removed the dead code. Same
// output shape as scripts/find-movers.js's output (data/movers.json), plus a `universeKind` tag.
async function findMover(universeKind, sampleSize) {
  const pool = universe.loadUniverse(universeKind);
  const candidates = universe.sample(pool, sampleSize);

  let winner = null, loser = null;
  let checked = 0;

  for (const symbol of candidates) {
    try {
      const rows = await fetchDailySeries(symbol, 30);
      if (rows.length >= 2) {
        const last = rows[rows.length - 1];
        const prev = rows[rows.length - 2];
        const pctChange = ((last.close - prev.close) / prev.close) * 100;
        const entry = { symbol, pctChange, price: last.close };

        if (!winner || pctChange > winner.pctChange) winner = entry;
        if (!loser || pctChange < loser.pctChange) loser = entry;
        checked++;
      }
    } catch (err) {
      console.error(`Shorts scan skipped ${symbol}: ${err.message}`);
    }
    await sleep(PACING_MS);
  }

  for (const entry of [winner, loser]) {
    if (!entry) continue;
    await sleep(PACING_MS);
    try {
      const bars = await fetchIntradaySeries(entry.symbol, "15min", INTRADAY_BAR_COUNT);
      entry.intraday = { times: bars.map(b => b.time), closes: bars.map(b => b.close) };
      // Recompute pctChange/price from this SAME intraday series rather than leaving the
      // daily-close pctChange from the cheap scan above -- that daily figure (yesterday's close
      // vs the day before) has no relationship to the Open/Now prices buildFallbackHighlight
      // actually displays (this series' first/last close), and for a thinly-traded symbol where
      // the intraday window has to reach back multiple days (see formatSessionLabel), the two can
      // straightforwardly disagree -- confirmed via a real posted card: "$0.00142 -> $0.00134
      // (+0.8%)", a price DECREASE labeled as a gain. Whatever ends up on the card must always be
      // internally consistent with itself, even if it now differs slightly from the number that
      // originally ranked this candidate as the day's winner in the scan above.
      if (entry.intraday.closes.length >= 2) {
        const openPrice = entry.intraday.closes[0];
        const nowPrice = entry.intraday.closes[entry.intraday.closes.length - 1];
        entry.pctChange = ((nowPrice - openPrice) / openPrice) * 100;
        entry.price = nowPrice;
      }
    } catch (err) {
      console.error(`Shorts intraday fetch failed for ${entry.symbol}: ${err.message}`);
    }
  }

  return { universeKind, candidateCount: candidates.length, checked, winner, loser };
}

function parseBarTime(t) {
  return new Date(t.replace(" ", "T"));
}

// Crypto's intraday window is a trailing 24h, not a bounded session -- and since 96 x 15min bars
// lands back on the exact same clock time a day later, the date has to be shown too ("10:15 PM
// -10:15 PM" alone would read as zero elapsed time). Thinly-traded coins can have real gaps in
// their 15min bars (no trade in that window), so Twelve Data has to reach back further than 24h
// to fill 96 of them -- confirmed in practice (a real small-cap coin's "96 bars" spanned 8 days,
// not 24h). Claiming "Last 24 hours" on a chart that's actually over a week wide would be a real,
// visible lie, so the label itself reflects whichever is actually true.
function formatSessionLabel(times) {
  const fmtTime = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const start = parseBarTime(times[0]);
  const end = parseBarTime(times[times.length - 1]);
  const spanHours = (end - start) / 3600000;
  const label = spanHours <= 30 ? "Last 24 hours" : "Recent activity (thin trading)";
  return `${label} · ${fmtDate(start)} ${fmtTime(start)} – ${fmtDate(end)} ${fmtTime(end)} ET`;
}

function formatMetaLine(times) {
  const last = parseBarTime(times[times.length - 1]);
  const date = last.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = last.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time} ET · Source: Twelve Data`;
}

const TEMPLATE_PATH = path.join(__dirname, "..", "..", "scripts", "movers-short.template.html");
const LOGO_PATH = path.join(__dirname, "..", "..", "assets", "logo.png");

// DejaVu Sans/Sans Mono: public domain-derived (Bitstream Vera + public domain additions), fully
// redistributable, excellent Unicode coverage (confirmed: →, ·, × all render). Discovered by
// fontconfig via the generated fonts.conf above -- see the big comment near the top of this file
// for why that replaced embedding the font bytes directly in the SVG.

// Fills scripts/movers-short.template.html with a { winner, loser } pair (each needs
// .symbol/.pctChange/.price/.intraday.{times,closes} -- exactly what findMover() returns) and
// returns the finished, self-contained HTML as a string, ready to write to disk or attach to a
// Discord message.
function generateShortHtml(winner, loser) {
  if (!winner?.intraday?.closes?.length || !loser?.intraday?.closes?.length) {
    throw new Error("winner/loser is missing intraday data -- run findMover() first");
  }

  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const logoSrc = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`;
  const round2 = arr => arr.map(v => Math.round(v * 100) / 100);

  return template
    .split("{{LOGO_SRC}}").join(logoSrc)
    .split("{{WINNER_TICKER}}").join(winner.symbol)
    .split("{{WINNER_PCT}}").join(winner.pctChange.toFixed(1))
    .split("{{WINNER_OPEN}}").join(formatMoney(winner.intraday.closes[0]))
    .split("{{WINNER_PRICE}}").join(formatMoney(winner.price))
    .split("{{WINNER_CLOSES}}").join(JSON.stringify(round2(winner.intraday.closes)))
    .split("{{LOSER_TICKER}}").join(loser.symbol)
    .split("{{LOSER_PCT}}").join(loser.pctChange.toFixed(1))
    .split("{{LOSER_OPEN}}").join(formatMoney(loser.intraday.closes[0]))
    .split("{{LOSER_PRICE}}").join(formatMoney(loser.price))
    .split("{{LOSER_CLOSES}}").join(JSON.stringify(round2(loser.intraday.closes)))
    .split("{{WINNER_SESSION_LABEL}}").join(formatSessionLabel(winner.intraday.times))
    .split("{{LOSER_SESSION_LABEL}}").join(formatSessionLabel(loser.intraday.times))
    .split("{{META_LINE}}").join(formatMetaLine(winner.intraday.times));
}

// Same palette used in movers-short.template.html, validated for CVD-safety/contrast --
// duplicated here (not imported) since the template's copy lives in CSS custom properties,
// not a shape a Node module can require.
const COLORS = {
  surface: "#0b0f14",
  card: "#131a22",
  textPrimary: "#ffffff",
  textSecondary: "#8b93a1",
  textMuted: "#5b6472",
  winner: "#0ca34a",
  winnerFill: "rgba(12,163,74,0.18)",
  loser: "#e0433d",
  loserFill: "rgba(224,67,61,0.18)",
  cta: "#5865f2"
};

// Decorative-only, never used for data encoding: the exact green sampled from assets/logo.png's
// own pixels (see the shorts-redesign-concept "Option A -- Glow" comparison), used purely for the
// glow halo behind the percentage and the card's ambient edge glow. COLORS.winner stays the actual
// accent for anything that encodes information (border, candles, chart line) because it's the one
// validated for CVD-safety/contrast -- the sampled brand green isn't re-checked against that bar,
// so it never carries meaning on its own, only atmosphere.
const GLOW_GREEN = "#06e02d";
// The lighter of the two sampled logo greens -- used only for the hero card's percentage text
// fill (see heroCardSvg), matching the artifact's --accent-glow. GLOW_GREEN itself stays reserved
// for the halo/blur behind it, exactly like the artifact's two-tone glow.
const GLOW_GREEN_LIGHT = "#6bf046";
// A third, distinct accent reserved for exactly one thing: the "Verified" trust badge (and, in
// heroCardSvg, the entry marker) on a real, logged /shorts call -- never reused elsewhere, so it
// stays legible as "this one specific claim is verified" rather than blending into the page's
// green. Exact value matches the artifact's --cyan, not a rounded approximation.
const TRUST_CYAN = "#4fc3f7";
// heroCardSvg's own chart down-color -- started as the artifact's muted ".chart i.down" exactly,
// brightened/pinked up and made more opaque per feedback so it actually reads as a color (and
// glows visibly once wrapped in the shared blur filter) instead of a dark, half-transparent red.
// Decorative-only, same reasoning as GLOW_GREEN above: this chart's colors are one card's
// atmosphere, not a place that needs to clear the CVD-safety bar the shared COLORS palette is
// validated against.
const HERO_CHART_DOWN = "rgba(255,92,144,0.85)";

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Same line + area-fill math as the browser's renderChart() in the HTML template, just
// computed server-side instead of against a live SVG element. Used for the fallback/live-mover
// path, and as the honest 2-point entry->now line for /degen and /breakout picks (see
// bestCall.js -- those have no real candle history to draw more than 2 points from).
// visibleCount (default: all of them) draws only the first N points -- used by the reveal-video
// pipeline (see buildRevealFrames) to animate the line growing in over several frames. min/max/
// stepX are always computed from the FULL closes array regardless, so the axis scale and point
// spacing never shift between frames as more of the line becomes visible -- only reveals more of
// an already-fixed line, never redraws it at a different scale.
// visibleCount may be fractional (e.g. 3.6) -- the leading edge then interpolates 60% of the way
// from point 3 to point 4 instead of jumping straight to point 4, so the reveal video's line
// actually draws itself growing forward rather than popping in one whole point at a time.
function chartPaths(closes, x, y, w, h, visibleCount) {
  const pad = 6;
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = (max - min) || 1;
  // closes.length - 1 divides into stepX -- guard the single-bar case (a thin/newly-listed
  // small-cap coin could plausibly return only one intraday bar) so this produces a flat line
  // at x=pad instead of NaN coordinates from a divide-by-zero.
  const stepX = closes.length > 1 ? (w - pad * 2) / (closes.length - 1) : 0;
  const allPoints = closes.map((v, i) => [
    x + pad + i * stepX,
    y + pad + (h - pad * 2) * (1 - (v - min) / range)
  ]);
  const maxN = allPoints.length;
  const rawShown = Math.max(1, Math.min(maxN, visibleCount ?? maxN));
  const fullShown = Math.floor(rawShown);
  const growFraction = rawShown - fullShown;
  const points = allPoints.slice(0, fullShown);
  if (growFraction > 0 && fullShown < maxN) {
    const p0 = points.length ? points[points.length - 1] : allPoints[0];
    const p1 = allPoints[fullShown];
    points.push([p0[0] + (p1[0] - p0[0]) * growFraction, p0[1] + (p1[1] - p0[1]) * growFraction]);
  }
  if (!points.length) points.push(allPoints[0]);
  const line = points.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = line + ` L${points[points.length - 1][0].toFixed(1)},${(y + h - pad).toFixed(1)} L${points[0][0].toFixed(1)},${(y + h - pad).toFixed(1)} Z`;
  const last = points[points.length - 1];
  const first = allPoints[0];
  // First point is always the entry -- closes[0] is the logged entry price by construction
  // (see bestCall.js), never a fabricated earlier value.
  return {
    line, area, lastX: last[0], lastY: last[1], entryX: first[0], entryY: first[1], min, max,
    fullyRevealed: rawShown >= maxN
  };
}

// Real candlesticks from real daily OHLC (see bestCall.js -- only /alerts and /discover picks
// ever have this; DexScreener has no historical candles for /degen or /breakout at all, so those
// never reach this function). Standard convention: wick = high/low, body = open/close, green
// body when the day closed up, red when it closed down -- same color language as an actual
// trading chart, not this bot's own winner/loser palette.
// entryIndex/entryPrice mark where the call actually fired (see bestCall.js) -- entryPrice, not
// that candle's own close, sets the marker's Y position, so the circled entry lines up exactly
// with the "Called at $X" text above it rather than whatever a nearby candle's close happens to
// be (usually near-identical, but this keeps them exact rather than approximate).
// visibleCount (default: all of them) draws only the first N candles -- used by the reveal-video
// pipeline (see buildRevealFrames) to animate the chart building up one candle at a time. Slot
// positions and the min/max scale are always computed from the FULL ohlc array regardless, so
// candles never shift position or rescale as more of them become visible.
// visibleCount may be fractional (e.g. 3.6) -- the most recently added candle then grows in from
// its own vertical center outward (60% of full height, in that example) instead of popping in
// fully formed, so each new candle in the reveal video has a real entrance instead of appearing
// abruptly.
// upColor/downColor default to the app's CVD-validated COLORS.winner/loser (every other caller of
// this shared function, e.g. the dual-card dev format, gets byte-identical behavior) -- heroCardSvg
// is the only caller that overrides them, to match the shorts-redesign-concept artifact's own
// chart colors (a brighter green, a muted pink-red) exactly rather than the app's accessibility
// palette, since that's a purely decorative/atmospheric choice on this one card, not a place any
// color itself carries meaning beyond "up" vs "down."
function candlePaths(ohlc, x, y, w, h, entryIndex, entryPrice, visibleCount, upColor = COLORS.winner, downColor = COLORS.loser) {
  const pad = 6;
  const values = ohlc.flatMap(c => [c.high, c.low]);
  const min = Math.min(...values, entryPrice), max = Math.max(...values, entryPrice);
  const range = (max - min) || 1;
  const n = ohlc.length;
  const slotW = n > 0 ? (w - pad * 2) / n : 0;
  const bodyW = Math.max(3, Math.min(28, slotW * 0.6));
  const toY = v => y + pad + (h - pad * 2) * (1 - (v - min) / range);
  const slotX = i => x + pad + slotW * (i + 0.5);

  const rawShown = Math.max(0, Math.min(n, visibleCount ?? n));
  const fullShown = Math.floor(rawShown);
  const growFraction = rawShown - fullShown;
  const drawCount = Math.min(n, fullShown + (growFraction > 0 ? 1 : 0));
  const candles = ohlc.slice(0, drawCount).map((c, i) => {
    const cx = slotX(i);
    const isUp = c.close >= c.open;
    const color = isUp ? upColor : downColor;
    let wickTop = toY(c.high), wickBottom = toY(c.low);
    let bodyTop = toY(Math.max(c.open, c.close)), bodyBottom = toY(Math.min(c.open, c.close));
    if (i === fullShown && growFraction > 0) {
      const mid = (wickTop + wickBottom) / 2;
      wickTop = mid + (wickTop - mid) * growFraction;
      wickBottom = mid + (wickBottom - mid) * growFraction;
      bodyTop = mid + (bodyTop - mid) * growFraction;
      bodyBottom = mid + (bodyBottom - mid) * growFraction;
    }
    return (
      `<line x1="${cx.toFixed(1)}" y1="${wickTop.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${wickBottom.toFixed(1)}" stroke="${color}" stroke-width="2.5"/>` +
      `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(2.5, bodyBottom - bodyTop).toFixed(1)}" rx="1.5" fill="${color}"/>`
    );
  }).join("");

  const lastX = x + pad + slotW * (n - 0.5);
  const lastY = toY(ohlc[n - 1].close);
  const clampedEntryIndex = Math.max(0, Math.min(n - 1, entryIndex ?? 0));
  return {
    candles, lastX, lastY, min, max, entryX: slotX(clampedEntryIndex), entryY: toY(entryPrice),
    fullyRevealed: rawShown >= n
  };
}

// Gridlines + a subtle frame behind the chart itself (candlestick or line) -- the piece that was
// missing before: a bare line or candle set floating with no axis reference doesn't read as a
// real chart. Same treatment for both chart types so /degen /breakout's honest 2-point line and
// /alerts /discover's real candlesticks look like they belong to the same product.
//
// One combined "range" label above the frame, rather than separate high/low labels pinned to
// corners -- corner placement only avoids the plotted line/candles for ONE trend direction;
// the dual-card format's loser side is a downtrend (starts high, ends low), and separate
// high-top/low-bottom labels collided with either the endpoint or neighboring text depending on
// which corner and which card size, confirmed against real renders in both directions. A single
// line in the gap above the frame is correct regardless of trend and regardless of card height.
// labelFontSize defaults to the size every other caller (the dual-card format) has always used --
// heroCardSvg is the only caller that passes a bigger one, to match the artifact's own ".panel
// .range" size scaled up to this card's size instead of staying at the old card's fixed size.
function chartFrame(x, y, w, h, min, max, labelFontSize = 17) {
  const pad = 6;
  const rows = 4;
  const gridLines = Array.from({ length: rows + 1 }, (_, i) => {
    const gy = y + pad + (h - pad * 2) * (i / rows);
    return `<line x1="${x + pad}" y1="${gy.toFixed(1)}" x2="${x + w - pad}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
  }).join("");

  return (
    `<text x="${x}" y="${(y - 8).toFixed(1)}" font-family="DejaVu Sans" font-size="${labelFontSize}" font-weight="700" fill="${COLORS.textMuted}">RANGE ${escapeXml(formatMoney(min))} - ${escapeXml(formatMoney(max))}</text>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.10)" stroke-width="1.5" rx="10"/>` +
    gridLines
  );
}

// entryIndex/entryPriceRaw locate the actual buy entry on the chart (see bestCall.js) -- drawn
// as a distinct unfilled ring + "BUY" tag in a fixed red, always, regardless of the card's own
// accent color (which is always green here since every /shorts highlight is a winner) -- so the
// entry marker reads as its own fixed visual language ("this is where you bought") rather than
// blending into whatever color the rest of the card happens to use, and is never the same solid
// dot used for "now."
// frameBottomY (the chart floor -- see chartFrame) draws a thin dashed guide line down from the
// entry, so the eye lands on the exact point at a glance instead of hunting the chart for a small
// ring -- and a soft glow halo behind the ring adds visual weight without adding new shapes/text,
// same trick as a highlighted point on a real trading chart. No new colors either: everything
// here is still the same fixed COLORS.loser red the marker always used.
function entryMarkerSvg(entryX, entryY, frameBottomY) {
  const color = COLORS.loser;
  return (
    `<line x1="${entryX.toFixed(1)}" y1="${entryY.toFixed(1)}" x2="${entryX.toFixed(1)}" y2="${frameBottomY.toFixed(1)}" stroke="${color}" stroke-width="2" stroke-dasharray="5,5" stroke-opacity="0.45"/>` +
    `<circle cx="${entryX.toFixed(1)}" cy="${entryY.toFixed(1)}" r="26" fill="${color}" fill-opacity="0.16"/>` +
    `<circle cx="${entryX.toFixed(1)}" cy="${entryY.toFixed(1)}" r="15" fill="none" stroke="${color}" stroke-width="4"/>` +
    `<circle cx="${entryX.toFixed(1)}" cy="${entryY.toFixed(1)}" r="5" fill="${color}"/>` +
    `<text x="${entryX.toFixed(1)}" y="${(entryY - 24).toFixed(1)}" font-family="DejaVu Sans" font-size="19" font-weight="800" letter-spacing="0.5" fill="${color}" text-anchor="middle">BUY</text>`
  );
}

// Cyan variant of entryMarkerSvg, used only by the hero /shorts card (heroCardSvg) to match the
// Option A -- Glow comparison artifact exactly: that design ties its entry dot to the same cyan
// used for the "Verified" badge (one consistent "trust" color), not the fixed red used everywhere
// else in the app. Kept as a separate function rather than a color parameter on entryMarkerSvg so
// the original red marker (used by the dual-card dev format) is never at risk of accidentally
// changing color too.
// glowId, when given, applies the same soft glow the artifact's ".entry { box-shadow: 0 0 12px }"
// gives its marker -- optional (defaults to none) so this stays a drop-in match for the plain
// entryMarkerSvg() call signature wherever a caller doesn't have a glow filter defined.
function entryMarkerCyanSvg(entryX, entryY, frameBottomY, glowId) {
  const color = TRUST_CYAN;
  const glowAttr = glowId ? ` filter="url(#${glowId})"` : "";
  return (
    `<line x1="${entryX.toFixed(1)}" y1="${entryY.toFixed(1)}" x2="${entryX.toFixed(1)}" y2="${frameBottomY.toFixed(1)}" stroke="${color}" stroke-width="2" stroke-dasharray="5,5" stroke-opacity="0.45"/>` +
    `<circle cx="${entryX.toFixed(1)}" cy="${entryY.toFixed(1)}" r="13" fill="rgba(79,195,247,0.25)" stroke="${color}" stroke-width="5"${glowAttr}/>` +
    `<text x="${entryX.toFixed(1)}" y="${(entryY - 26).toFixed(1)}" font-family="DejaVu Sans" font-size="24" font-weight="800" letter-spacing="0.5" fill="${color}" text-anchor="middle">BUY</text>`
  );
}

// showEntryMarker defaults false so the old dual-card winner/loser format (generateShortImage,
// only used by the standalone dev scripts now) keeps its original look -- a "BUY" ring makes
// sense on a /shorts best-call highlight, not on a "loser" card in the old format, which has no
// real buy-entry concept at all.
//
// `reveal`, when provided, renders one frame of the animated reveal video (see buildRevealFrames)
// instead of the finished static card -- omitted entirely (stays undefined) for the real /shorts
// PNG, which keeps this function's default behavior byte-for-byte identical to before. Every
// reveal.* field defaults to "fully shown" so a partial reveal object only has to specify what's
// actually still hidden at that frame.
function cardSvg({
  x, y, w, h, accent, accentFill, tagLabel, ticker, pctChange, openPrice, nowPrice, closes, ohlc,
  entryIndex, entryPriceRaw, timeframe, volumeSurgeRatio, chartH = 170, entryLabel = "Open",
  showEntryMarker = false, reveal
}) {
  const pad = 40;
  const chartY = y + h - pad - chartH - 40;
  const chartX = x + pad, chartW = w - pad * 2;

  const showTag = reveal?.showTag ?? true;
  const showTicker = reveal?.showTicker ?? true;
  const showPct = reveal?.showPct ?? true;
  const pctFraction = reveal?.pctFraction ?? 1;
  const showPriceLine = reveal?.showPriceLine ?? true;
  const showChart = reveal?.showChart ?? true;
  const chartRevealCount = reveal?.chartRevealCount; // undefined = fully revealed
  const showMarker = showEntryMarker && (reveal?.showEntryMarker ?? true);

  const useCandles = Array.isArray(ohlc) && ohlc.length >= 2;
  const frame = !showChart ? null : (useCandles
    ? (() => {
        const c = candlePaths(ohlc, chartX, chartY, chartW, chartH, entryIndex, entryPriceRaw, chartRevealCount);
        return { ...c, draw: chartFrame(chartX, chartY, chartW, chartH, c.min, c.max) + c.candles + (showMarker ? entryMarkerSvg(c.entryX, c.entryY, chartY + chartH) : "") };
      })()
    : (() => { const c = chartPaths(closes, chartX, chartY, chartW, chartH, chartRevealCount); return {
        ...c,
        draw: chartFrame(chartX, chartY, chartW, chartH, c.min, c.max) +
          `<path d="${c.area}" fill="${accentFill}"/>` +
          `<path d="${c.line}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
          (showMarker ? entryMarkerSvg(c.entryX, c.entryY, chartY + chartH) : "") +
          // The "now" dot only makes sense once the line has actually reached its final point --
          // showing it mid-reveal would put a solid endpoint dot in the middle of the line.
          (c.fullyRevealed ? `<circle cx="${c.lastX.toFixed(1)}" cy="${c.lastY.toFixed(1)}" r="9" fill="${accent}"/>` : "")
      }; })());

  const pctText = `${pctChange >= 0 ? "+" : ""}${(pctChange * pctFraction).toFixed(1)}%`;
  const surgeText = volumeSurgeRatio ? `${volumeSurgeRatio.toFixed(1)}× VOLUME` : null;
  const surgeWidth = surgeText ? 46 + surgeText.length * 15 : 0;

  // Suffixed by this card's own x/y so two cardSvg() calls in the same document (the dual-card
  // winner/loser layout) never collide on filter/gradient ids -- SVG ids are global to the whole
  // document, not scoped to the fragment that defines them.
  const glowId = `cardGlow_${x}_${y}`;
  const haloId = `pctHalo_${x}_${y}`;
  // Trust badge sits immediately right of the tag pill -- gated on the raw showEntryMarker flag
  // (this card IS a verified real call), not the reveal-timed ring itself, so it appears on the
  // same beat as the tag/card rather than flickering in late alongside the entry-ring animation.
  const showVerified = showEntryMarker && showTag;

  return `
    <defs>
      <filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="12" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <radialGradient id="${haloId}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${GLOW_GREEN}" stop-opacity="0.38"/>
        <stop offset="100%" stop-color="${GLOW_GREEN}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="none" stroke="${GLOW_GREEN}" stroke-opacity="0.3" stroke-width="7" filter="url(#${glowId})"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="${COLORS.card}" stroke="${accent}" stroke-opacity="0.5" stroke-width="2.5"/>
    ${showTag ? `
    <rect x="${x + pad}" y="${y + 30}" width="150" height="44" rx="10" fill="${accentFill}"/>
    <text x="${x + pad + 18}" y="${y + 60}" font-family="DejaVu Sans" font-size="23" font-weight="800" letter-spacing="1.5" fill="${accent}">${escapeXml(tagLabel.toUpperCase())}</text>
    ` : ""}
    ${showVerified ? `
    <rect x="${x + pad + 162}" y="${y + 30}" width="150" height="44" rx="10" fill="rgba(79,214,255,0.14)"/>
    <circle cx="${x + pad + 184}" cy="${y + 52}" r="6" fill="${TRUST_CYAN}"/>
    <text x="${x + pad + 200}" y="${y + 60}" font-family="DejaVu Sans" font-size="19" font-weight="800" letter-spacing="1" fill="${TRUST_CYAN}">VERIFIED</text>
    ` : ""}
    ${surgeText ? `
    <rect x="${x + w - pad - surgeWidth}" y="${y + 30}" width="${surgeWidth}" height="44" rx="10" fill="rgba(88,101,242,0.18)"/>
    <text x="${x + w - pad - surgeWidth / 2}" y="${y + 60}" font-family="DejaVu Sans" font-size="21" font-weight="800" letter-spacing="0.5" fill="${COLORS.cta}" text-anchor="middle">${escapeXml(surgeText)}</text>
    ` : ""}
    ${showTicker ? `<text x="${x + pad}" y="${y + 140}" font-family="DejaVu Sans Mono" font-size="52" font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(ticker)}</text>` : ""}
    ${showPct ? `
    <ellipse cx="${x + pad + 150}" cy="${(y + 195).toFixed(1)}" rx="270" ry="130" fill="url(#${haloId})"/>
    <text x="${x + pad}" y="${y + 240}" font-family="DejaVu Sans" font-size="100" font-weight="900" fill="${accent}" filter="url(#${glowId})">${pctText}</text>
    ` : ""}
    ${showPriceLine ? `<text x="${x + pad}" y="${y + 282}" font-family="DejaVu Sans" font-size="29" fill="${COLORS.textSecondary}">${escapeXml(entryLabel)} <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(openPrice)}</tspan> → Now <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(nowPrice)}</tspan></text>` : ""}
    ${frame ? frame.draw : ""}
    <text x="${x + pad}" y="${y + h - 24}" font-family="DejaVu Sans" font-size="23" font-weight="700" letter-spacing="1" fill="${COLORS.textMuted}">${escapeXml(timeframe.toUpperCase())}</text>
  `;
}

// Wraps markup in a scale transform centered on (cx,cy) -- the same "pop in" technique
// buildPromoRevealFrames used (small -> overshoot -> settle) for the promo video, reused here so
// each piece of the hero card (topbar, badge/ticker, price line, CTA) actually animates into place
// during the reveal video instead of snapping from invisible to fully shown in one frame cut.
// scale === 1 skips the wrapper entirely, so the static image (which never passes a reveal object,
// hence never a non-1 scale) renders byte-for-byte the same as before this existed.
function popGroup(cx, cy, scale, content) {
  if (scale === 1) return content;
  return `<g transform="translate(${cx.toFixed(1)},${cy.toFixed(1)}) scale(${scale.toFixed(3)}) translate(${(-cx).toFixed(1)},${(-cy).toFixed(1)})">${content}</g>`;
}

// A faithful port of the "Option A -- Glow" card from the shorts-redesign-concept comparison
// artifact -- same visual language (verified badge, huge glow-shadowed percentage, translucent
// bordered chart panel, cyan entry marker, gradient CTA folded into the card itself), but with the
// bot's REAL chart (candlePaths/chartPaths/chartFrame -- the same functions the static image and
// dual-card layout use) in place of the artifact's fixed illustrative bars. Purpose-built and kept
// entirely separate from cardSvg (used by the dual-card dev-only format) rather than adding more
// conditional branches to that function -- this is now the one and only renderer for the real
// single-card /shorts highlight (see highlightSvg).
function heroCardSvg({
  x, y, w, h, ticker, pctChange, openPrice, nowPrice, closes, ohlc,
  entryIndex, entryPriceRaw, entryLabel = "Called at", isVerified, reveal, metaLine
}) {
  const pad = 76; // roomier than the artifact's literal 22px inset scaled -- more breathing room now that the card fills the whole frame

  const showTopbar = reveal?.showTopbar ?? true;
  const showBadge = (reveal?.showTag ?? true) && isVerified;
  const showTicker = reveal?.showTicker ?? true;
  const showPct = reveal?.showPct ?? true;
  const pctFraction = reveal?.pctFraction ?? 1;
  const showPriceLine = reveal?.showPriceLine ?? true;
  const showChart = reveal?.showChart ?? true;
  const chartRevealCount = reveal?.chartRevealCount;
  // Pop-in scale for each piece as it first appears (see popGroup) -- 1 (settled) unless a reveal
  // frame is mid-pop for that specific piece.
  const topbarScale = reveal?.topbarScale ?? 1;
  const badgeTickerScale = reveal?.badgeTickerScale ?? 1;
  const priceScale = reveal?.priceScale ?? 1;
  const ctaScale = reveal?.ctaScale ?? 1;
  // Its own pop-in scale, separate from ctaScale -- the entry marker is meant to land as its own
  // distinct beat once the chart has fully drawn in, not tag along with the CTA button's pop.
  const entryScale = reveal?.entryScale ?? 1;
  // Matches the artifact's own ".live-dot { animation: pulse 1.8s ease-in-out infinite }" -- 1
  // (fully lit) on the static image, driven by buildRevealFrames' running clock in the video.
  const liveDotOpacity = reveal?.liveDotOpacity ?? 1;
  const showMarker = isVerified && (reveal?.showEntryMarker ?? true);
  const showCTA = reveal?.showCTA ?? true;

  // Panel occupies most of the card -- real room for the real chart, exactly the "glass panel"
  // role the artifact's .panel plays around its (fixed, illustrative) bars.
  const panelX = x + pad, panelW = w - pad * 2;
  const panelY = y + 800, panelBottom = y + h - 380;
  const panelPad = 47; // artifact's .panel padding (18px, scaled)
  const chartX = panelX + panelPad, chartW = panelW - panelPad * 2;
  const chartY = panelY + panelPad + 55; // extra top offset clears chartFrame's own (enlarged) RANGE label
  const chartH = panelBottom - panelPad - chartY;

  const pctText = `${pctChange >= 0 ? "+" : ""}${(pctChange * pctFraction).toFixed(1)}%`;
  // "WIF/USD" -> "WIF / USD" -- display-only spacing to match the artifact's ticker exactly; the
  // real symbol string (used for lookups/logging elsewhere) never gains the spaces.
  const tickerDisplay = ticker.replace(/\//g, " / ");
  // Two glow strengths, matching the artifact's own split: everything EXCEPT the percentage uses a
  // single moderate blur (its various box-shadow blurs all cluster around 8-14px at the artifact's
  // own 337px scale); the percentage alone gets a much bigger two-layer glow (text-shadow: 0 0 30px,
  // 0 0 70px) because the artifact deliberately makes it the one dramatic element on the card.
  // Both are scaled by the same ~2.97x this whole card is scaled by (1000px card / 337px artifact).
  const glowId = `heroGlow_${x}_${y}`;
  const dotGlowId = `heroDotGlow_${x}_${y}`;
  const pctGlowId = `heroPctGlow_${x}_${y}`;
  const ctaGlowId = `heroCtaGlow_${x}_${y}`;
  const haloId = `heroHalo_${x}_${y}`;
  const ctaId = `heroCta_${x}_${y}`;
  const bgId = `heroBg_${x}_${y}`;

  // Chart itself gets the same soft glow as the artifact's up-bars (box-shadow: 0 0 10px) --
  // wrapped around the whole candle/line group rather than only the up-colored pieces individually
  // (candlePaths/chartPaths return one already-concatenated markup string per call, shared with the
  // dual-card format, so splitting by color here isn't worth the risk to that shared code).
  const useCandles = Array.isArray(ohlc) && ohlc.length >= 2;
  const frame = !showChart ? null : (useCandles
    ? (() => {
        const c = candlePaths(ohlc, chartX, chartY, chartW, chartH, entryIndex, entryPriceRaw, chartRevealCount, GLOW_GREEN_LIGHT, HERO_CHART_DOWN);
        return { ...c, draw: chartFrame(chartX, chartY, chartW, chartH, c.min, c.max, 30) + `<g filter="url(#${glowId})">${c.candles}</g>` + (showMarker ? popGroup(c.entryX, c.entryY, entryScale, entryMarkerCyanSvg(c.entryX, c.entryY, chartY + chartH, glowId)) : "") };
      })()
    : (() => { const c = chartPaths(closes, chartX, chartY, chartW, chartH, chartRevealCount); return {
        ...c,
        draw: chartFrame(chartX, chartY, chartW, chartH, c.min, c.max, 30) +
          `<path d="${c.area}" fill="${GLOW_GREEN}" fill-opacity="0.16"/>` +
          `<path d="${c.line}" fill="none" stroke="${GLOW_GREEN_LIGHT}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" filter="url(#${glowId})"/>` +
          (showMarker ? popGroup(c.entryX, c.entryY, entryScale, entryMarkerCyanSvg(c.entryX, c.entryY, chartY + chartH, glowId)) : "") +
          (c.fullyRevealed ? `<circle cx="${c.lastX.toFixed(1)}" cy="${c.lastY.toFixed(1)}" r="9" fill="${GLOW_GREEN_LIGHT}"/>` : "")
      }; })());

  // Real provenance text (fired-date/source, legal disclaimer) -- not part of the artifact's own
  // card at all, but folded inside this card's bottom rather than living outside its border, so
  // the card's own edge can run all the way to the canvas edge with nothing floating below it.
  // Order top-to-bottom: metaLine (real, factual provenance -- gets its own line right under the
  // button) then the single disclaimer line beneath it. (A third "past movement" legal line used
  // to run below this -- dropped per feedback, keeping just the one disclaimer.)
  const disclaimerY = y + h - 40;
  // ctaH matches the artifact's own button height (14px padding top/bottom + ~16px line-height,
  // scaled) -- the first port used a much shorter, guessed height.
  const ctaH = 130;
  const metaLineY = disclaimerY - 40;
  const ctaY = metaLineY - 40 - ctaH;
  const topbarIconSize = 65, topbarIconY = y + 68;
  const liveDotCx = x + w - pad - 10, liveDotCy = topbarIconY + 32;

  // The card's background gradients (greenTint/cyanTint below) show visible banding -- distinct
  // diagonal facets instead of a smooth falloff -- on a large, dark, gradual radial fill. Tried
  // fixing it with feTurbulence-based dither twice (full card size: ~1.7s/frame, 97MB of PNGs
  // across a 97-frame video; tiled via <pattern>: cheap to compute, but random noise still defeats
  // PNG compression enough to land at a similar ~83MB) -- both real OOM risk on a pipeline that's
  // been killed by exactly that failure mode before, so neither shipped. Tried lowering opacity
  // instead, which killed the actual visible glow the gradient exists for in the first place --
  // also rejected. This version dithers with a fixed 4x4 Bayer matrix instead of randomness: every
  // tile is byte-identical in the SVG source, so it costs meaningfully less than random noise once
  // composited (though not free, since the same tile still lands on different gradient values at
  // each repetition). Cell size kept small (2px) and opacity low so it reads as fine grain rather
  // than a visible grid of squares at normal viewing size.
  //
  // Doesn't cover the topbar/live-dot row (see the clipPath below): the glow filter's own
  // rectangular bounding region -- extra canvas padding needed for its blur, sized relative to
  // that small circle/icon -- was showing up as a visible box seam once it had the dither texture
  // to contrast against. The dither's actual job (masking banding in the big open gradient areas)
  // doesn't need that strip anyway.
  const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const ditherCell = 2, ditherTile = ditherCell * 4;
  const ditherRects = BAYER_4X4.map((v, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const opacity = ((v / 16) * 0.022).toFixed(3);
    return `<rect x="${col * ditherCell}" y="${row * ditherCell}" width="${ditherCell}" height="${ditherCell}" fill="${GLOW_GREEN}" opacity="${opacity}"/>`;
  }).join("");

  return `
    <defs>
      <filter id="${glowId}" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="18" result="rawBlur"/>
        <feColorMatrix in="rawBlur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.55 0" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <!-- Live-dot only: the shared glowId's stdDeviation=18 blur, scaled against something as
           small as a 21px circle, spread far enough relative to the shape's own size that its
           falloff read as a soft square rather than a circular halo. Same recipe, lighter blur. -->
      <filter id="${dotGlowId}" x="-150%" y="-150%" width="400%" height="400%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="rawBlur"/>
        <feColorMatrix in="rawBlur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.55 0" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="${pctGlowId}" x="-60%" y="-100%" width="220%" height="300%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="55" result="wideBlur"/>
        <feColorMatrix in="wideBlur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.22 0" result="wide"/>
        <feGaussianBlur in="SourceGraphic" stdDeviation="24" result="tightBlur"/>
        <feColorMatrix in="tightBlur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.5 0" result="tight"/>
        <feMerge><feMergeNode in="wide"/><feMergeNode in="tight"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="${ctaGlowId}" x="-30%" y="-60%" width="160%" height="260%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="18" result="blur"/>
        <feOffset in="blur" dx="0" dy="20" result="offsetBlur"/>
        <feFlood flood-color="${COLORS.cta}" flood-opacity="0.5" result="color"/>
        <feComposite in="color" in2="offsetBlur" operator="in" result="shadow"/>
        <feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <radialGradient id="${haloId}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${GLOW_GREEN}" stop-opacity="0.25"/>
        <stop offset="20%" stop-color="${GLOW_GREEN}" stop-opacity="0.19"/>
        <stop offset="40%" stop-color="${GLOW_GREEN}" stop-opacity="0.13"/>
        <stop offset="60%" stop-color="${GLOW_GREEN}" stop-opacity="0.08"/>
        <stop offset="80%" stop-color="${GLOW_GREEN}" stop-opacity="0.035"/>
        <stop offset="100%" stop-color="${GLOW_GREEN}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="${ctaId}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#6c78ff"/>
        <stop offset="100%" stop-color="${COLORS.cta}"/>
      </linearGradient>
      <radialGradient id="${bgId}greenTint" cx="25%" cy="8%" r="85%">
        <stop offset="0%" stop-color="${GLOW_GREEN}" stop-opacity="0.26"/>
        <stop offset="20%" stop-color="${GLOW_GREEN}" stop-opacity="0.2"/>
        <stop offset="40%" stop-color="${GLOW_GREEN}" stop-opacity="0.14"/>
        <stop offset="60%" stop-color="${GLOW_GREEN}" stop-opacity="0.085"/>
        <stop offset="80%" stop-color="${GLOW_GREEN}" stop-opacity="0.038"/>
        <stop offset="100%" stop-color="${GLOW_GREEN}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="${bgId}cyanTint" cx="85%" cy="95%" r="45%">
        <stop offset="0%" stop-color="${TRUST_CYAN}" stop-opacity="0.10"/>
        <stop offset="20%" stop-color="${TRUST_CYAN}" stop-opacity="0.075"/>
        <stop offset="40%" stop-color="${TRUST_CYAN}" stop-opacity="0.053"/>
        <stop offset="60%" stop-color="${TRUST_CYAN}" stop-opacity="0.032"/>
        <stop offset="80%" stop-color="${TRUST_CYAN}" stop-opacity="0.014"/>
        <stop offset="100%" stop-color="${TRUST_CYAN}" stop-opacity="0"/>
      </radialGradient>
      <pattern id="${bgId}dither" width="${ditherTile}" height="${ditherTile}" patternUnits="userSpaceOnUse">${ditherRects}</pattern>
      <clipPath id="${bgId}clip"><rect x="${x}" y="${topbarIconY + topbarIconSize + 25}" width="${w}" height="${h - (topbarIconY + topbarIconSize + 25 - y)}" rx="65"/></clipPath>
    </defs>

    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="65" fill="none" stroke="${GLOW_GREEN}" stroke-opacity="0.3" stroke-width="7" filter="url(#${glowId})"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="65" fill="#070b0a"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="65" fill="url(#${bgId}greenTint)"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="65" fill="url(#${bgId}cyanTint)"/>
    <g clip-path="url(#${bgId}clip)"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${bgId}dither)"/></g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="65" fill="none" stroke="#1c2b25" stroke-width="1.5"/>

    ${showTopbar ? popGroup(x + w / 2, topbarIconY + 32, topbarScale, `
    <clipPath id="topbarLogoClip_${x}_${y}"><rect x="${x + pad}" y="${topbarIconY}" width="${topbarIconSize}" height="${topbarIconSize}" rx="18"/></clipPath>
    <rect x="${x + pad}" y="${topbarIconY}" width="${topbarIconSize}" height="${topbarIconSize}" rx="18" fill="${GLOW_GREEN}" filter="url(#${glowId})"/>
    <image href="${logoSrc()}" x="${x + pad}" y="${topbarIconY}" width="${topbarIconSize}" height="${topbarIconSize}" clip-path="url(#topbarLogoClip_${x}_${y})"/>
    <text x="${x + pad + topbarIconSize + 20}" y="${topbarIconY + 42}" font-family="DejaVu Sans" font-size="33" font-weight="800" letter-spacing="6" fill="#93a89e">STP · SIGNAL DECK</text>
    <circle cx="${liveDotCx}" cy="${liveDotCy}" r="10.5" fill="${GLOW_GREEN_LIGHT}" opacity="${liveDotOpacity.toFixed(2)}" filter="url(#${dotGlowId})"/>
    `) : ""}

    ${showBadge ? popGroup(x + pad + 220, y + 240, badgeTickerScale, `
    <rect x="${x + pad}" y="${y + 205}" width="440" height="70" rx="35" fill="rgba(79,195,247,0.12)" stroke="${TRUST_CYAN}" stroke-opacity="0.4" stroke-width="1.5"/>
    <text x="${x + pad + 28}" y="${y + 250}" font-family="DejaVu Sans" font-size="28" font-weight="800" letter-spacing="1.5" fill="${TRUST_CYAN}">✓ VERIFIED REAL CALL</text>
    `) : ""}

    ${showTicker ? popGroup(x + pad + 100, y + 340, badgeTickerScale, `<text x="${x + pad}" y="${y + 368}" font-family="DejaVu Sans" font-size="64" font-weight="700" letter-spacing="-1" fill="#93a89e">${escapeXml(tickerDisplay)}</text>`) : ""}

    ${showPct ? `
    <ellipse cx="${x + pad + 300}" cy="${(y + 495).toFixed(1)}" rx="400" ry="200" fill="url(#${haloId})"/>
    <text x="${x + pad}" y="${y + 555}" font-family="DejaVu Sans" font-size="172" font-weight="900" letter-spacing="-6" fill="${GLOW_GREEN_LIGHT}" filter="url(#${pctGlowId})">${pctText}</text>
    ` : ""}

    ${showPriceLine ? popGroup(x + pad + 150, y + 640, priceScale, `<text x="${x + pad}" y="${y + 655}" xml:space="preserve" font-family="DejaVu Sans" font-size="39" font-weight="700" fill="#93a89e">${escapeXml(entryLabel)} <tspan fill="#f2f7f4">${escapeXml(openPrice)}</tspan><tspan fill="${GLOW_GREEN}"> → </tspan>Now <tspan fill="#f2f7f4">${escapeXml(nowPrice)}</tspan></text>`) : ""}

    ${showChart ? `<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelBottom - panelY}" rx="47" fill="rgba(255,255,255,0.025)" stroke="${GLOW_GREEN}" stroke-opacity="0.18" stroke-width="2"/>` : ""}
    ${frame ? frame.draw : ""}

    ${showCTA ? popGroup(x + w / 2, ctaY + ctaH / 2, ctaScale, `
    <rect x="${x + pad}" y="${ctaY}" width="${w - pad * 2}" height="${ctaH}" rx="65" fill="url(#${ctaId})" filter="url(#${ctaGlowId})"/>
    <text x="${x + w / 2}" y="${ctaY + 80}" font-family="DejaVu Sans" font-size="42" font-weight="800" fill="#ffffff" text-anchor="middle">Join the Discord →</text>
    ${metaLine ? `<text x="${x + w / 2}" y="${metaLineY}" font-family="DejaVu Sans" font-size="22" font-weight="700" fill="#93a89e" text-anchor="middle">${escapeXml(metaLine)}</text>` : ""}
    <text x="${x + w / 2}" y="${disclaimerY}" font-family="DejaVu Sans" font-size="28" font-weight="700" fill="#56685e" text-anchor="middle">Technical pattern data, not financial advice.</text>
    `) : ""}
  `;
}

// Renders the same content as generateShortHtml(), but as a flat 1080x1920 PNG (standard
// Shorts/Reels resolution) instead of an interactive page -- for posting directly into Discord
// as an image rather than a file you have to download and open. No count-up/draw-in animation
// (nothing to animate in a still image); every value is shown at its final resting state.
async function generateShortImage(winner, loser) {
  if (!winner?.intraday?.closes?.length || !loser?.intraday?.closes?.length) {
    throw new Error("winner/loser is missing intraday data -- run findMover() first");
  }

  const W = 1080, H = 1920;
  const logoSrc = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`;
  // Each card must use its OWN ticker's timeframe -- winner and loser are different tickers
  // that can have very different actual data spans (a thinly-traded one can span days, not
  // hours). Using one ticker's label on the other card's chart was a real bug: it would show
  // the wrong date range entirely whenever the two tickers' data didn't happen to match.
  const winnerSessionLabel = formatSessionLabel(winner.intraday.times);
  const loserSessionLabel = formatSessionLabel(loser.intraday.times);
  const metaLine = formatMetaLine(winner.intraday.times);

  const cardX = 70, cardW = W - 140, cardH = 560, cardGap = 30;
  const winnerY = 380;
  const loserY = winnerY + cardH + cardGap;

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${COLORS.surface}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="36" fill="none" stroke="${COLORS.winner}" stroke-width="6" stroke-opacity="0.55"/>

  <clipPath id="logoClip"><rect x="70" y="80" width="64" height="64" rx="16"/></clipPath>
  <image href="${logoSrc}" x="70" y="80" width="64" height="64" clip-path="url(#logoClip)"/>
  <text x="150" y="122" font-family="DejaVu Sans" font-size="29" font-weight="700" letter-spacing="2" fill="${COLORS.textSecondary}">STP · TODAY'S MOVERS</text>

  <text x="70" y="212" font-family="DejaVu Sans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">Today's biggest</text>
  <text x="70" y="280" font-family="DejaVu Sans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">winner &amp; loser.</text>

  <circle cx="80" cy="325" r="9" fill="${COLORS.cta}"/>
  <text x="100" y="334" font-family="DejaVu Sans" font-size="29" font-weight="600" fill="${COLORS.textSecondary}">Live off today's session</text>

  ${cardSvg({
    x: cardX, y: winnerY, w: cardW, h: cardH, accent: COLORS.winner, accentFill: COLORS.winnerFill,
    tagLabel: "Winner", ticker: winner.symbol, pctChange: winner.pctChange,
    openPrice: formatMoney(winner.intraday.closes[0]), nowPrice: formatMoney(winner.price),
    closes: winner.intraday.closes, timeframe: winnerSessionLabel, volumeSurgeRatio: winner.volumeSurgeRatio
  })}

  ${cardSvg({
    x: cardX, y: loserY, w: cardW, h: cardH, accent: COLORS.loser, accentFill: COLORS.loserFill,
    tagLabel: "Loser", ticker: loser.symbol, pctChange: loser.pctChange,
    openPrice: formatMoney(loser.intraday.closes[0]), nowPrice: formatMoney(loser.price),
    closes: loser.intraday.closes, timeframe: loserSessionLabel, volumeSurgeRatio: loser.volumeSurgeRatio
  })}

  <rect x="${W / 2 - 230}" y="1560" width="460" height="90" rx="45" fill="${COLORS.cta}"/>
  <text x="${W / 2}" y="1616" font-family="DejaVu Sans" font-size="35" font-weight="800" fill="#ffffff" text-anchor="middle">Join the Discord →</text>

  <text x="${W / 2}" y="1710" font-family="DejaVu Sans" font-size="25" font-weight="700" fill="${COLORS.textSecondary}" text-anchor="middle">${escapeXml(metaLine)}</text>
  <text x="${W / 2}" y="1755" font-family="DejaVu Sans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Technical pattern data, not financial advice.</text>
  <text x="${W / 2}" y="1785" font-family="DejaVu Sans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Past movement isn't a guarantee of future performance.</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Single-card version of the same 1080x1920 layout, used for the "best real call" content (see
// src/lib/bestCall.js) and its live-market fallback -- one bigger card instead of a winner/loser
// pair, since there's no loser side in this format at all: a losing call is never featured, and
// a live-market fallback only ever shows the day's winner, never its loser. `highlight` needs
// `.ticker/.pctChange/.openPrice/.nowPrice/.closes` (a real trajectory if one exists, or an
// honest 2-point entry->now line if it doesn't -- see bestCall.js), plus `.badgeText`,
// `.entryLabel`, `.timeframeLabel`, `.headlineLines` (exactly 2 strings), `.captionText`, and
// `.metaLine`. `.volumeSurgeRatio` is optional. `.ohlc` (real daily open/high/low/close, only
// ever populated for /alerts and /discover picks) renders as actual candlesticks when present;
// null/absent falls back to the `.closes` line chart -- /degen and /breakout never have real
// candle history to draw more than a 2-point line from, and this never fabricates one.
//
// The CTA button sits at y=1470, not lower: once this image is actually posted as a YouTube
// Short, YouTube's own UI (Subscribe button, channel name, caption) overlays roughly the bottom
// ~20% of the screen -- a CTA any lower gets hidden behind that chrome. 1470 clears it with real
// margin both to the card above (which ends at 1440) and to YouTube's overlay below.
//
// Resized once and cached, not the raw source file -- assets/logo.png is a 1.4MB, high-resolution
// original, but it only ever displays at 56-64px in these cards. Embedding the raw file's ~1.9MB
// base64 text directly was harmless for a single static image, but buildRevealFrames now builds
// an array holding EVERY animation frame's full SVG text at once (see there), and this logo gets
// embedded twice per frame (left logo + the rotating corner one) -- confirmed via a real Railway
// OOM kill that ~100 frames x 2 embeds x 1.9MB was pushing memory well past 400MB just for logo
// text. 128px is generous headroom over the largest actual display size (64px) for a crisp image
// while cutting that per-frame cost by roughly 40x (a few KB instead of ~1.9MB).
//
// Split into an async populate step and a sync getter rather than making logoSrc() itself async,
// because it's called deep inside highlightSvg/buildRevealFrames's per-frame loop -- threading
// async through that whole call chain would be a much larger, riskier change than just making
// every caller `await ensureLogoSrcCached()` once, up front, before touching anything synchronous.
let logoSrcCache = null;
async function ensureLogoSrcCached() {
  if (!logoSrcCache) {
    const resized = await sharp(LOGO_PATH).resize(128, 128).png().toBuffer();
    logoSrcCache = `data:image/png;base64,${resized.toString("base64")}`;
  }
  return logoSrcCache;
}
function logoSrc() {
  if (!logoSrcCache) throw new Error("logoSrc() called before ensureLogoSrcCached() resolved");
  return logoSrcCache;
}

// Builds the SVG markup only (no rasterizing) -- split out from generateHighlightImage so the
// reveal-video pipeline (buildRevealFrames) can render dozens of partial-content frames cheaply
// without redoing the sharp/PNG round trip every time it just wants the markup. `reveal`, when
// provided, hides/partially-shows pieces for one frame of the animated build-up; omitted (the
// normal /shorts image path) it's undefined throughout and every element renders in full --
// behaviorally identical to before this function existed.
function highlightSvg(highlight, reveal) {
  const W = 1080, H = 1920;
  // The card IS the image now -- matching the Option A -- Glow artifact exactly, where the
  // topbar/badge/hero/panel/CTA all live inside one self-contained card rather than being split
  // across an outer logo/headline area (above) and a separate card (below). The card's own edge
  // now runs almost to the canvas edge on all four sides -- the real provenance text (fired-date/
  // source, legal disclaimer) that the artifact's own mockup never had to show lives INSIDE the
  // card too, below the CTA, rather than floating in a strip outside its border.
  const cardX = 24, cardW = W - 48, cardH = H - 48;
  const cardY = 24;
  const showCard = reveal?.showCard ?? true;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${COLORS.surface}"/>

  ${showCard ? heroCardSvg({
    x: cardX, y: cardY, w: cardW, h: cardH,
    ticker: highlight.ticker, pctChange: highlight.pctChange,
    openPrice: formatMoney(highlight.openPrice), nowPrice: formatMoney(highlight.nowPrice),
    closes: highlight.closes, ohlc: highlight.ohlc,
    entryLabel: highlight.entryLabel, entryIndex: highlight.entryIndex, entryPriceRaw: highlight.openPrice,
    // Real Call cards mark a genuine logged alert (real price, real timestamp -- see bestCall.js).
    // Live Mover cards have no alert behind them at all: closes[0] is just the start of today's
    // displayed window, not anything the bot ever called. Showing the verified badge/entry ring
    // there would visually claim a signal that never happened, so it's Real-Call-only.
    isVerified: highlight.badgeText === "Real Call",
    metaLine: highlight.metaLine,
    reveal
  }) : ""}
</svg>`;
}

async function generateHighlightImage(highlight) {
  if (!highlight?.closes?.length) {
    throw new Error("highlight is missing closes -- needs at least a 2-point [entry, now] line");
  }
  await ensureLogoSrcCached();
  return sharp(Buffer.from(highlightSvg(highlight))).png().toBuffer();
}

// Total video length -- matches shortsVideo.js's old static-hold default, so the reveal video
// replacing it isn't a surprising length change on its own.
const REVEAL_VIDEO_MS = 15000;
const CHART_REVEAL_MS = 1400;
const MAX_CHART_STEPS = 24; // caps frame count (and render/encode time) regardless of candle count

// Yields { svg, holdMs } frames one at a time (a generator, not an array) that together tell the
// same story as the static /shorts image, just revealed in beats instead of shown all at once:
// card frame -> topbar -> badge/ticker -> percentage counting up -> price line -> chart building
// in candle-by-candle (or point-by-point for the 2-point line format) -> entry marker (Real Call
// only) -> CTA. Every frame is built from the exact same highlightSvg/heroCardSvg/candlePaths/
// chartPaths functions that render the real static PNG -- this never approximates the chart in a
// different format the way an early concept mockup did; it's the same real chart, just revealed
// progressively.
//
// Deliberately a generator instead of building and returning a full array: a real Railway OOM
// kill happened once in an earlier version of this pipeline once frame count grew too high --
// materializing every frame's SVG text in memory at once, however small each one now is
// individually, is still a real cost multiplied across 100+ frames on top of whatever else is
// running in the same container. A generator means only ONE frame's SVG text exists in memory at
// any moment; the caller (generateRevealFramePngs) rasterizes and discards each one before the
// next is even built. (There used to also be a per-beat rotation-subdivision step here, for a
// spinning corner-logo watermark -- removed along with that watermark when the card became the
// whole image, so each beat below is now exactly one frame instead of several identical ones.)
function* buildRevealFrames(highlight) {
  if (!highlight?.closes?.length) {
    throw new Error("highlight is missing closes -- needs at least a 2-point [entry, now] line");
  }
  const useCandles = Array.isArray(highlight.ohlc) && highlight.ohlc.length >= 2;
  const itemCount = useCandles ? highlight.ohlc.length : highlight.closes.length;
  const showEntryMarker = highlight.badgeText === "Real Call";

  // Live-dot pulse: a running clock (like the old corner-logo rotation clock, but far cheaper --
  // this only ever varies one opacity number, never adds frames) sampled at each existing
  // pushFrames call, matching the artifact's own ".live-dot { animation: pulse 1.8s ease-in-out
  // infinite }". Reuses whatever frame cadence a beat already has (dozens of frames during the
  // chart-build phase, a handful elsewhere) rather than subdividing beats further to chase a
  // perfectly smooth curve -- the OOM history in this file is exactly why frame count stays fixed.
  const PULSE_PERIOD_MS = 1800;
  // Cap on how long any single held frame is allowed to freeze the dot's opacity for -- pushPop's
  // trailing "settled" hold used to pass its whole remaining duration (up to ~8.5s, for the final
  // CTA beat) as ONE frame, sampling the sine once and then holding that exact value for the rest
  // of the video, which read as "the pulse stops partway through." Chunking any hold longer than
  // this into multiple frames keeps the sine actually advancing for as long as the dot is visible.
  const PULSE_SAMPLE_MS = 600;
  let clockMs = 0;
  // The clock still ticks during the intro (bare/cardAppears), before the topbar -- and the dot
  // inside it -- ever becomes visible, so without this the dot's first visible frame lands at
  // whatever phase the clock happened to accumulate to, which read as "starts weird." Resetting
  // the clock the moment the dot actually appears makes its first frame a clean, deterministic
  // start every time, regardless of how long the intro beats before it happened to run.
  let pulseStarted = false;
  function* pushFrames(holdMs, reveal) {
    const dotVisible = reveal?.showTopbar !== false;
    if (dotVisible && !pulseStarted) {
      pulseStarted = true;
      clockMs = 0;
    }
    const chunkMs = dotVisible ? PULSE_SAMPLE_MS : holdMs;
    let remaining = holdMs;
    while (remaining > 0) {
      const chunk = Math.min(remaining, chunkMs);
      const liveDotOpacity = dotVisible
        ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((clockMs / PULSE_PERIOD_MS) * 2 * Math.PI))
        : 1;
      clockMs += chunk;
      yield { svg: highlightSvg(highlight, { ...reveal, liveDotOpacity }), holdMs: chunk };
      remaining -= chunk;
    }
  }

  // Small -> overshoot -> settle -- each piece of the card (topbar, badge/ticker, price line, CTA)
  // actually animates into place instead of snapping from invisible to fully shown in one frame
  // cut. scaleKey names which of heroCardSvg's own *Scale reveal fields this beat is animating.
  // Sampled from a real easing curve (easeOutBack) rather than 3 hand-picked keyframes -- the
  // first version had a visible "step" feel from only 3 sub-frames; this samples the same
  // shrink-overshoot-settle shape at enough points to read as continuous motion once encoded.
  const POP_STEPS = 9;
  const POP_STEP_MS = 40;
  const POP_START_SCALE = 0.7;
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  function* pushPop(totalMs, reveal, scaleKey) {
    for (let i = 1; i <= POP_STEPS; i++) {
      const t = i / POP_STEPS;
      const scale = POP_START_SCALE + (1 - POP_START_SCALE) * easeOutBack(t);
      yield* pushFrames(POP_STEP_MS, { ...reveal, [scaleKey]: scale });
    }
    const settledMs = totalMs - POP_STEP_MS * POP_STEPS;
    if (settledMs > 0) yield* pushFrames(settledMs, { ...reveal, [scaleKey]: 1.0 });
  }

  const bare = { showCard: false };
  const cardAppears = { showCard: true, showTopbar: false, showTag: false, showTicker: false, showPct: false, showPriceLine: false, showChart: false, showEntryMarker: false, showCTA: false };
  const withTopbar = { ...cardAppears, showTopbar: true };
  const withTickerCard = { ...withTopbar, showTag: true, showTicker: true };

  yield* pushFrames(300, bare);
  yield* pushFrames(600, cardAppears);
  yield* pushPop(700, withTopbar, "topbarScale");
  yield* pushPop(550, withTickerCard, "badgeTickerScale");

  // Percentage counts up over 6 steps rather than jumping straight to the final value -- a count-
  // up reads as "this is being calculated," which is a better fit for a real-data card than an
  // instant number would be.
  const PCT_STEPS = 6;
  for (let s = 1; s <= PCT_STEPS; s++) {
    yield* pushFrames(1200 / PCT_STEPS, { ...withTickerCard, showPct: true, pctFraction: s / PCT_STEPS });
  }

  const withPriceLine = { ...withTickerCard, showPct: true, pctFraction: 1, showPriceLine: true };
  yield* pushPop(550, withPriceLine, "priceScale");

  // Each candle (or line point) gets its own mini entrance instead of popping in fully formed:
  // chartRevealCount is fractional across CHART_GROWTH_SUBSTEPS sub-frames per step, and
  // candlePaths/chartPaths both interpret a fractional count as "the newest one is still growing
  // in." Grouped into chartSteps outer steps (capped regardless of real candle count) so a long
  // OHLC history still costs a bounded number of frames.
  const chartSteps = Math.min(itemCount, MAX_CHART_STEPS);
  const CHART_GROWTH_SUBSTEPS = 3;
  let revealedSoFar = 0;
  for (let s = 1; s <= chartSteps; s++) {
    const target = Math.ceil((s / chartSteps) * itemCount);
    for (let g = 1; g <= CHART_GROWTH_SUBSTEPS; g++) {
      const revealCount = revealedSoFar + (target - revealedSoFar) * (g / CHART_GROWTH_SUBSTEPS);
      yield* pushFrames(CHART_REVEAL_MS / chartSteps / CHART_GROWTH_SUBSTEPS, {
        ...withPriceLine, showChart: true, chartRevealCount: revealCount, showEntryMarker: false
      });
    }
    revealedSoFar = target;
  }

  const withChart = { ...withPriceLine, showChart: true, showCTA: false };
  const elapsedBeforeFinal = 300 + 600 + 700 + 550 + 1200 + 550 + CHART_REVEAL_MS;
  if (showEntryMarker) {
    // The chart has fully drawn by this point (chart-growth loop above always runs to completion
    // first) -- hold one beat on the bare finished chart, then pop the cyan BUY marker in on its
    // own as a distinct final reveal, and only then bring in the CTA. Mirrors the same
    // "hold -> popGroup" treatment topbar/badge/price already get.
    const ENTRY_HOLD_MS = 350;
    const ENTRY_POP_MS = 500;
    yield* pushFrames(ENTRY_HOLD_MS, { ...withChart, showEntryMarker: false });
    yield* pushPop(ENTRY_POP_MS, { ...withChart, showEntryMarker: true }, "entryScale");
    yield* pushPop(REVEAL_VIDEO_MS - elapsedBeforeFinal - ENTRY_HOLD_MS - ENTRY_POP_MS, { ...withChart, showEntryMarker: true, showCTA: true }, "ctaScale");
  } else {
    yield* pushPop(REVEAL_VIDEO_MS - elapsedBeforeFinal, { ...withChart, showCTA: true }, "ctaScale");
  }
}

// Rasterizes buildRevealFrames' output to real PNG buffers via the same sharp/SVG pipeline the
// static image uses -- never a different renderer, so every frame is pixel-faithful to what
// generateHighlightImage would produce at that same reveal state.
async function generateRevealFramePngs(highlight) {
  await ensureLogoSrcCached();
  const frames = buildRevealFrames(highlight);
  const rendered = [];
  for (const frame of frames) {
    const png = await sharp(Buffer.from(frame.svg)).png().toBuffer();
    rendered.push({ png, holdMs: frame.holdMs });
  }
  return rendered;
}

// Turns a bestCall.js result into the shape generateHighlightImage needs. Framed as "this
// actually happened" -- a verified result since the call fired, not a live snapshot.
function buildCallHighlight(call) {
  const ageMs = Date.now() - call.firedAt;
  const ageLabel = ageMs >= 86400000
    ? `${Math.floor(ageMs / 86400000)}d ago`
    : `${Math.max(1, Math.floor(ageMs / 3600000))}h ago`;
  const firedDate = new Date(call.firedAt);
  return {
    badgeText: "Real Call",
    headlineLines: ["This actually", "happened."],
    captionText: "A verified result, not a live snapshot",
    ticker: call.symbol,
    pctChange: call.pctChange,
    openPrice: call.entryPrice,
    nowPrice: call.currentPrice,
    closes: call.closes,
    ohlc: call.ohlc || null,
    entryIndex: call.entryIndex ?? 0,
    entryLabel: "Called at",
    timeframeLabel: `Called via /${call.source.toLowerCase()} · ${ageLabel}`,
    volumeSurgeRatio: null,
    metaLine: `Fired ${firedDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · Source: ${call.source}`
  };
}

// Turns a findMover() winner into the same shape -- the fallback path when there's no eligible
// past call yet, winner-only (no loser side exists in this format at all).
function buildFallbackHighlight(winner) {
  return {
    badgeText: "Live Mover",
    headlineLines: ["Today's biggest", "mover."],
    captionText: "Live off today's session",
    ticker: winner.symbol,
    pctChange: winner.pctChange,
    openPrice: winner.intraday.closes[0],
    nowPrice: winner.price,
    closes: winner.intraday.closes,
    ohlc: null, // findMover only fetches close-only intraday bars, never full OHLC
    entryLabel: "Open",
    timeframeLabel: formatSessionLabel(winner.intraday.times),
    volumeSurgeRatio: winner.volumeSurgeRatio,
    metaLine: formatMetaLine(winner.intraday.times)
  };
}

// Title/description text ready to paste straight into YouTube Studio's upload form -- built from
// the exact same highlight object the image/video came from, so it can never disagree with what's
// actually on screen. DISCORD_INVITE_URL can be overridden via env var (e.g. if the invite ever
// needs to rotate) but defaults to the server's real, currently-active invite.
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || "https://discord.gg/rD3VH8XNj";

function buildYoutubeCaption(highlight) {
  const sign = highlight.pctChange >= 0 ? "+" : "";
  const pctText = `${sign}${highlight.pctChange.toFixed(1)}%`;
  const tickerLower = highlight.ticker.toLowerCase().replace(/[^a-z0-9]/g, "");

  // No hashtag in the title -- current YouTube Shorts SEO guidance is to keep the title clean and
  // keyword-focused and put hashtags in the description instead, where the first three also
  // surface as clickable links above the title anyway. #crypto/#ticker/#cryptotrading lead (the
  // actual discovery-driving tags) with #Shorts last -- it only needs to appear somewhere in the
  // description to satisfy Shorts categorization, so the more valuable tags get the "first three"
  // clickable-link treatment instead.
  const title = `${highlight.ticker} ${pctText} — ${highlight.badgeText}`.slice(0, 100);

  const description = [
    `${highlight.ticker}: ${highlight.entryLabel} ${formatMoney(highlight.openPrice)} → Now ${formatMoney(highlight.nowPrice)} (${pctText}).`,
    "",
    highlight.timeframeLabel,
    "",
    `Real scans, real signals -- not financial advice. Join the Discord: ${DISCORD_INVITE_URL}`,
    "",
    `#crypto #${tickerLower} #cryptotrading #Shorts`
  ].join("\n");

  return { title, description };
}

// A standalone "join the Discord" ad -- NOT a highlight card, no market data at all, so this is
// deliberately its own layout/reveal pipeline rather than reusing highlightSvg/cardSvg. One-off
// asset generation (see scripts/generate-discord-ad.js), not something the bot posts on its own.
//
// No emoji anywhere: this render pipeline only has DejaVu Sans/Mono actually installed (see the
// font troubleshooting note at the top of this file) -- emoji glyphs aren't in that font at all,
// so they'd render as empty tofu boxes, the exact bug that was already hit and fixed once here.
// Feature rows use a plain colored square marker instead of an icon glyph.
// No "free" anywhere in here -- accurate while the scanner/alerts/calls were the only thing this
// bot offered, but no longer true of the project as a whole now that a paid Supporter tier
// exists. The signals themselves still aren't paywalled (see the Whop setup rules), but this ad
// makes no blanket "free" claim about the community/product, just about what's actually verified.
const PROMO_FEATURES = [
  { title: "LIVE ALERTS", body: "Buy/Sell signals pinged the moment they fire" },
  { title: "VERIFIED CALLS", body: "Every alert logged and tracked to a real result" },
  { title: "REAL SCANNER", body: "200+ pairs scanned automatically, no guesswork" },
  { title: "BACKTESTING", body: "Replay any signal against real history first" }
];

// Deliberately NOT the trading-card look (dark card, thin border, small rows) -- this is a hype
// trailer, not a data readout: near-black with neon green/violet glow, huge full-bleed statement
// cuts that REPLACE each other rather than accumulating into a static layout, and a punchy scale
// "pop" entrance (small -> overshoot -> settle) instead of a gentle fade. The corner logo is the
// only element shared with the trading-card visual language, kept as the one consistent brand
// anchor across everything this bot posts.
// green matches GLOW_GREEN_LIGHT -- the same brand green every real /shorts card glows with --
// instead of an unrelated neon-mint, so this still reads as the same brand under a louder style.
const NEON = { green: GLOW_GREEN_LIGHT, violet: "#b24bf3", ink: "#05070a", textDim: "#d3d9e6" };

// A soft dark panel behind a text block -- the glow background looks great but its blobs land at
// different strengths in different places, so text sitting directly on it has inconsistent (often
// poor) contrast. This guarantees legibility without touching the background itself.
function scrim(x, y, w, h, rx = 28) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="rgba(2,4,7,0.6)"/>`;
}

// neonGlow: a single, tighter blur pass behind the sharp source text, not the original double-
// merged wider blur (stdDeviation 15, blurred twice) -- that made the letterforms themselves look
// soft and hazy instead of just giving them a glow halo, which was the actual readability
// complaint. This keeps a real neon-edge glow without smearing the text underneath it.
function neonDefs() {
  return `
  <defs>
    <radialGradient id="glowGreen" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${NEON.green}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${NEON.green}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowViolet" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${NEON.violet}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${NEON.violet}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="42%" r="75%">
      <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.6"/>
    </radialGradient>
    <filter id="neonGlow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="7" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>`;
}

function neonBackground(W, H) {
  const lines = [];
  for (let x = -H; x < W + H; x += 70) {
    lines.push(`<line x1="${x}" y1="${H}" x2="${x + H}" y2="0" stroke="#ffffff" stroke-width="1"/>`);
  }
  return `
  <rect width="${W}" height="${H}" fill="${NEON.ink}"/>
  <circle cx="${W * 0.24}" cy="${H * 0.3}" r="560" fill="url(#glowGreen)"/>
  <circle cx="${W * 0.78}" cy="${H * 0.66}" r="480" fill="url(#glowViolet)"/>
  <g opacity="0.04">${lines.join("")}</g>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>`;
}

// scene: which full-bleed statement is on screen -- these REPLACE each other (see buildPromoRevealFrames),
// unlike highlightSvg's reveal flags which accumulate into one final layout.
// scale: the current pop-in scale for the scene's content group (1 = settled).
function promoSvg(scene, scale, logoRotationDeg) {
  const W = 1080, H = 1920;
  const s = (scale ?? 1).toFixed(3);
  const cx = W / 2, cy = H * 0.42;

  const rightLogoSize = 112, rightLogoX = W - 70 - rightLogoSize, rightLogoY = 70;
  const rightLogoCx = rightLogoX + rightLogoSize / 2, rightLogoCy = rightLogoY + rightLogoSize / 2;

  let content = "";
  if (scene === "logo") {
    content = `<g transform="translate(${cx},${cy}) scale(${s})">
      <clipPath id="heroClip"><rect x="-140" y="-140" width="280" height="280" rx="60"/></clipPath>
      <image href="${logoSrc()}" x="-140" y="-140" width="280" height="280" clip-path="url(#heroClip)" filter="url(#neonGlow)"/>
    </g>`;
  } else if (scene === "stopGuessing") {
    content = `<g transform="translate(${cx},${cy}) scale(${s})" text-anchor="middle">
      ${scrim(-520, -110, 1040, 270)}
      <text y="-40" font-family="DejaVu Sans" font-size="108" font-weight="900" letter-spacing="-1" fill="#ffffff" filter="url(#neonGlow)">STOP</text>
      <text y="90" font-family="DejaVu Sans" font-size="108" font-weight="900" letter-spacing="-1" fill="${NEON.violet}" filter="url(#neonGlow)">GUESSING.</text>
    </g>`;
  } else if (scene === "startWinning") {
    content = `<g transform="translate(${cx},${cy}) scale(${s})" text-anchor="middle">
      ${scrim(-520, -110, 1040, 270)}
      <text y="-40" font-family="DejaVu Sans" font-size="108" font-weight="900" letter-spacing="-1" fill="#ffffff" filter="url(#neonGlow)">START</text>
      <text y="90" font-family="DejaVu Sans" font-size="108" font-weight="900" letter-spacing="-1" fill="${NEON.green}" filter="url(#neonGlow)">WINNING.</text>
    </g>`;
  } else if (scene?.startsWith("feature")) {
    const f = PROMO_FEATURES[Number(scene.slice(7))];
    content = `<g transform="translate(${cx},${cy}) scale(${s})" text-anchor="middle">
      ${scrim(-500, -75, 1000, 210)}
      <text y="-10" font-family="DejaVu Sans" font-size="82" font-weight="900" letter-spacing="-0.5" fill="${NEON.green}" filter="url(#neonGlow)">${escapeXml(f.title)}</text>
      <text y="70" font-family="DejaVu Sans" font-size="30" font-weight="600" fill="${NEON.textDim}">${escapeXml(f.body)}</text>
    </g>`;
  } else if (scene === "recap") {
    content = `<g transform="translate(${cx},${cy}) scale(${s})" text-anchor="middle">
      ${scrim(-500, -105, 1000, 200)}
      <text y="-40" font-family="DejaVu Sans" font-size="80" font-weight="900" letter-spacing="-1" fill="#ffffff" filter="url(#neonGlow)">REAL SIGNALS.</text>
      <text y="55" font-family="DejaVu Sans" font-size="80" font-weight="900" letter-spacing="-1" fill="${NEON.green}" filter="url(#neonGlow)">REAL RESULTS.</text>
    </g>`;
  } else if (scene === "cta") {
    content = `<g transform="translate(${cx},${H * 0.46}) scale(${s})" text-anchor="middle">
      ${scrim(-490, -95, 980, 355)}
      <text y="-30" font-family="DejaVu Sans" font-size="72" font-weight="900" letter-spacing="-1" fill="#ffffff" filter="url(#neonGlow)">JOIN THE</text>
      <text y="80" font-family="DejaVu Sans" font-size="72" font-weight="900" letter-spacing="-1" fill="${NEON.green}" filter="url(#neonGlow)">DISCORD →</text>
      <text y="180" font-family="DejaVu Sans Mono" font-size="28" font-weight="600" fill="${NEON.textDim}">${escapeXml(DISCORD_INVITE_URL.replace(/^https?:\/\//, ""))}</text>
      <text y="222" font-family="DejaVu Sans" font-size="22" fill="#8b93a1">Real signals. Real results.</text>
    </g>`;
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  ${neonDefs()}
  ${neonBackground(W, H)}
  <g transform="rotate(${(logoRotationDeg ?? 0).toFixed(1)} ${rightLogoCx} ${rightLogoCy})">
    <clipPath id="logoClipRight"><rect x="${rightLogoX}" y="${rightLogoY}" width="${rightLogoSize}" height="${rightLogoSize}" rx="28"/></clipPath>
    <image href="${logoSrc()}" x="${rightLogoX}" y="${rightLogoY}" width="${rightLogoSize}" height="${rightLogoSize}" clip-path="url(#logoClipRight)"/>
  </g>
  ${content}
</svg>`;
}

// The static "one picture" -- not a captured video frame, its own standalone hero composition
// (bold headline + all four features as glowing pill chips in a 2x2 grid + CTA) so it reads as a
// complete, powerful image on its own rather than looking like a paused mid-cut of the video.
function promoHeroSvg() {
  const W = 1080, H = 1920;
  const rightLogoSize = 112, rightLogoX = W - 70 - rightLogoSize, rightLogoY = 70;

  const chipW = 460, chipH = 190, gap = 20;
  const gridX = (W - chipW * 2 - gap) / 2, gridY = 700;
  const chips = PROMO_FEATURES.map((f, i) => {
    const x = gridX + (i % 2) * (chipW + gap);
    const y = gridY + Math.floor(i / 2) * (chipH + gap);
    return `
    <rect x="${x}" y="${y}" width="${chipW}" height="${chipH}" rx="20" fill="rgba(2,4,7,0.65)" stroke="${NEON.green}" stroke-opacity="0.4" stroke-width="1.5"/>
    <text x="${x + 28}" y="${y + 62}" font-family="DejaVu Sans" font-size="28" font-weight="800" letter-spacing="0.5" fill="${NEON.green}">${escapeXml(f.title)}</text>
    <text x="${x + 28}" y="${y + 106}" font-family="DejaVu Sans" font-size="20" font-weight="600" fill="${NEON.textDim}">${escapeXml(wrapTwoLines(f.body, 26)[0])}</text>
    <text x="${x + 28}" y="${y + 134}" font-family="DejaVu Sans" font-size="20" font-weight="600" fill="${NEON.textDim}">${escapeXml(wrapTwoLines(f.body, 26)[1] || "")}</text>`;
  }).join("");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  ${neonDefs()}
  ${neonBackground(W, H)}
  <g>
    <clipPath id="logoClipRight"><rect x="${rightLogoX}" y="${rightLogoY}" width="${rightLogoSize}" height="${rightLogoSize}" rx="28"/></clipPath>
    <image href="${logoSrc()}" x="${rightLogoX}" y="${rightLogoY}" width="${rightLogoSize}" height="${rightLogoSize}" clip-path="url(#logoClipRight)"/>
  </g>

  <g text-anchor="middle">
    ${scrim(60, 250, 960, 275)}
    <text x="${W / 2}" y="330" font-family="DejaVu Sans" font-size="88" font-weight="900" letter-spacing="-1" fill="#ffffff" filter="url(#neonGlow)">REAL SIGNALS.</text>
    <text x="${W / 2}" y="430" font-family="DejaVu Sans" font-size="88" font-weight="900" letter-spacing="-1" fill="${NEON.green}" filter="url(#neonGlow)">REAL RESULTS.</text>
    <text x="${W / 2}" y="490" font-family="DejaVu Sans" font-size="28" font-weight="600" fill="${NEON.textDim}">Real crypto scanner. Every call verified.</text>
  </g>

  ${chips}

  <g text-anchor="middle">
    ${scrim(140, 1420, 800, 275)}
    <text x="${W / 2}" y="1500" font-family="DejaVu Sans" font-size="64" font-weight="900" letter-spacing="-1" fill="#ffffff" filter="url(#neonGlow)">JOIN THE</text>
    <text x="${W / 2}" y="1595" font-family="DejaVu Sans" font-size="64" font-weight="900" letter-spacing="-1" fill="${NEON.green}" filter="url(#neonGlow)">DISCORD →</text>
    <text x="${W / 2}" y="1655" font-family="DejaVu Sans Mono" font-size="26" font-weight="600" fill="${NEON.textDim}">${escapeXml(DISCORD_INVITE_URL.replace(/^https?:\/\//, ""))}</text>
  </g>
</svg>`;
}

// Crude but sufficient word-wrap for the hero's feature-chip body text (fixed-width chips, no
// need for real text-measurement -- DejaVu Sans body copy here averages close enough to
// monospace-width-per-char for a character-count wrap to land cleanly at this font size).
function wrapTwoLines(text, maxChars) {
  const words = text.split(" ");
  const lines = [""];
  for (const w of words) {
    const candidate = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w;
    if (candidate.length > maxChars && lines.length < 2) lines.push(w);
    else lines[lines.length - 1] = candidate;
  }
  return lines;
}

async function generatePromoImage() {
  await ensureLogoSrcCached();
  return sharp(Buffer.from(promoHeroSvg())).png().toBuffer();
}

// Same reveal-video shape as buildRevealFrames (a generator of {svg, holdMs}, rotation baked into
// each frame at ROTATION_FRAME_MS granularity) -- kept as its own copy rather than a shared helper
// because the two reveal sequences don't share a content model (highlight data vs. a fixed scene
// list), and this is a one-off asset, not something worth building a shared abstraction for.
const PROMO_VIDEO_MS = 15000;
function* buildPromoRevealFrames() {
  const ROTATION_FRAME_MS = 150;
  const ROTATION_PERIOD_MS = 3000;
  let clockMs = 0;
  function* pushFrames(holdMs, scene, scale) {
    const steps = Math.max(1, Math.round(holdMs / ROTATION_FRAME_MS));
    const stepMs = holdMs / steps;
    for (let i = 0; i < steps; i++) {
      const logoRotationDeg = (clockMs / ROTATION_PERIOD_MS) * 360 % 360;
      yield { svg: promoSvg(scene, scale, logoRotationDeg), holdMs: stepMs };
      clockMs += stepMs;
    }
  }
  // Small -> overshoot -> settle, not a linear fade -- three explicit scale steps read as a real
  // "pop" even as discrete frames (unlike opacity, a scale bounce doesn't need many sub-frames to
  // sell the motion; overshooting past 1.0 before settling is what makes it feel punchy).
  const POP_SCALES = [0.72, 1.12, 1.0];
  const POP_MS = 90;
  function* sceneWithPop(totalMs, scene) {
    for (const scale of POP_SCALES) yield* pushFrames(POP_MS, scene, scale);
    const settledMs = totalMs - POP_MS * POP_SCALES.length;
    if (settledMs > 0) yield* pushFrames(settledMs, scene, 1.0);
  }

  const beats = [
    [900, "logo"],
    [1700, "stopGuessing"],
    [1700, "startWinning"],
    [1400, "feature0"],
    [1400, "feature1"],
    [1400, "feature2"],
    [1400, "feature3"],
    [1700, "recap"]
  ];
  yield* pushFrames(300, "bare", 1);
  let elapsed = 300;
  for (const [ms, scene] of beats) {
    yield* sceneWithPop(ms, scene);
    elapsed += ms;
  }
  yield* sceneWithPop(PROMO_VIDEO_MS - elapsed, "cta");
}

async function generatePromoRevealFramePngs() {
  await ensureLogoSrcCached();
  const rendered = [];
  for (const frame of buildPromoRevealFrames()) {
    const png = await sharp(Buffer.from(frame.svg)).png().toBuffer();
    rendered.push({ png, holdMs: frame.holdMs });
  }
  return rendered;
}

// No ticker/pctChange to work with here (unlike buildYoutubeCaption) -- this is the evergreen
// "join the community" spot posted as a last-resort fallback when neither a real call nor a
// live-mover clears MIN_FEATURE_PCT_CHANGE, so /shorts has something real to post instead of
// going fully silent during a quiet stretch. Shared by both promo ad variants (the SVG hype-
// trailer and the neon-sign photo ad) -- neither names a specific coin, so one caption fits both.
function buildPromoYoutubeCaption() {
  const title = "Crypto Signal Scanner — Real Alerts, Verified Results";
  const description = [
    "Live Buy/Sell alerts the moment they fire, every call logged and tracked to a real result, " +
      "a scanner covering 200+ pairs, and backtesting to check any signal against real history first.",
    "",
    `Real scans, real signals -- not financial advice. Join the Discord: ${DISCORD_INVITE_URL}`,
    "",
    "#crypto #cryptotrading #tradingsignals #Shorts"
  ].join("\n");
  return { title, description };
}

// The second, rotating ad variant -- a photorealistic neon-sign-in-the-rain scene, deliberately
// nothing like the SVG hype-trailer's look, so repeat viewers during a quiet stretch don't see
// the identical ad every time. Unlike the hype-trailer (generated fresh from SVG on every call),
// this is a fixed, pre-rendered asset: the CTA text is already burned into both files (see
// scripts/compose-neon-photo.js for how the base video was made, and the one-time bake that added
// the clickable-looking Discord URL on top of it) -- there's no per-request generation cost at
// all, just a disk read, since the content never changes and re-running that compositing pipeline
// on every quiet check would be pure waste.
const NEON_SIGN_AD_IMAGE_PATH = path.join(__dirname, "..", "..", "assets", "promo-neon-sign.png");
const NEON_SIGN_AD_VIDEO_PATH = path.join(__dirname, "..", "..", "assets", "promo-neon-sign.mp4");

function getNeonSignAdImage() {
  return fs.readFileSync(NEON_SIGN_AD_IMAGE_PATH);
}

function getNeonSignAdVideo() {
  return fs.readFileSync(NEON_SIGN_AD_VIDEO_PATH);
}

module.exports = {
  findMover, generateShortHtml, generateShortImage, generateHighlightImage,
  buildCallHighlight, buildFallbackHighlight, buildYoutubeCaption, DISCORD_INVITE_URL,
  buildRevealFrames, generateRevealFramePngs,
  generatePromoImage, generatePromoRevealFramePngs, buildPromoYoutubeCaption,
  getNeonSignAdImage, getNeonSignAdVideo
};
