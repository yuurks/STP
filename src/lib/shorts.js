// Shared logic behind both the manual scripts/find-movers.js + scripts/generate-short.js dev
// tools and the bot's own scheduled "Shorts" job (see src/index.js) -- scans a candidate pool
// for today's single biggest gainer/loser, then fills the HTML template with real numbers.
// Kept out of index.js so the CLI scripts and the bot never drift into two implementations of
// the same scan.

const fs = require("fs");
const path = require("path");
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
const FONTS_DIR = path.join(__dirname, "..", "..", "assets", "fonts");

// Rendering these SVGs relies on `sharp`'s bundled librsvg finding an actual font file to draw
// text with, matched by font-family name through its bundled fontconfig -- fontconfig itself
// ships with sharp, but it still has to find real font FILES on the host to match against, and a
// minimal deploy container (confirmed on Railway) can have none installed at all, so text without
// this comes out as tofu boxes there even though it renders fine on a normal dev machine with
// real system fonts. Embedding the font's actual bytes as a base64 @font-face makes rendering
// depend only on this file, never on the host -- verified end-to-end against this exact sharp
// version. DejaVu Sans/Sans-Mono: public domain-derived (Bitstream Vera + public domain
// additions), fully redistributable, excellent Unicode coverage (confirmed: →, ·, × all render).
let fontDefsCache = null;
function fontDefs() {
  if (fontDefsCache) return fontDefsCache;
  const toBase64 = name => fs.readFileSync(path.join(FONTS_DIR, name)).toString("base64");
  fontDefsCache = `<defs><style>
    @font-face { font-family: "STPSans"; font-weight: 400; src: url(data:font/ttf;base64,${toBase64("DejaVuSans.ttf")}); }
    @font-face { font-family: "STPSans"; font-weight: 600; src: url(data:font/ttf;base64,${toBase64("DejaVuSans-Bold.ttf")}); }
    @font-face { font-family: "STPSans"; font-weight: 700; src: url(data:font/ttf;base64,${toBase64("DejaVuSans-Bold.ttf")}); }
    @font-face { font-family: "STPSans"; font-weight: 800; src: url(data:font/ttf;base64,${toBase64("DejaVuSans-Bold.ttf")}); }
    @font-face { font-family: "STPSans"; font-weight: 900; src: url(data:font/ttf;base64,${toBase64("DejaVuSans-Bold.ttf")}); }
    @font-face { font-family: "STPMono"; font-weight: 700; src: url(data:font/ttf;base64,${toBase64("DejaVuSansMono.ttf")}); }
  </style></defs>`;
  return fontDefsCache;
}

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
function chartPaths(closes, x, y, w, h) {
  const pad = 6;
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = (max - min) || 1;
  // closes.length - 1 divides into stepX -- guard the single-bar case (a thin/newly-listed
  // small-cap coin could plausibly return only one intraday bar) so this produces a flat line
  // at x=pad instead of NaN coordinates from a divide-by-zero.
  const stepX = closes.length > 1 ? (w - pad * 2) / (closes.length - 1) : 0;
  const points = closes.map((v, i) => [
    x + pad + i * stepX,
    y + pad + (h - pad * 2) * (1 - (v - min) / range)
  ]);
  const line = points.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = line + ` L${points[points.length - 1][0].toFixed(1)},${(y + h - pad).toFixed(1)} L${points[0][0].toFixed(1)},${(y + h - pad).toFixed(1)} Z`;
  const last = points[points.length - 1];
  return { line, area, lastX: last[0], lastY: last[1], min, max };
}

// Real candlesticks from real daily OHLC (see bestCall.js -- only /alerts and /discover picks
// ever have this; DexScreener has no historical candles for /degen or /breakout at all, so those
// never reach this function). Standard convention: wick = high/low, body = open/close, green
// body when the day closed up, red when it closed down -- same color language as an actual
// trading chart, not this bot's own winner/loser palette.
function candlePaths(ohlc, x, y, w, h) {
  const pad = 6;
  const values = ohlc.flatMap(c => [c.high, c.low]);
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const n = ohlc.length;
  const slotW = n > 0 ? (w - pad * 2) / n : 0;
  const bodyW = Math.max(3, Math.min(28, slotW * 0.6));
  const toY = v => y + pad + (h - pad * 2) * (1 - (v - min) / range);

  const candles = ohlc.map((c, i) => {
    const cx = x + pad + slotW * (i + 0.5);
    const isUp = c.close >= c.open;
    const color = isUp ? COLORS.winner : COLORS.loser;
    const bodyTop = toY(Math.max(c.open, c.close));
    const bodyBottom = toY(Math.min(c.open, c.close));
    return (
      `<line x1="${cx.toFixed(1)}" y1="${toY(c.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${toY(c.low).toFixed(1)}" stroke="${color}" stroke-width="2.5"/>` +
      `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(2.5, bodyBottom - bodyTop).toFixed(1)}" rx="1.5" fill="${color}"/>`
    );
  }).join("");

  const lastX = x + pad + slotW * (n - 0.5);
  const lastY = toY(ohlc[n - 1].close);
  return { candles, lastX, lastY, min, max };
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
    `<text x="${x}" y="${(y - 8).toFixed(1)}" font-family="STPSans" font-size="17" font-weight="700" fill="${COLORS.textMuted}">RANGE ${escapeXml(formatMoney(min))} - ${escapeXml(formatMoney(max))}</text>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.10)" stroke-width="1.5" rx="10"/>` +
    gridLines
  );
}

