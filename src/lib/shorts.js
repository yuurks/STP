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
function candlePaths(ohlc, x, y, w, h, entryIndex, entryPrice, visibleCount) {
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
    const color = isUp ? COLORS.winner : COLORS.loser;
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
function chartFrame(x, y, w, h, min, max) {
  const pad = 6;
  const rows = 4;
  const gridLines = Array.from({ length: rows + 1 }, (_, i) => {
    const gy = y + pad + (h - pad * 2) * (i / rows);
    return `<line x1="${x + pad}" y1="${gy.toFixed(1)}" x2="${x + w - pad}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
  }).join("");

  return (
    `<text x="${x}" y="${(y - 8).toFixed(1)}" font-family="DejaVu Sans" font-size="17" font-weight="700" fill="${COLORS.textMuted}">RANGE ${escapeXml(formatMoney(min))} - ${escapeXml(formatMoney(max))}</text>` +
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

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="${COLORS.card}" stroke="${accent}" stroke-opacity="0.45" stroke-width="2.5"/>
    ${showTag ? `
    <rect x="${x + pad}" y="${y + 30}" width="150" height="44" rx="10" fill="${accentFill}"/>
    <text x="${x + pad + 18}" y="${y + 60}" font-family="DejaVu Sans" font-size="23" font-weight="800" letter-spacing="1.5" fill="${accent}">${escapeXml(tagLabel.toUpperCase())}</text>
    ` : ""}
    ${surgeText ? `
    <rect x="${x + w - pad - surgeWidth}" y="${y + 30}" width="${surgeWidth}" height="44" rx="10" fill="rgba(88,101,242,0.18)"/>
    <text x="${x + w - pad - surgeWidth / 2}" y="${y + 60}" font-family="DejaVu Sans" font-size="21" font-weight="800" letter-spacing="0.5" fill="${COLORS.cta}" text-anchor="middle">${escapeXml(surgeText)}</text>
    ` : ""}
    ${showTicker ? `<text x="${x + pad}" y="${y + 140}" font-family="DejaVu Sans Mono" font-size="52" font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(ticker)}</text>` : ""}
    ${showPct ? `<text x="${x + pad}" y="${y + 235}" font-family="DejaVu Sans" font-size="92" font-weight="900" fill="${accent}">${pctText}</text>` : ""}
    ${showPriceLine ? `<text x="${x + pad}" y="${y + 278}" font-family="DejaVu Sans" font-size="29" fill="${COLORS.textSecondary}">${escapeXml(entryLabel)} <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(openPrice)}</tspan> → Now <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(nowPrice)}</tspan></text>` : ""}
    ${frame ? frame.draw : ""}
    <text x="${x + pad}" y="${y + h - 24}" font-family="DejaVu Sans" font-size="23" font-weight="700" letter-spacing="1" fill="${COLORS.textMuted}">${escapeXml(timeframe.toUpperCase())}</text>
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
  // Bigger than the dual-card layout's 820/170 -- there's no second card competing for space, so
  // the single card (and its chart) should actually use the extra room instead of leaving a dead
  // gap before the CTA button.
  const cardX = 70, cardW = W - 140, cardH = 1000;
  const cardY = 440;

  const showLogo = reveal?.showLogo ?? true;
  const showHeadline = reveal?.showHeadline ?? true;
  const showCaption = reveal?.showCaption ?? true;
  const showCard = reveal?.showCard ?? true;
  const showCTA = reveal?.showCTA ?? true;
  const showFooter = reveal?.showFooter ?? true;
  // Always present (not gated behind any content-reveal beat) -- a persistent spinning watermark
  // in the corner, independent of the left-side logo/badge which is part of the reveal sequence.
  // 0 on the static image (generateHighlightImage never passes a reveal object, so this defaults
  // to a fixed, non-spinning 0deg there -- only the frame-by-frame video actually animates it).
  const logoRotationDeg = reveal?.logoRotationDeg ?? 0;
  const rightLogoSize = 112, rightLogoX = W - 70 - rightLogoSize, rightLogoY = 70;
  const rightLogoCx = rightLogoX + rightLogoSize / 2, rightLogoCy = rightLogoY + rightLogoSize / 2;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${COLORS.surface}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="36" fill="none" stroke="${COLORS.winner}" stroke-width="6" stroke-opacity="0.55"/>

  <g transform="rotate(${logoRotationDeg.toFixed(1)} ${rightLogoCx} ${rightLogoCy})">
    <clipPath id="logoClipRight"><rect x="${rightLogoX}" y="${rightLogoY}" width="${rightLogoSize}" height="${rightLogoSize}" rx="28"/></clipPath>
    <image href="${logoSrc()}" x="${rightLogoX}" y="${rightLogoY}" width="${rightLogoSize}" height="${rightLogoSize}" clip-path="url(#logoClipRight)"/>
  </g>

  ${showLogo ? `
  <clipPath id="logoClip"><rect x="70" y="80" width="64" height="64" rx="16"/></clipPath>
  <image href="${logoSrc()}" x="70" y="80" width="64" height="64" clip-path="url(#logoClip)"/>
  <text x="150" y="122" font-family="DejaVu Sans" font-size="29" font-weight="700" letter-spacing="2" fill="${COLORS.textSecondary}">STP · ${escapeXml(highlight.badgeText.toUpperCase())}</text>
  ` : ""}

  ${showHeadline ? `
  <text x="70" y="212" font-family="DejaVu Sans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">${escapeXml(highlight.headlineLines[0])}</text>
  <text x="70" y="280" font-family="DejaVu Sans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">${escapeXml(highlight.headlineLines[1])}</text>
  ` : ""}

  ${showCaption ? `
  <circle cx="80" cy="325" r="9" fill="${COLORS.cta}"/>
  <text x="100" y="334" font-family="DejaVu Sans" font-size="29" font-weight="600" fill="${COLORS.textSecondary}">${escapeXml(highlight.captionText)}</text>
  ` : ""}

  ${showCard ? cardSvg({
    x: cardX, y: cardY, w: cardW, h: cardH, accent: COLORS.winner, accentFill: COLORS.winnerFill,
    tagLabel: highlight.badgeText, ticker: highlight.ticker, pctChange: highlight.pctChange,
    openPrice: formatMoney(highlight.openPrice), nowPrice: formatMoney(highlight.nowPrice),
    closes: highlight.closes, ohlc: highlight.ohlc, timeframe: highlight.timeframeLabel, volumeSurgeRatio: highlight.volumeSurgeRatio,
    chartH: 480, entryLabel: highlight.entryLabel,
    entryIndex: highlight.entryIndex, entryPriceRaw: highlight.openPrice,
    // Real Call cards mark a genuine logged alert (real price, real timestamp -- see bestCall.js).
    // Live Mover cards have no alert behind them at all: closes[0] is just the start of today's
    // displayed window, not anything the bot ever called. Showing a "BUY" circle there would
    // visually claim a signal that never happened, so it's Real-Call-only.
    showEntryMarker: highlight.badgeText === "Real Call",
    reveal: reveal?.card
  }) : ""}

  ${showCTA ? `
  <rect x="${W / 2 - 230}" y="1470" width="460" height="90" rx="45" fill="${COLORS.cta}"/>
  <text x="${W / 2}" y="1526" font-family="DejaVu Sans" font-size="35" font-weight="800" fill="#ffffff" text-anchor="middle">Join the Discord →</text>
  ` : ""}

  ${showFooter ? `
  <text x="${W / 2}" y="1620" font-family="DejaVu Sans" font-size="25" font-weight="700" fill="${COLORS.textSecondary}" text-anchor="middle">${escapeXml(highlight.metaLine)}</text>
  <text x="${W / 2}" y="1665" font-family="DejaVu Sans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Technical pattern data, not financial advice.</text>
  <text x="${W / 2}" y="1695" font-family="DejaVu Sans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Past movement isn't a guarantee of future performance.</text>
  ` : ""}
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
// logo -> headline -> empty card -> ticker -> percentage counting up -> price line -> chart
// building in candle-by-candle (or point-by-point for the 2-point line format) -> entry marker
// (Real Call only) -> CTA. Every frame is built from the exact same highlightSvg/cardSvg/
// candlePaths/chartPaths functions that render the real static PNG -- this never approximates the
// chart in a different format the way an early concept mockup did; it's the same real chart, just
// revealed progressively.
//
// Deliberately a generator instead of building and returning a full array: a real Railway OOM
// kill happened even after fixing the (much larger) embedded-logo issue, once frame count grew
// with the smoother 10fps rotation -- materializing every frame's SVG text in memory at once,
// however small each one now is individually, is still a real cost multiplied by 150+ frames on
// top of whatever else is running in the same container. A generator means only ONE frame's SVG
// text exists in memory at any moment; the caller (generateRevealFramePngs) rasterizes and
// discards each one before the next is even built.
function* buildRevealFrames(highlight) {
  if (!highlight?.closes?.length) {
    throw new Error("highlight is missing closes -- needs at least a 2-point [entry, now] line");
  }
  const useCandles = Array.isArray(highlight.ohlc) && highlight.ohlc.length >= 2;
  const itemCount = useCandles ? highlight.ohlc.length : highlight.closes.length;
  const showEntryMarker = highlight.badgeText === "Real Call";

  // Tried compositing this via an ffmpeg rotate+overlay filter instead (genuinely continuous,
  // driven by real elapsed time rather than a per-frame angle) -- it's the technically correct fix
  // for zero stepping, but it reliably got SIGKILLed by the OOM killer on Railway's Trial plan
  // regardless of preset/encoder tuning (confirmed across several real deploys). Back to baking the
  // rotation into each content frame's SVG, which has a long track record of not crashing here --
  // every pushFrames() call splits its hold into sub-frames and advances the rotation angle across
  // ALL of them using one running clock, not one that resets per beat.
  // 150ms (~6.7fps): 100ms caused a real OOM in the past; 200ms was the safe fallback. This splits
  // the difference -- if it ever proves unsafe again, widen it back toward 200ms first.
  const ROTATION_FRAME_MS = 150;
  const ROTATION_PERIOD_MS = 3000; // one full 360deg spin every 3s
  let clockMs = 0;
  function* pushFrames(holdMs, reveal) {
    const steps = Math.max(1, Math.round(holdMs / ROTATION_FRAME_MS));
    const stepMs = holdMs / steps;
    for (let i = 0; i < steps; i++) {
      const logoRotationDeg = (clockMs / ROTATION_PERIOD_MS) * 360 % 360;
      yield { svg: highlightSvg(highlight, { ...reveal, logoRotationDeg }), holdMs: stepMs };
      clockMs += stepMs;
    }
  }

  const bare = { showLogo: false, showHeadline: false, showCaption: false, showCard: false, showCTA: false, showFooter: false };
  const withLogo = { ...bare, showLogo: true };
  const withHeadline = { ...withLogo, showHeadline: true };
  const emptyCard = { showTag: false, showTicker: false, showPct: false, showPriceLine: false, showChart: false, showEntryMarker: false };
  const withCard = { ...withHeadline, showCaption: true, showCard: true, card: emptyCard };
  const withTickerCard = { showTag: true, showTicker: true, showPct: false, showPriceLine: false, showChart: false, showEntryMarker: false };
  const withTicker = { ...withCard, card: withTickerCard };

  yield* pushFrames(300, bare);
  yield* pushFrames(600, withLogo);
  yield* pushFrames(700, withHeadline);
  yield* pushFrames(400, withCard);
  yield* pushFrames(150, withTicker);

  // Percentage counts up over 6 steps rather than jumping straight to the final value -- a count-
  // up reads as "this is being calculated," which is a better fit for a real-data card than an
  // instant number would be.
  const PCT_STEPS = 6;
  for (let s = 1; s <= PCT_STEPS; s++) {
    yield* pushFrames(1200 / PCT_STEPS, {
      ...withCard,
      card: { ...withTickerCard, showPct: true, pctFraction: s / PCT_STEPS }
    });
  }

  const withPriceLine = { ...withTickerCard, showPct: true, pctFraction: 1, showPriceLine: true };
  yield* pushFrames(550, { ...withCard, card: withPriceLine });

  // Each candle (or line point) gets its own mini entrance instead of popping in fully formed:
  // chartRevealCount is fractional across CHART_GROWTH_SUBSTEPS sub-frames per step, and
  // candlePaths/chartPaths both interpret a fractional count as "the newest one is still growing
  // in." Grouped into chartSteps outer steps (capped regardless of real candle count) so a long
  // OHLC history still costs a bounded number of frames -- the smoothing is free frame-count-wise
  // now that rotation no longer multiplies every frame above.
  const chartSteps = Math.min(itemCount, MAX_CHART_STEPS);
  const CHART_GROWTH_SUBSTEPS = 3;
  let revealedSoFar = 0;
  for (let s = 1; s <= chartSteps; s++) {
    const target = Math.ceil((s / chartSteps) * itemCount);
    for (let g = 1; g <= CHART_GROWTH_SUBSTEPS; g++) {
      const revealCount = revealedSoFar + (target - revealedSoFar) * (g / CHART_GROWTH_SUBSTEPS);
      yield* pushFrames(CHART_REVEAL_MS / chartSteps / CHART_GROWTH_SUBSTEPS, {
        ...withCard,
        card: { ...withPriceLine, showChart: true, chartRevealCount: revealCount, showEntryMarker: false }
      });
    }
    revealedSoFar = target;
  }

  const elapsedBeforeFinal = 300 + 600 + 700 + 400 + 150 + 1200 + 550 + CHART_REVEAL_MS;
  if (showEntryMarker) {
    yield* pushFrames(400, { ...withCard, card: { ...withPriceLine, showChart: true, showEntryMarker: true } });
    yield* pushFrames(REVEAL_VIDEO_MS - elapsedBeforeFinal - 400, undefined); // undefined reveal = everything shown, same as the real static image
  } else {
    yield* pushFrames(REVEAL_VIDEO_MS - elapsedBeforeFinal, undefined);
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

  const title = `${highlight.ticker} ${pctText} — ${highlight.badgeText} #Shorts`.slice(0, 100);

  const description = [
    `${highlight.ticker}: ${highlight.entryLabel} ${formatMoney(highlight.openPrice)} → Now ${formatMoney(highlight.nowPrice)} (${pctText}).`,
    "",
    highlight.timeframeLabel,
    "",
    `Real scans, real signals -- not financial advice. Join the Discord: ${DISCORD_INVITE_URL}`,
    "",
    `#Shorts #crypto #${tickerLower} #cryptotrading`
  ].join("\n");

  return { title, description };
}

module.exports = {
  findMover, generateShortHtml, generateShortImage, generateHighlightImage,
  buildCallHighlight, buildFallbackHighlight, buildYoutubeCaption, DISCORD_INVITE_URL,
  buildRevealFrames, generateRevealFramePngs
};
