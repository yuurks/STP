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
// -10:15 PM" alone would read as zero elapsed time).
function formatSessionLabel(times) {
  const fmtTime = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const start = parseBarTime(times[0]);
  const end = parseBarTime(times[times.length - 1]);
  return `Last 24 hours · ${fmtDate(start)} ${fmtTime(start)} – ${fmtDate(end)} ${fmtTime(end)} ET`;
}

function formatMetaLine(times) {
  const last = parseBarTime(times[times.length - 1]);
  const date = last.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = last.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time} ET · Source: Twelve Data`;
}

const TEMPLATE_PATH = path.join(__dirname, "..", "..", "scripts", "movers-short.template.html");
const LOGO_PATH = path.join(__dirname, "..", "..", "assets", "logo.png");

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
    .split("{{SESSION_LABEL}}").join(formatSessionLabel(winner.intraday.times))
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
// computed server-side instead of against a live SVG element.
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
  return { line, area, lastX: last[0], lastY: last[1] };
}

function cardSvg({ x, y, w, h, accent, accentFill, tagLabel, ticker, pctChange, openPrice, nowPrice, closes, timeframe, volumeSurgeRatio }) {
  const pad = 40;
  const chartH = 170;
  const chartY = y + h - pad - chartH - 40;
  const { line, area, lastX, lastY } = chartPaths(closes, x + pad, chartY, w - pad * 2, chartH);
  const pctText = `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%`;
  const surgeText = volumeSurgeRatio ? `${volumeSurgeRatio.toFixed(1)}× VOLUME` : null;
  const surgeWidth = surgeText ? 46 + surgeText.length * 15 : 0;

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="${COLORS.card}" stroke="${accent}" stroke-opacity="0.45" stroke-width="2.5"/>
    <rect x="${x + pad}" y="${y + 30}" width="150" height="44" rx="10" fill="${accentFill}"/>
    <text x="${x + pad + 18}" y="${y + 60}" font-family="sans-serif" font-size="23" font-weight="800" letter-spacing="1.5" fill="${accent}">${escapeXml(tagLabel.toUpperCase())}</text>
    ${surgeText ? `
    <rect x="${x + w - pad - surgeWidth}" y="${y + 30}" width="${surgeWidth}" height="44" rx="10" fill="rgba(88,101,242,0.18)"/>
    <text x="${x + w - pad - surgeWidth / 2}" y="${y + 60}" font-family="sans-serif" font-size="21" font-weight="800" letter-spacing="0.5" fill="${COLORS.cta}" text-anchor="middle">${escapeXml(surgeText)}</text>
    ` : ""}
    <text x="${x + pad}" y="${y + 140}" font-family="monospace" font-size="52" font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(ticker)}</text>
    <text x="${x + pad}" y="${y + 235}" font-family="sans-serif" font-size="92" font-weight="900" fill="${accent}">${pctText}</text>
    <text x="${x + pad}" y="${y + 278}" font-family="sans-serif" font-size="29" fill="${COLORS.textSecondary}">Open <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(openPrice)}</tspan> → Now <tspan font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(nowPrice)}</tspan></text>
    <path d="${area}" fill="${accentFill}"/>
    <path d="${line}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="9" fill="${accent}"/>
    <text x="${x + pad}" y="${y + h - 24}" font-family="sans-serif" font-size="23" font-weight="700" letter-spacing="1" fill="${COLORS.textMuted}">${escapeXml(timeframe.toUpperCase())}</text>
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
  const sessionLabel = formatSessionLabel(winner.intraday.times);
  const metaLine = formatMetaLine(winner.intraday.times);

  const cardX = 70, cardW = W - 140, cardH = 560, cardGap = 30;
  const winnerY = 380;
  const loserY = winnerY + cardH + cardGap;

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${COLORS.surface}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="36" fill="none" stroke="${COLORS.winner}" stroke-width="6" stroke-opacity="0.55"/>

  <clipPath id="logoClip"><rect x="70" y="80" width="64" height="64" rx="16"/></clipPath>
  <image href="${logoSrc}" x="70" y="80" width="64" height="64" clip-path="url(#logoClip)"/>
  <text x="150" y="122" font-family="sans-serif" font-size="29" font-weight="700" letter-spacing="2" fill="${COLORS.textSecondary}">STP · TODAY'S MOVERS</text>

  <text x="70" y="212" font-family="sans-serif" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">Today's biggest</text>
  <text x="70" y="280" font-family="sans-serif" font-size="60" font-weight="900" fill="${COLORS.textPrimary}">winner &amp; loser.</text>

  <circle cx="80" cy="325" r="9" fill="${COLORS.cta}"/>
  <text x="100" y="334" font-family="sans-serif" font-size="29" font-weight="600" fill="${COLORS.textSecondary}">Live off today's session</text>

  ${cardSvg({
    x: cardX, y: winnerY, w: cardW, h: cardH, accent: COLORS.winner, accentFill: COLORS.winnerFill,
    tagLabel: "Winner", ticker: winner.symbol, pctChange: winner.pctChange,
    openPrice: formatMoney(winner.intraday.closes[0]), nowPrice: formatMoney(winner.price),
    closes: winner.intraday.closes, timeframe: sessionLabel, volumeSurgeRatio: winner.volumeSurgeRatio
  })}

  ${cardSvg({
    x: cardX, y: loserY, w: cardW, h: cardH, accent: COLORS.loser, accentFill: COLORS.loserFill,
    tagLabel: "Loser", ticker: loser.symbol, pctChange: loser.pctChange,
    openPrice: formatMoney(loser.intraday.closes[0]), nowPrice: formatMoney(loser.price),
    closes: loser.intraday.closes, timeframe: sessionLabel, volumeSurgeRatio: loser.volumeSurgeRatio
  })}

  <rect x="${W / 2 - 230}" y="1610" width="460" height="90" rx="45" fill="${COLORS.cta}"/>
  <text x="${W / 2}" y="1666" font-family="sans-serif" font-size="35" font-weight="800" fill="#ffffff" text-anchor="middle">Join the Discord →</text>

  <text x="${W / 2}" y="1760" font-family="sans-serif" font-size="25" font-weight="700" fill="${COLORS.textSecondary}" text-anchor="middle">${escapeXml(metaLine)}</text>
  <text x="${W / 2}" y="1805" font-family="sans-serif" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Technical pattern data, not financial advice.</text>
  <text x="${W / 2}" y="1835" font-family="sans-serif" font-size="22" fill="${COLORS.textMuted}" text-anchor="middle">Past movement isn't a guarantee of future performance.</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { findMover, generateShortHtml, generateShortImage };