function cardSvg({ x, y, w, h, accent, accentFill, tagLabel, ticker, pctChange, openPrice, nowPrice, closes, ohlc, timeframe, volumeSurgeRatio, chartH = 170, entryLabel = "Open" }) {
  const pad = 40;
  const chartY = y + h - pad - chartH - 40;
  const chartX = x + pad, chartW = w - pad * 2;

  const useCandles = Array.isArray(ohlc) && ohlc.length >= 2;
  const frame = useCandles
    ? (() => { const c = candlePaths(ohlc, chartX, chartY, chartW, chartH); return { ...c, draw: chartFrame(chartX, chartY, chartW, chartH, c.min, c.max) + c.candles }; })()
    : (() => { const c = chartPaths(closes, chartX, chartY, chartW, chartH); return {
        ...c,
        draw: chartFrame(chartX, chartY, chartW, chartH, c.min, c.max) +
          `<path d="${c.area}" fill="${accentFill}"/>` +
          `<path d="${c.line}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
          `<circle cx="${c.lastX.toFixed(1)}" cy="${c.lastY.toFixed(1)}" r="9" fill="${accent}"/>`
      }; })();

  const pctText = `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%`;
  const surgeText = volumeSurgeRatio ? `${volumeSurgeRatio.toFixed(1)}× VOLUME` : null;
  const surgeWidth = surgeText ? 46 + surgeText.length * 15 : 0;

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="${COLORS.card}" stroke="${accent}" stroke-opacity="0.45" stroke-width="2.5"/>
    <rect x="${x + pad}" y="${y + 30}" width="150" height="44" rx="10" fill="${accentFill}"/>
    <text x="${x + pad + 18}" y="${y + 60}" font-family="STPSans" font-size="23" font-weight="800" letter-spacing="1.5" fill="${accent}">${escapeXml(tagLabel.toUpperCase())}</text>
    ${surgeText ? `
    <rect x="${x + w - pad - surgeWidth}" y="${y + 30}" width="${surgeWidth}" height="44" rx="10" fill="rgba(88,101,242,0.18)"/>
    <text x="${x + w - pad - surgeWidth / 2}" y="${y + 60}" font-family="STPSans" font-size="21" font-weight="800" letter-spacing="0.5" fill="${COLORS.cta}" text-anchor="middle">${escapeXml(surgeText)}</text>
    ` : ""}
    <text x="${x + pad}" y="${y + 140}" font-family="STPMono" font-size="52" font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(ticker)}</text>
    <text x="${x + pad}" y="${y + 235}" font-family="STPSans" font-size="92" font-weight="900" fill="${accent}">${pctText}</text>
    <text x="${x + pad}" y="${y + 278}" font-family="STPSans" font-size="29" fill="${COLORS.textSecondary}">${escapeXml(entryLabel)} <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(openPrice)}</tspan> → Now <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(nowPrice)}</tspan></text>
    ${frame.draw}
    <text x="${x + pad}" y="${y + h - 24}" font-family="STPSans" font-size="23" font-weight="700" letter-spacing="1" fill="${COLORS.textMuted}">${escapeXml(timeframe.toUpperCase())}</text>
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
  ${fontDefs()}
  <rect width="${W}" height="${H}" fill="${COLORS.surface}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="36" fill="none" stroke="${COLORS.winner}" stroke-width="6" stroke-opacity="0.55"/>

  <clipPath id="logoClip"><rect x="70" y="80" width="64" height="64" rx="16"/></clipPath>
  <image href="${logoSrc}" x="70" y="80" width="64" height="64" clip-path="url(#logoClip)"/>
  <text x="150" y="122" font-family="STPSans" font-size="29" font-weight="700" letter-spacing="2" fill="${COLORS.textSecondary}">STP · TODAY'S MOVERS</text>

  <text x="70" y="212" font-family="STPSans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">Today's biggest</text>
  <text x="70" y="280" font-family="STPSans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">winner &amp; loser.</text>

  <circle cx="80" cy="325" r="9" fill="${COLORS.cta}"/>
  <text x="100" y="334" font-family="STPSans" font-size="29" font-weight="600" fill="${COLORS.textSecondary}">Live off today's session</text>

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

  <rect x="${W / 2 - 230}" y="1610" width="460" height="90" rx="45" fill="${COLORS.cta}"/>
  <text x="${W / 2}" y="1666" font-family="STPSans" font-size="35" font-weight="800" fill="#ffffff" text-anchor="middle">Join the Discord →</text>

  <text x="${W / 2}" y="1760" font-family="STPSans" font-size="25" font-weight="700" fill="${COLORS.textSecondary}" text-anchor="middle">${escapeXml(metaLine)}</text>
  <text x="${W / 2}" y="1805" font-family="STPSans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Technical pattern data, not financial advice.</text>
  <text x="${W / 2}" y="1835" font-family="STPSans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Past movement isn't a guarantee of future performance.</text>
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
async function generateHighlightImage(highlight) {
  if (!highlight?.closes?.length) {
    throw new Error("highlight is missing closes -- needs at least a 2-point [entry, now] line");
  }

  const W = 1080, H = 1920;
  const logoSrc = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`;
  // Bigger than the dual-card layout's 820/170 -- there's no second card competing for space, so
  // the single card (and its chart) should actually use the extra room instead of leaving a dead
  // gap before the CTA button.
  const cardX = 70, cardW = W - 140, cardH = 1000;
  const cardY = 440;

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  ${fontDefs()}
  <rect width="${W}" height="${H}" fill="${COLORS.surface}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="36" fill="none" stroke="${COLORS.winner}" stroke-width="6" stroke-opacity="0.55"/>

  <clipPath id="logoClip"><rect x="70" y="80" width="64" height="64" rx="16"/></clipPath>
  <image href="${logoSrc}" x="70" y="80" width="64" height="64" clip-path="url(#logoClip)"/>
  <text x="150" y="122" font-family="STPSans" font-size="29" font-weight="700" letter-spacing="2" fill="${COLORS.textSecondary}">STP · ${escapeXml(highlight.badgeText.toUpperCase())}</text>

  <text x="70" y="212" font-family="STPSans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">${escapeXml(highlight.headlineLines[0])}</text>
  <text x="70" y="280" font-family="STPSans" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">${escapeXml(highlight.headlineLines[1])}</text>

  <circle cx="80" cy="325" r="9" fill="${COLORS.cta}"/>
  <text x="100" y="334" font-family="STPSans" font-size="29" font-weight="600" fill="${COLORS.textSecondary}">${escapeXml(highlight.captionText)}</text>

  ${cardSvg({
    x: cardX, y: cardY, w: cardW, h: cardH, accent: COLORS.winner, accentFill: COLORS.winnerFill,
    tagLabel: highlight.badgeText, ticker: highlight.ticker, pctChange: highlight.pctChange,
    openPrice: formatMoney(highlight.openPrice), nowPrice: formatMoney(highlight.nowPrice),
    closes: highlight.closes, ohlc: highlight.ohlc, timeframe: highlight.timeframeLabel, volumeSurgeRatio: highlight.volumeSurgeRatio,
    chartH: 480, entryLabel: highlight.entryLabel
  })}

  <rect x="${W / 2 - 230}" y="1610" width="460" height="90" rx="45" fill="${COLORS.cta}"/>
  <text x="${W / 2}" y="1666" font-family="STPSans" font-size="35" font-weight="800" fill="#ffffff" text-anchor="middle">Join the Discord →</text>

  <text x="${W / 2}" y="1760" font-family="STPSans" font-size="25" font-weight="700" fill="${COLORS.textSecondary}" text-anchor="middle">${escapeXml(highlight.metaLine)}</text>
  <text x="${W / 2}" y="1805" font-family="STPSans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Technical pattern data, not financial advice.</text>
  <text x="${W / 2}" y="1835" font-family="STPSans" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Past movement isn't a guarantee of future performance.</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
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

module.exports = {
  findMover, generateShortHtml, generateShortImage, generateHighlightImage,
  buildCallHighlight, buildFallbackHighlight
};
