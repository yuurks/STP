// Shared logic behind both the manual scripts/find-movers.js + scripts/generate-short.js dev
// tools and the bot's own scheduled "Shorts" job (see src/index.js) -- scans a candidate pool
// for today's single biggest gainer/loser, then fills the HTML template with real numbers.
// Kept out of index.js so the CLI scripts and the bot never drift into two implementations of
// the same scan.

const fs = require("fs");
const path = require("path");
const { fetchDailySeries, fetchIntradaySeries } = require("./marketData");
const { avgDollarVolume } = require("./indicators");
const universe = require("./universe");

const PACING_MS = 7500; // same as the bot -- stays under Twelve Data's free 8 req/min
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Same liquidity floor /watch autobuild uses -- a huge % move on a handful of trades isn't a
// real "biggest mover," just noise. Below this, a ticker is excluded from winner/loser
// consideration entirely rather than merely deprioritized, so the result is never a thin-volume
// fluke with an eye-catching number attached.
const MIN_DOLLAR_VOLUME = 1_000_000;

// Crypto trades round the clock, so "intraday" there means a trailing 24h window (96 x 15min
// bars) rather than a bounded session -- stocks use a single ~6.5hr NYSE session (26 bars).
function intradayBarCount(universeKind) {
  return universeKind === "crypto" ? 96 : 26;
}

// Scans a random sample of the given universe ("stocks" | "crypto") for the day's single
// biggest gainer and loser among candidates with real trading volume behind them (>=
// MIN_DOLLAR_VOLUME avg. dollar volume), then fetches each one's intraday bars for the chart.
// Falls back to the best mover regardless of volume only if literally nothing in the sample
// clears the liquidity floor, so a run never comes back empty. Same output shape as
// scripts/find-movers.js's output (data/movers.json), plus a `universeKind` tag.
async function findMover(universeKind, sampleSize) {
  const pool = universe.loadUniverse(universeKind);
  const candidates = universe.sample(pool, sampleSize);

  let winner = null, loser = null;
  let liquidWinner = null, liquidLoser = null;
  let checked = 0;

  for (const symbol of candidates) {
    try {
      const rows = await fetchDailySeries(symbol, 30);
      if (rows.length >= 2) {
        const last = rows[rows.length - 1];
        const prev = rows[rows.length - 2];
        const pctChange = ((last.close - prev.close) / prev.close) * 100;
        const dollarVolume = avgDollarVolume(rows);
        const entry = { symbol, pctChange, price: last.close, dollarVolume };

        if (!winner || pctChange > winner.pctChange) winner = entry;
        if (!loser || pctChange < loser.pctChange) loser = entry;

        if (dollarVolume >= MIN_DOLLAR_VOLUME) {
          if (!liquidWinner || pctChange > liquidWinner.pctChange) liquidWinner = entry;
          if (!liquidLoser || pctChange < liquidLoser.pctChange) liquidLoser = entry;
        }
        checked++;
      }
    } catch (err) {
      console.error(`Shorts scan skipped ${symbol}: ${err.message}`);
    }
    await sleep(PACING_MS);
  }

  // Prefer the volume-backed pick; only fall back to the unfiltered one if nothing in this
  // sample cleared the liquidity floor at all.
  winner = liquidWinner || winner;
  loser = liquidLoser || loser;

  for (const entry of [winner, loser]) {
    if (!entry) continue;
    await sleep(PACING_MS);
    try {
      const bars = await fetchIntradaySeries(entry.symbol, "15min", intradayBarCount(universeKind));
      entry.intraday = { times: bars.map(b => b.time), closes: bars.map(b => b.close) };
    } catch (err) {
      console.error(`Shorts intraday fetch failed for ${entry.symbol}: ${err.message}`);
    }
  }

  return { universeKind, candidateCount: candidates.length, checked, winner, loser };
}

function formatMoney(n) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseBarTime(t) {
  return new Date(t.replace(" ", "T"));
}

// Stocks get a bounded NYSE session label; crypto's intraday window is a trailing 24h instead
// of a "session" (there isn't one), so it reads differently even though both are driven by the
// same first/last bar timestamps.
function formatSessionLabel(times, universeKind) {
  const fmt = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const range = `${fmt(parseBarTime(times[0]))}–${fmt(parseBarTime(times[times.length - 1]))} ET`;
  return universeKind === "crypto" ? `Last 24 hours · ${range}` : `Today's session · ${range}`;
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
function generateShortHtml(winner, loser, universeKind = "stocks") {
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
    .split("{{SESSION_LABEL}}").join(formatSessionLabel(winner.intraday.times, universeKind))
    .split("{{META_LINE}}").join(formatMetaLine(winner.intraday.times));
}

module.exports = { findMover, generateShortHtml, intradayBarCount };
