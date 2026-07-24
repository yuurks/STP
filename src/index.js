require("dotenv").config();
const { Client, GatewayIntentBits, Events, AttachmentBuilder, PermissionFlagsBits } = require("discord.js");

const {
  analyze, backtest, dailyReturns, selectDiversified
} = require("./lib/indicators");
const { fetchDailySeries } = require("./lib/marketData");
const watchlist = require("./lib/watchlist");
const universe = require("./lib/universe");
const portfolioLib = require("./lib/portfolio");
const shorts = require("./lib/shorts");
const degen = require("./lib/degen");
const { findDegenCandidates } = degen;
const { findBreakoutCandidates } = require("./lib/breakout");
const { fetchTokenTradingData } = require("./lib/dexscreener");
const {
  scanEmbed, alertEmbed, discoverEmbed, degenEmbed, degenClosestEmbed, volatilityEmbed, backtestEmbed,
  alertHistoryEmbed, discoverHistoryEmbed, degenHistoryEmbed, portfolioEmbed, shortsEmbed, logoAttachment,
  breakoutEmbed, breakoutClosestEmbed, breakoutHistoryEmbed
} = require("./lib/embeds");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Twelve Data's free tier allows 8 requests/minute -- 7.5s is the fastest pace that stays
// under that. (1 req/sec, the old value here, was actually 60/min and would rate-limit mid-scan.)
const PACING_MS = 7500;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Twelve Data's free tier also caps out at 800 requests/day. A scheduled scan (autoscan or
// alerts) uses one request per ticker, so this is the fewest minutes between scans that stays
// under the daily cap for a given watchlist size.
const REQUESTS_PER_DAY_LIMIT = 800;
function minSustainableInterval(tickerCount) {
  if (tickerCount <= 0) return 15;
  return Math.max(15, Math.ceil((tickerCount * 24 * 60) / REQUESTS_PER_DAY_LIMIT));
}

// Discord messages cap out at 2000 characters. Defensive: even if a watchlist somehow grows
// huge, never build a reply that Discord will reject -- truncate and say how much got cut off.
const DISCORD_MESSAGE_LIMIT = 2000;
function formatTickerList(tickers) {
  if (!tickers.length) return "(empty)";
  let joined = tickers.join(", ");
  if (joined.length <= DISCORD_MESSAGE_LIMIT - 50) return joined;
  let shown = 0;
  let out = "";
  for (const t of tickers) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > DISCORD_MESSAGE_LIMIT - 50) break;
    out = next;
    shown++;
  }
  return `${out} (+${tickers.length - shown} more)`;
}

// /alerts and /portfolio each mix a read-only subcommand (history, status) with state-changing
// ones (on/off/digest-*, start/reset). Discord's own command permission system only restricts a
// whole command, not individual subcommands, so those two commands stay open at the top level
// (see deploy-commands.js) and call this instead for just the subcommands that actually change
// something. Replies and returns false if the caller lacks Manage Server; caller should `break`
// on false.
async function requireManageGuild(interaction) {
  if (interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  await interaction.reply({
    content: "You need the **Manage Server** permission to change this -- ask a server admin/mod.",
    ephemeral: true
  });
  return false;
}

async function runScan(guildId) {
  const guild = watchlist.getGuild(guildId);
  const results = [];
  for (const symbol of guild.tickers) {
    try {
      const rows = await fetchDailySeries(symbol);
      if (rows.length >= 30) {
        const analysis = analyze(rows);
        results.push({ symbol, ...analysis });
      }
    } catch (err) {
      console.error(`Scan failed for ${symbol}: ${err.message}`);
    }
    await sleep(PACING_MS);
  }
  return results;
}

// Advances a guild's paper portfolio (if one exists) using whatever scan just ran -- /scan,
// /autoscan, and /alerts all call this with their results, so the simulation piggybacks on
// scans that are already happening rather than needing its own scheduled API usage. Returns a
// short list of human-readable event strings (opens/closes), or null if no portfolio is running.
function updatePortfolio(guildId, results) {
  const portfolio = watchlist.getPortfolio(guildId);
  if (!portfolio) return null;
  const { portfolio: updated, events } = portfolioLib.applyResults(portfolio, results);
  watchlist.savePortfolio(guildId, updated);
  return events.map(e =>
    e.type === "open"
      ? `Opened ${e.symbol}: ${e.shares.toFixed(4)} shares @ $${e.price.toFixed(2)}`
      : `Closed ${e.symbol} (${e.reason}): ${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(2)}`
  );
}

// Scans a candidate pool (not the watchlist) for volatility, then replaces the watchlist with
// the most volatile ones found. Runs detached from the interaction -- at 300 candidates and 7.5s
// pacing this takes well over the 15-minute window Discord gives an interaction to respond, so
// progress/results are posted as normal channel messages instead of interaction replies.
const NO_TREND_ADX = 15;
// Dollar-liquidity floor (price * volume, averaged over 20 days) -- would screen out names
// where a handful of trades can swing the price and produce misleadingly high "volatility" that
// has nothing to do with a real trading opportunity. NOT currently applied to crypto: confirmed
// (2026-07-22, via time_series, quote, and time_series with an explicit exchange param) that
// Twelve Data simply doesn't return volume for crypto pairs -- not a free-tier gap, the field is
// absent/zero everywhere tried. Left defined (unused by runAutobuild below) in case a real
// volume source ever gets wired in; do not resurrect a >= MIN_DOLLAR_VOLUME check against crypto
// rows without one, it will silently exclude every candidate, every time.
const MIN_DOLLAR_VOLUME = 1_000_000;
// How similar (correlated) two picks' recent daily returns are allowed to be before the lower-
// volatility one gets skipped in favor of something that actually moves independently.
const MAX_CORRELATION = 0.7;
// Always scans the max sustainable sample rather than asking the user to pick a size -- the
// point is finding the biggest potential movers, which means checking as much of the candidate
// pool as the free-tier request budget allows, not an arbitrary smaller default.
const AUTOBUILD_SAMPLE_SIZE = 300;
async function runAutobuild(guildId, channel, candidates, count) {
  const found = [];
  for (const symbol of candidates) {
    try {
      const rows = await fetchDailySeries(symbol);
      if (rows.length >= 30) {
        const analysis = analyze(rows);
        found.push({ symbol, ...analysis });
      }
    } catch (err) {
      console.error(`Autobuild lookup failed for ${symbol}: ${err.message}`);
    }
    await sleep(PACING_MS);
  }

  // Pure volatility with zero trend behind it is more often a spike about to mean-revert than
  // a real opportunity -- exclude confirmed no-trend candidates (benefit of the doubt if ADX
  // couldn't be computed at all rather than excluding on missing data).
  const trending = found.filter(f => f.adx == null || f.adx >= NO_TREND_ADX);

  // Real correlation-based diversification, not a stock/crypto label split: rank by volatility,
  // but skip any candidate whose recent daily returns move too closely with one already picked,
  // so the result is actually-uncorrelated exposure rather than several near-identical bets.
  const withReturns = trending.map(f => ({ ...f, returns: dailyReturns(f.rows.slice(-61).map(r => r.close)) }));
  const top = selectDiversified(withReturns, count, MAX_CORRELATION);

  if (!top.length) {
    await channel.send("Scan finished, but no candidates returned usable data — watchlist left unchanged.");
    return;
  }

  const tickers = watchlist.replaceTickers(guildId, top.map(t => t.symbol));
  await channel.send({
    content: `Scan complete: checked ${found.length}/${candidates.length} candidates ` +
      `(${found.length - trending.length} excluded for having no real trend). ` +
      `Watchlist replaced with the ${tickers.length} biggest potential movers, filtered for diversification.`,
    embeds: [volatilityEmbed(top)],
    files: [logoAttachment()]
  });
}

// Checks back on past logged alerts old enough to have a real forward result. Stop-aware, same
// as /backtest: fetches each unique symbol's daily range once and walks forward from the alert's
// fire date, checking whether its 2x-ATR stop (logged at fire time) was hit before now -- scored
// at the stop price if so, otherwise at the latest available close. Alerts logged before ATR
// tracking existed (no h.atr) fall back to a plain latest-close-vs-fired-price comparison.
const ALERT_EVAL_MIN_AGE_MS = 5 * 24 * 60 * 60 * 1000; // ~5 trading days, treated loosely as calendar days
const ALERT_EVAL_MAX_SYMBOLS = 30;
const ALERT_EVAL_LOOKBACK_DAYS = 120;
// embedFn defaults to /alerts' own embed; /discover history passes discoverHistoryEmbed instead
// -- same evaluation logic (daily candles, stop-aware), just a different track record to label.
async function runAlertHistory(channel, eligible, embedFn = alertHistoryEmbed) {
  const uniqueSymbols = [...new Set(eligible.map(h => h.symbol))].slice(0, ALERT_EVAL_MAX_SYMBOLS);
  const seriesBySymbol = {};
  for (const symbol of uniqueSymbols) {
    try {
      const rows = await fetchDailySeries(symbol, ALERT_EVAL_LOOKBACK_DAYS);
      if (rows.length) seriesBySymbol[symbol] = rows;
    } catch (err) {
      console.error(`Alert history lookup failed for ${symbol}: ${err.message}`);
    }
    await sleep(PACING_MS);
  }

  const evaluated = [];
  for (const h of eligible) {
    const rows = seriesBySymbol[h.symbol];
    if (!rows) continue;

    const firedDate = new Date(h.timestamp).toISOString().slice(0, 10);
    const forwardRows = rows.filter(r => r.date > firedDate);
    if (!forwardRows.length) continue;

    const isBuySide = h.verdict.includes("Buy");
    let forwardReturn = null;
    let stoppedOut = false;

    if (h.atr) {
      const stopPrice = isBuySide ? h.price - 2 * h.atr : h.price + 2 * h.atr;
      for (const row of forwardRows) {
        const hitStop = isBuySide ? row.low <= stopPrice : row.high >= stopPrice;
        if (hitStop) {
          forwardReturn = ((stopPrice - h.price) / h.price) * 100;
          stoppedOut = true;
          break;
        }
      }
    }

    if (forwardReturn == null) {
      const latestClose = forwardRows[forwardRows.length - 1].close;
      forwardReturn = ((latestClose - h.price) / h.price) * 100;
    }

    evaluated.push({ verdict: h.verdict, forwardReturn, stoppedOut });
  }

  if (!evaluated.length) {
    await channel.send("Couldn't fetch current prices for any past alerts — try again later.");
    return;
  }

  const byVerdict = {};
  for (const e of evaluated) (byVerdict[e.verdict] ||= []).push(e);

  const summary = Object.entries(byVerdict).map(([verdict, entries]) => {
    const isBuySide = verdict.includes("Buy");
    const wins = entries.filter(e => (isBuySide ? e.forwardReturn > 0 : e.forwardReturn < 0)).length;
    return {
      verdict, count: entries.length,
      winRate: (wins / entries.length) * 100,
      avgReturn: entries.reduce((a, e) => a + e.forwardReturn, 0) / entries.length,
      stoppedCount: entries.filter(e => e.stoppedOut).length
    };
  });

  await channel.send({
    embeds: [embedFn(summary, evaluated.length)],
    files: [logoAttachment()]
  });
}

// The scheduled Shorts drop samples a much smaller slice than /watch autobuild (300) --
// it runs twice a day automatically, so a smaller number keeps the combined daily cost from
// eating into the quota the rest of the bot's features (autoscan, alerts, etc.) depend on.
const SHORTS_SAMPLE_SIZE = 100;
// Crypto only, and skewed toward smaller-cap coins -- see universe.js's SMALLCAP_RANK_CUTOFF
// and shorts.js's volume-surge filter for how "small cap, real volume interest" is approximated.
const SHORTS_UNIVERSE = "crypto-smallcap";

// America/New_York wall-clock time, used to fire the Shorts drop at a fixed local time
// (4:00pm/8:00pm ET) regardless of where the server hosting the bot actually runs.
function nowInEastern() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${get("hour")}:${get("minute")}` };
}

// Scans, renders the finished visual as a PNG, and posts it to the given channel as an
// embedded image (not a file you have to download and open) alongside the stats embed.
async function runShortsDrop(channel) {
  const { winner, loser } = await shorts.findMover(SHORTS_UNIVERSE, SHORTS_SAMPLE_SIZE);
  if (!winner || !loser) {
    await channel.send("Shorts scan finished, but didn't find usable data -- skipped.");
    return;
  }
  const png = await shorts.generateShortImage(winner, loser);
  const filename = "stp-short.png";
  const file = new AttachmentBuilder(png, { name: filename });
  await channel.send({ embeds: [shortsEmbed(winner, loser, "Crypto", filename)], files: [file] });
}

// /discover scans the crypto candidate pool (not the watchlist) for coins whose RSI/MACD/EMA
// score AND ADX trend line up into a real Buy/Strong Buy -- analyze()'s existing confidence
// filter already requires real trend (ADX >= 20) before a Buy/Sell survives (see
// applyConfidenceFilter in indicators.js). Volume is deliberately NOT part of this gate: Twelve
// Data does not return volume for crypto pairs (confirmed 2026-07-22 across time_series, quote,
// and time_series with an explicit exchange param -- the field is absent/zero everywhere, not a
// free-tier gap), so a volume-surge or liquidity requirement here would silently exclude every
// candidate, always. If a real crypto volume source ever gets wired in, this is where a surge
// check belongs. Edge-triggered like /alerts: only fires on a fresh transition into Buy/Strong
// Buy for that symbol, not every run it stays there.
const DISCOVER_SAMPLE_SIZE = 50;
// Same protection minSustainableInterval() gives autoscan/alerts, just in hours against a flat
// sample size instead of minutes against watchlist size -- without this, /discover on could be
// configured with an interval_hours low enough to burn the entire daily quota by itself (e.g.
// interval_hours:1 at 50 candidates/scan = 1200 requests/day, 400 over the 800/day cap alone).
function minDiscoverIntervalHours() {
  return Math.max(1, Math.ceil((DISCOVER_SAMPLE_SIZE * 24) / REQUESTS_PER_DAY_LIMIT));
}
async function runDiscoverScan(guildId, channel) {
  const pool = universe.loadUniverse("crypto");
  const candidates = universe.sample(pool, DISCOVER_SAMPLE_SIZE);
  const lastVerdicts = watchlist.getDiscoverVerdicts(guildId);
  const newVerdicts = {};
  const fired = [];

  for (const symbol of candidates) {
    try {
      const rows = await fetchDailySeries(symbol);
      if (rows.length >= 30) {
        const result = analyze(rows);
        newVerdicts[symbol] = result.verdict;

        const isFreshBuy = result.verdict.includes("Buy") && lastVerdicts[symbol] !== result.verdict;
        if (isFreshBuy) fired.push({ symbol, ...result });
      }
    } catch (err) {
      console.error(`Discover scan skipped ${symbol}: ${err.message}`);
    }
    await sleep(PACING_MS);
  }

  watchlist.saveDiscoverVerdicts(guildId, newVerdicts);
  if (fired.length) {
    for (const r of fired) watchlist.logDiscoverAlert(guildId, r.symbol, r.verdict, r.last.close, r.atr);
    await channel.send({ embeds: [discoverEmbed(fired)], files: [logoAttachment()] });
  }
  return fired;
}

// Degen/Breakout alerts move on the scale of minutes/hours, not the multi-day cadence /alerts
// and /discover need for a daily candle to even exist -- an hour is enough for DexScreener's
// price to have actually moved since the alert fired. Shared by both since the reasoning (raw
// DexScreener snapshot, no candles) is identical either way.
const DEX_EVAL_MIN_AGE_MS = 60 * 60 * 1000;

// No daily candles exist for these tokens (see dexscreener.js), so this can't replay a stop-loss
// path like runAlertHistory does -- just current DexScreener price vs. the price logged at alert
// time. A token DexScreener no longer returns at all is excluded from the average (can't compute
// a return with no current price), not scored as a loss -- but that's very likely undercounting
// real losses (dead liquidity/rugged tokens are exactly the ones DexScreener stops returning), so
// the excluded count is surfaced in the embed rather than silently dropped. Shared by /degen
// history and /breakout history -- identical evaluation logic either way, just a different embed
// and label for the "nothing could be evaluated" message.
async function runDexScreenerHistory(channel, eligible, embedFn, label) {
  const addresses = [...new Set(eligible.map(h => h.address))];
  const currentByAddress = new Map();
  try {
    const pairs = await fetchTokenTradingData("solana", addresses);
    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      if (!addr) continue;
      const liq = pair.liquidity?.usd || 0;
      const existing = currentByAddress.get(addr);
      if (!existing || liq > (existing.liquidity?.usd || 0)) currentByAddress.set(addr, pair);
    }
  } catch (err) {
    console.error(`${label} history lookup failed: ${err.message}`);
    await channel.send(`Couldn't reach DexScreener to check past ${label} alerts -- try again later.`);
    return;
  }

  const evaluated = [];
  let excludedCount = 0;
  for (const h of eligible) {
    const current = currentByAddress.get(h.address);
    const currentPrice = current ? parseFloat(current.priceUsd) : NaN;
    if (!current || !currentPrice || !h.price) {
      excludedCount++;
      continue;
    }
    evaluated.push({ symbol: h.symbol, returnPct: ((currentPrice - h.price) / h.price) * 100 });
  }

  if (!evaluated.length) {
    await channel.send(
      `None of the ${eligible.length} eligible past ${label} alert(s) could be evaluated -- DexScreener no ` +
      "longer returns any of them (likely delisted/rugged/dead liquidity)."
    );
    return;
  }

  await channel.send({ embeds: [embedFn(evaluated, excludedCount)], files: [logoAttachment()] });
}

// /degen scans DexScreener's rolling feed of newly-profiled Solana tokens for real liquidity +
// real buy pressure (see src/lib/degen.js for the exact filters and why this can't use the
// RSI/MACD/ADX engine at all). Uses DexScreener's own 60 req/min budget, entirely separate from
// Twelve Data's 800/day -- doesn't compete with any other feature's quota.
// includeClosest: only ever passed true from /degen now (the manual trigger below) -- when
// nothing fully qualifies, posts the single closest near-miss instead (still risk-screened,
// clearly labeled as not a real alert). Scheduled runs never set this: an automatic "closest,
// still failed" post every few minutes would spam and defeat the point of the filter.
async function runDegenScan(guildId, channel, { includeClosest = false } = {}) {
  const alerted = new Set(watchlist.getDegenAlerted(guildId));
  const { checked, candidates, closest } = await findDegenCandidates(alerted, { includeClosest });
  if (candidates.length) {
    watchlist.addDegenAlerted(guildId, candidates.map(c => c.baseToken.address));
    for (const c of candidates) {
      watchlist.logDegenAlert(guildId, c.baseToken.address, c.baseToken.symbol, parseFloat(c.priceUsd) || 0, c.url);
    }
    await channel.send({ embeds: [degenEmbed(candidates)], files: [logoAttachment()] });
  } else if (closest) {
    await channel.send({ embeds: [degenClosestEmbed(closest)], files: [logoAttachment()] });
  }
  return { checked, candidates, closest };
}

async function runBreakoutScan(guildId, channel, { includeClosest = false } = {}) {
  const alerted = new Set(watchlist.getBreakoutAlerted(guildId));
  const { checked, candidates, closest } = await findBreakoutCandidates(alerted, { includeClosest });
  if (candidates.length) {
    watchlist.addBreakoutAlerted(guildId, candidates.map(c => c.baseToken.address));
    for (const c of candidates) {
      watchlist.logBreakoutAlert(guildId, c.baseToken.address, c.baseToken.symbol, parseFloat(c.priceUsd) || 0, c.url);
    }
    await channel.send({ embeds: [breakoutEmbed(candidates)], files: [logoAttachment()] });
  } else if (closest) {
    await channel.send({ embeds: [breakoutClosestEmbed(closest)], files: [logoAttachment()] });
  }
  return { checked, candidates, closest };
}

// Fires only for tickers whose verdict is actionable (not Neutral) and has changed since the
// last check -- so a ticker sitting at "Buy" doesn't re-alert every interval, only on the
// Neutral->Buy (or Buy->Sell, etc.) transition.
function findFiredAlerts(guildId, results) {
  const lastVerdicts = watchlist.getLastVerdicts(guildId);
  const fired = results.filter(r => r.verdict !== "Neutral" && lastVerdicts[r.symbol] !== r.verdict);

  const newVerdicts = {};
  for (const r of results) newVerdicts[r.symbol] = r.verdict;
  watchlist.saveVerdicts(guildId, newVerdicts);

  return fired;
}

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag}`);

  // every minute, check whether any guild's auto-scan interval has elapsed
  setInterval(async () => {
    const now = Date.now();
    for (const [guildId, guildData] of watchlist.allGuildsWithAutoscan()) {
      const { channelId, intervalMinutes, lastRun } = guildData.autoscan;
      const due = !lastRun || now - lastRun >= intervalMinutes * 60 * 1000;
      if (!due) continue;

      try {
        const channel = await client.channels.fetch(channelId);
        const results = await runScan(guildId);
        if (results.length) await channel.send({ embeds: [scanEmbed(results)], files: [logoAttachment()] });
        const portfolioEvents = updatePortfolio(guildId, results);
        if (portfolioEvents?.length) await channel.send(`📒 Paper portfolio: ${portfolioEvents.join(" · ")}`);
        watchlist.markAutoscanRun(guildId, now);
      } catch (err) {
        console.error(`Autoscan failed for guild ${guildId}: ${err.message}`);
      }
    }

    for (const [guildId, guildData] of watchlist.allGuildsWithAlerts()) {
      const { channelId, intervalMinutes, lastRun } = guildData.alerts;
      const due = !lastRun || now - lastRun >= intervalMinutes * 60 * 1000;
      if (!due) continue;

      try {
        const results = await runScan(guildId);
        const fired = findFiredAlerts(guildId, results);
        const portfolioEvents = updatePortfolio(guildId, results);
        if (fired.length || portfolioEvents?.length) {
          const channel = await client.channels.fetch(channelId);
          if (fired.length) {
            for (const r of fired) watchlist.logAlert(guildId, r.symbol, r.verdict, r.last.close, r.atr);
            await channel.send({ embeds: [alertEmbed(fired)], files: [logoAttachment()] });
          }
          if (portfolioEvents?.length) await channel.send(`📒 Paper portfolio: ${portfolioEvents.join(" · ")}`);
        }
        watchlist.markAlertsRun(guildId, now);
      } catch (err) {
        console.error(`Alert check failed for guild ${guildId}: ${err.message}`);
      }
    }

    for (const [guildId, guildData] of watchlist.allGuildsWithAutobuildSchedule()) {
      const { channelId, intervalHours, count } = guildData.autobuildSchedule;
      // Shares the same cooldown clock as manual /watch autobuild, so a scheduled and a manual
      // run can never overlap/double-spend the daily request quota.
      const lastRun = watchlist.getAutobuildLastRun(guildId);
      const due = !lastRun || now - lastRun >= intervalHours * 60 * 60 * 1000;
      if (!due) continue;

      try {
        const pool = universe.loadUniverse("crypto");
        if (!pool.length) continue;
        const candidates = universe.sample(pool, AUTOBUILD_SAMPLE_SIZE);
        const channel = await client.channels.fetch(channelId);
        watchlist.markAutobuildRun(guildId, now); // mark before the long scan starts, not after
        await channel.send(`Scheduled scan starting: checking ${candidates.length} crypto candidates for the biggest potential movers...`);
        await runAutobuild(guildId, channel, candidates, count);
      } catch (err) {
        console.error(`Scheduled autobuild failed for guild ${guildId}: ${err.message}`);
      }
    }

    for (const [guildId, guildData] of watchlist.allGuildsWithAlertDigestSchedule()) {
      const { channelId, intervalDays, lastRun } = guildData.alertDigestSchedule;
      const due = !lastRun || now - lastRun >= intervalDays * 24 * 60 * 60 * 1000;
      if (!due) continue;

      try {
        const history = watchlist.getAlertHistory(guildId);
        const eligible = history.filter(h => now - h.timestamp >= ALERT_EVAL_MIN_AGE_MS);
        watchlist.markAlertDigestRun(guildId, now);
        if (!eligible.length) continue;
        const channel = await client.channels.fetch(channelId);
        await runAlertHistory(channel, eligible);
      } catch (err) {
        console.error(`Alert digest failed for guild ${guildId}: ${err.message}`);
      }
    }

    // Two fixed daily drops (4:00pm and 8:00pm ET), both scanning small/mid-cap crypto -- rather
    // than an interval. `date !== lastRunDate` guards against firing more than once during that
    // minute's window and survives restarts since the date is persisted, not just held in memory.
    const { date, hhmm } = nowInEastern();
    for (const [guildId, guildData] of watchlist.allGuildsWithShortsSchedule()) {
      const { channelId, lastRunDate1, lastRunDate2 } = guildData.shortsSchedule;

      if (hhmm === "16:00" && lastRunDate1 !== date) {
        watchlist.markShortRun(guildId, "1", date);
        try {
          const channel = await client.channels.fetch(channelId);
          await runShortsDrop(channel);
        } catch (err) {
          console.error(`Shorts drop (4pm) failed for guild ${guildId}: ${err.message}`);
        }
      }

      if (hhmm === "20:00" && lastRunDate2 !== date) {
        watchlist.markShortRun(guildId, "2", date);
        try {
          const channel = await client.channels.fetch(channelId);
          await runShortsDrop(channel);
        } catch (err) {
          console.error(`Shorts drop (8pm) failed for guild ${guildId}: ${err.message}`);
        }
      }
    }

    for (const [guildId, guildData] of watchlist.allGuildsWithDiscoverSchedule()) {
      const { channelId, intervalHours, lastRun } = guildData.discoverSchedule;
      const due = !lastRun || now - lastRun >= intervalHours * 60 * 60 * 1000;
      if (!due) continue;

      watchlist.markDiscoverRun(guildId, now);
      try {
        const channel = await client.channels.fetch(channelId);
        await runDiscoverScan(guildId, channel);
      } catch (err) {
        console.error(`Discover scan failed for guild ${guildId}: ${err.message}`);
      }
    }

    for (const [guildId, guildData] of watchlist.allGuildsWithDegenSchedule()) {
      const { channelId, intervalMinutes, lastRun } = guildData.degenSchedule;
      const due = !lastRun || now - lastRun >= intervalMinutes * 60 * 1000;
      if (!due) continue;

      watchlist.markDegenRun(guildId, now);
      try {
        const channel = await client.channels.fetch(channelId);
        await runDegenScan(guildId, channel);
      } catch (err) {
        console.error(`Degen scan failed for guild ${guildId}: ${err.message}`);
      }
    }

    for (const [guildId, guildData] of watchlist.allGuildsWithBreakoutSchedule()) {
      const { channelId, intervalMinutes, lastRun } = guildData.breakoutSchedule;
      const due = !lastRun || now - lastRun >= intervalMinutes * 60 * 1000;
      if (!due) continue;

      watchlist.markBreakoutRun(guildId, now);
      try {
        const channel = await client.channels.fetch(channelId);
        await runBreakoutScan(guildId, channel);
      } catch (err) {
        console.error(`Breakout scan failed for guild ${guildId}: ${err.message}`);
      }
    }
  }, 60 * 1000);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "watch": {
        const sub = interaction.options.getSubcommand();
        if (sub === "add") {
          const input = interaction.options.getString("ticker");
          const candidates = input.split(/[\s,]+/).filter(Boolean);

          const MAX_PER_CALL = 50;
          if (candidates.length > MAX_PER_CALL) {
            await interaction.reply({
              content: `That's ${candidates.length} tickers in one go — please add at most ${MAX_PER_CALL} at a time.`,
              ephemeral: true
            });
            break;
          }

          const valid = candidates.filter(c => watchlist.isCryptoTicker(c));
          const invalid = candidates.filter(c => !watchlist.isCryptoTicker(c));

          if (!valid.length) {
            await interaction.reply({
              content: "None of that looked like a crypto pair — this bot is crypto-only, use pairs like `BTC/USD` or `BTC-USD`, comma or space separated.",
              ephemeral: true
            });
            break;
          }

          const tickers = watchlist.addTickers(interaction.guildId, valid);
          const addedNote = `Added ${valid.length} ticker${valid.length === 1 ? "" : "s"}.`;
          const skippedNote = invalid.length ? ` Skipped ${invalid.length} non-crypto: ${formatTickerList(invalid)}.` : "";
          await interaction.reply(`${addedNote}${skippedNote} Watchlist: ${formatTickerList(tickers)}`);
        } else if (sub === "remove") {
          const ticker = interaction.options.getString("ticker");
          if (!watchlist.isValidTicker(ticker)) {
            await interaction.reply({ content: "That doesn't look like a valid ticker.", ephemeral: true });
            break;
          }
          const tickers = watchlist.removeTicker(interaction.guildId, ticker);
          await interaction.reply(`Removed **${watchlist.normalizeSymbol(ticker)}**. Watchlist: ${formatTickerList(tickers)}`);
        } else if (sub === "list") {
          const guild = watchlist.getGuild(interaction.guildId);
          await interaction.reply(
            guild.tickers.length ? `Watching: ${formatTickerList(guild.tickers)}` : "Watchlist is empty — add one with `/watch add`."
          );
        } else if (sub === "clear") {
          watchlist.clearTickers(interaction.guildId);
          await interaction.reply("Watchlist cleared.");
        } else if (sub === "autobuild") {
          const AUTOBUILD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
          const lastRun = watchlist.getAutobuildLastRun(interaction.guildId);
          if (lastRun && Date.now() - lastRun < AUTOBUILD_COOLDOWN_MS) {
            const waitMin = Math.ceil((AUTOBUILD_COOLDOWN_MS - (Date.now() - lastRun)) / 60000);
            await interaction.reply({
              content: `Volatility scans are expensive on the free data tier — you can run this again in about ${waitMin} min.`,
              ephemeral: true
            });
            break;
          }

          const count = Math.min(50, Math.max(1, interaction.options.getInteger("count") || 15));

          const pool = universe.loadUniverse("crypto");
          if (!pool.length) {
            await interaction.reply({ content: "Candidate pool is empty — crypto.txt may be missing.", ephemeral: true });
            break;
          }
          const candidates = universe.sample(pool, AUTOBUILD_SAMPLE_SIZE);
          const etaMin = Math.ceil((candidates.length * PACING_MS) / 60000);

          watchlist.markAutobuildRun(interaction.guildId, Date.now());
          await interaction.reply(
            `Scanning ${candidates.length} crypto candidates for the biggest potential movers — ` +
            `this'll take about ${etaMin} min. I'll post here and replace the watchlist with the top ${count} when done.`
          );
          runAutobuild(interaction.guildId, interaction.channel, candidates, count).catch(err => {
            console.error(`Autobuild failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Volatility scan failed partway through — check the bot logs.").catch(() => {});
          });
        }
        break;
      }

      case "scan": {
        await interaction.deferReply();
        const guild = watchlist.getGuild(interaction.guildId);
        if (!guild.tickers.length) {
          await interaction.editReply("Watchlist is empty — add tickers first with `/watch add`.");
          break;
        }
        const results = await runScan(interaction.guildId);
        if (!results.length) {
          await interaction.editReply("Scan ran but returned no usable data — check your `TWELVE_DATA_API_KEY` and ticker symbols.");
          break;
        }
        const portfolioEvents = updatePortfolio(interaction.guildId, results);
        await interaction.editReply({ embeds: [scanEmbed(results)], files: [logoAttachment()] });
        if (portfolioEvents?.length) {
          await interaction.followUp(`📒 Paper portfolio: ${portfolioEvents.join(" · ")}`);
        }
        break;
      }

      case "autoscan": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const guild = watchlist.getGuild(interaction.guildId);
          const minMinutes = minSustainableInterval(guild.tickers.length);
          const requested = interaction.options.getInteger("interval_minutes");
          const minutes = requested || minMinutes;
          if (minutes < minMinutes) {
            await interaction.reply({
              content: `With ${guild.tickers.length} tickers on your watchlist, the fastest sustainable interval on Twelve Data's free tier is ${minMinutes} min (any faster risks running out of your daily request quota). Try \`interval_minutes:${minMinutes}\` or trim the watchlist.`,
              ephemeral: true
            });
            break;
          }
          const channel = interaction.options.getChannel("channel");
          watchlist.setAutoscan(interaction.guildId, channel.id, minutes);
          await interaction.reply(`Auto-scan on: every ${minutes} min, posting to ${channel}.`);
        } else if (sub === "off") {
          watchlist.setAutoscan(interaction.guildId, null, null);
          await interaction.reply("Auto-scan turned off.");
        }
        break;
      }

      case "alerts": {
        const sub = interaction.options.getSubcommand();
        if (sub !== "history" && !(await requireManageGuild(interaction))) break;
        if (sub === "on") {
          const guild = watchlist.getGuild(interaction.guildId);
          const minMinutes = minSustainableInterval(guild.tickers.length);
          const requested = interaction.options.getInteger("interval_minutes");
          const minutes = requested || minMinutes;
          if (minutes < minMinutes) {
            await interaction.reply({
              content: `With ${guild.tickers.length} tickers on your watchlist, the fastest sustainable interval on Twelve Data's free tier is ${minMinutes} min (any faster risks running out of your daily request quota). Try \`interval_minutes:${minMinutes}\` or trim the watchlist.`,
              ephemeral: true
            });
            break;
          }
          const channel = interaction.options.getChannel("channel");
          watchlist.setAlerts(interaction.guildId, channel.id, minutes);
          await interaction.reply(
            `Signal alerts on: checking every ${minutes} min, posting to ${channel} only when a ticker's verdict changes to Buy/Sell.`
          );
        } else if (sub === "off") {
          watchlist.setAlerts(interaction.guildId, null, null);
          await interaction.reply("Signal alerts turned off.");
        } else if (sub === "history") {
          const history = watchlist.getAlertHistory(interaction.guildId);
          const eligible = history.filter(h => Date.now() - h.timestamp >= ALERT_EVAL_MIN_AGE_MS);

          if (!history.length) {
            await interaction.reply({ content: "No alerts have fired yet for this server.", ephemeral: true });
            break;
          }
          if (!eligible.length) {
            await interaction.reply({
              content: `${history.length} alert(s) logged, but none are old enough yet to evaluate (needs ~5 days since firing).`,
              ephemeral: true
            });
            break;
          }

          await interaction.reply(`Checking real performance of ${eligible.length} past alert(s)...`);
          runAlertHistory(interaction.channel, eligible).catch(err => {
            console.error(`Alert history check failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Alert history check failed partway through — check the bot logs.").catch(() => {});
          });
        } else if (sub === "digest-on") {
          const channel = interaction.options.getChannel("channel");
          const intervalDays = Math.max(1, interaction.options.getInteger("interval_days") || 7);
          watchlist.setAlertDigestSchedule(interaction.guildId, { channelId: channel.id, intervalDays, lastRun: null });
          await interaction.reply(`Alert performance digest on: every ${intervalDays} day(s), posting to ${channel}.`);
        } else if (sub === "digest-off") {
          watchlist.setAlertDigestSchedule(interaction.guildId, null);
          await interaction.reply("Alert performance digest turned off.");
        }
        break;
      }

      case "backtest": {
        await interaction.deferReply();
        const ticker = interaction.options.getString("ticker");
        if (!watchlist.isCryptoTicker(ticker)) {
          await interaction.editReply("That doesn't look like a crypto pair — this bot is crypto-only, try something like `BTC/USD`.");
          break;
        }
        const forwardDays = Math.min(20, Math.max(1, interaction.options.getInteger("forward_days") || 5));
        const symbol = watchlist.normalizeSymbol(ticker);

        const rows = await fetchDailySeries(symbol, 250);
        if (rows.length < 70) {
          await interaction.editReply(`Not enough history for ${symbol} to backtest (need at least ~70 days, got ${rows.length}).`);
          break;
        }

        const result = backtest(rows, forwardDays);
        if (!result.totalSignals) {
          await interaction.editReply(
            `No Buy/Sell signals fired for ${symbol} across its available history — nothing to measure. ` +
            "That's not necessarily bad; the confidence filter is deliberately selective."
          );
          break;
        }

        await interaction.editReply({
          content: `Replayed ${rows.length} days of ${symbol} history, honoring the same 2x-ATR stop shown in /scan (a signal that would've been stopped out before day ${forwardDays} is scored at the stop price, not the day-${forwardDays} close). Small sample sizes are normal here — read this as a rough signal, not proof.`,
          embeds: [backtestEmbed(symbol, result)],
          files: [logoAttachment()]
        });
        break;
      }

      case "autobuild": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const channel = interaction.options.getChannel("channel");
          const intervalHours = Math.max(24, interaction.options.getInteger("interval_hours") || 24);
          const count = Math.min(50, Math.max(1, interaction.options.getInteger("count") || 15));
          watchlist.setAutobuildSchedule(interaction.guildId, {
            channelId: channel.id, intervalHours, count
          });
          await interaction.reply(
            `Scheduled autobuild on: every ${intervalHours}h, scanning the crypto pool for the biggest potential movers, ` +
            `keeping the top ${count}, posting to ${channel}. Shares its cooldown with manual \`/watch autobuild\`, ` +
            "so running that separately will push back the next scheduled run."
          );
        } else if (sub === "off") {
          watchlist.setAutobuildSchedule(interaction.guildId, null);
          await interaction.reply("Scheduled autobuild turned off.");
        }
        break;
      }

      case "shorts": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const channel = interaction.options.getChannel("channel");
          watchlist.setShortsSchedule(interaction.guildId, {
            channelId: channel.id, lastRunDate1: null, lastRunDate2: null
          });
          await interaction.reply(
            `Shorts on: small/mid-cap crypto winner/loser drops daily at 4:00pm and 8:00pm ET in ${channel}. ` +
            "Each post includes a ready-to-use image -- save it and post it as a Short, or use it as-is. " +
            "Posting to YouTube is still on you."
          );
        } else if (sub === "off") {
          watchlist.setShortsSchedule(interaction.guildId, null);
          await interaction.reply("Shorts schedule turned off.");
        } else if (sub === "now") {
          const etaMin = Math.ceil((SHORTS_SAMPLE_SIZE * PACING_MS) / 60000);
          await interaction.reply(`Running a Shorts scan now (crypto) -- at ${SHORTS_SAMPLE_SIZE} candidates, that's about ${etaMin} min. I'll post here when it's ready.`);
          runShortsDrop(interaction.channel).catch(err => {
            console.error(`Manual shorts run failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Shorts scan failed partway through — check the bot logs.").catch(() => {});
          });
        }
        break;
      }

      case "discover": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const minHours = minDiscoverIntervalHours();
          const requested = interaction.options.getInteger("interval_hours");
          const intervalHours = requested || 4;
          if (intervalHours < minHours) {
            await interaction.reply({
              content: `At ${DISCOVER_SAMPLE_SIZE} candidates per scan, the fastest sustainable interval on Twelve Data's free tier is ${minHours}h (any faster risks running out of your daily request quota by itself). Try \`interval_hours:${minHours}\`.`,
              ephemeral: true
            });
            break;
          }
          const channel = interaction.options.getChannel("channel");
          watchlist.setDiscoverSchedule(interaction.guildId, { channelId: channel.id, intervalHours, lastRun: null });
          await interaction.reply(
            `Discover on: every ${intervalHours}h, scanning ${DISCOVER_SAMPLE_SIZE} random crypto candidates for a fresh ` +
            `Buy/Strong Buy backed by RSI/MACD/EMA scoring and confirmed real trend (ADX) -- posting to ${channel} only ` +
            "when one qualifies. Note: volume isn't part of the check -- Twelve Data doesn't provide volume data for " +
            "crypto pairs, so a surge/liquidity requirement isn't something this can honestly do right now. " +
            "This flags what's worth a look, not a prediction -- you decide."
          );
        } else if (sub === "off") {
          watchlist.setDiscoverSchedule(interaction.guildId, null);
          await interaction.reply("Discover schedule turned off.");
        } else if (sub === "now") {
          const etaMin = Math.ceil((DISCOVER_SAMPLE_SIZE * PACING_MS) / 60000);
          await interaction.reply(`Running a Discover scan now -- at ${DISCOVER_SAMPLE_SIZE} candidates, that's about ${etaMin} min. I'll post here when it's done.`);
          runDiscoverScan(interaction.guildId, interaction.channel).then(async fired => {
            if (!fired.length) await interaction.channel.send("Discover scan finished -- nothing cleared the bar this run.");
          }).catch(err => {
            console.error(`Manual discover run failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Discover scan failed partway through — check the bot logs.").catch(() => {});
          });
        } else if (sub === "history") {
          const history = watchlist.getDiscoverAlertHistory(interaction.guildId);
          const eligible = history.filter(h => Date.now() - h.timestamp >= ALERT_EVAL_MIN_AGE_MS);

          if (!history.length) {
            await interaction.reply({ content: "No Discover alerts have fired yet for this server.", ephemeral: true });
            break;
          }
          if (!eligible.length) {
            await interaction.reply({
              content: `${history.length} Discover alert(s) logged, but none are old enough yet to evaluate (needs ~5 days since firing).`,
              ephemeral: true
            });
            break;
          }

          await interaction.reply(`Checking real performance of ${eligible.length} past Discover alert(s)...`);
          runAlertHistory(interaction.channel, eligible, discoverHistoryEmbed).catch(err => {
            console.error(`Discover history check failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Discover history check failed partway through — check the bot logs.").catch(() => {});
          });
        }
        break;
      }

      case "degen": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const channel = interaction.options.getChannel("channel");
          const requested = interaction.options.getInteger("interval_minutes");
          const intervalMinutes = Math.max(2, requested || 10);
          watchlist.setDegenSchedule(interaction.guildId, { channelId: channel.id, intervalMinutes, lastRun: null });
          await interaction.reply(
            `Degen on: every ${intervalMinutes} min, scanning DexScreener's newest Solana pairs for real liquidity ` +
            `(≥$${degen.MIN_LIQUIDITY_USD.toLocaleString()}), market cap (≥$${degen.MIN_MARKET_CAP_USD.toLocaleString()}), real buy ` +
            `pressure (≥${degen.MIN_BUY_SELL_RATIO}x buys/sells, ${degen.MIN_H1_TXNS}+ trades/hr), and confirmed price momentum ` +
            `(≥${degen.MIN_H1_PRICE_CHANGE_PCT}% over 1h, not already dropping >${Math.abs(degen.MAX_M5_PRICE_DROP_PCT)}% in the last 5min) -- ` +
            `then screened against known rug-pull patterns via RugCheck (mint/freeze authority, insider wallet clustering, ` +
            `top-5-holder concentration >${degen.MAX_TOP5_HOLDER_PCT}% combined, unlocked-LP risk) -- posting to ${channel} only when one clears all of it. ` +
            "**High risk, unvalidated**: these filters reduce exposure to known bad patterns, they do not guarantee anything -- brand-new " +
            "pairs can still be rugged, honeypotted, wash-traded, or simply reverse right after the alert, and this can never be " +
            "backtested (no historical data exists for a token that's existed for hours). Not a prediction -- do your own research."
          );
        } else if (sub === "off") {
          watchlist.setDegenSchedule(interaction.guildId, null);
          await interaction.reply("Degen schedule turned off.");
        } else if (sub === "now") {
          await interaction.reply("Running a Degen scan now -- this is fast (DexScreener, not Twelve Data), posting here when it's done.");
          runDegenScan(interaction.guildId, interaction.channel, { includeClosest: true }).then(async ({ candidates, closest }) => {
            if (!candidates.length && !closest) {
              await interaction.channel.send("Degen scan finished -- nothing cleared the bar, and no risk-screen-clean near-miss either this run.");
            }
          }).catch(err => {
            console.error(`Manual degen run failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Degen scan failed partway through — check the bot logs.").catch(() => {});
          });
        } else if (sub === "history") {
          const history = watchlist.getDegenAlertHistory(interaction.guildId);
          const eligible = history.filter(h => Date.now() - h.timestamp >= DEX_EVAL_MIN_AGE_MS);

          if (!history.length) {
            await interaction.reply({ content: "No Degen alerts have fired yet for this server.", ephemeral: true });
            break;
          }
          if (!eligible.length) {
            await interaction.reply({
              content: `${history.length} Degen alert(s) logged, but none are old enough yet to evaluate (needs ~1 hour since firing).`,
              ephemeral: true
            });
            break;
          }

          await interaction.reply(`Checking real performance of ${eligible.length} past Degen alert(s)...`);
          runDexScreenerHistory(interaction.channel, eligible, degenHistoryEmbed, "Degen").catch(err => {
            console.error(`Degen history check failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Degen history check failed partway through — check the bot logs.").catch(() => {});
          });
        }
        break;
      }

      case "breakout": {
        const sub = interaction.options.getSubcommand();
        if (sub === "on") {
          const channel = interaction.options.getChannel("channel");
          const requested = interaction.options.getInteger("interval_minutes");
          const intervalMinutes = Math.max(2, requested || 10);
          watchlist.setBreakoutSchedule(interaction.guildId, { channelId: channel.id, intervalMinutes, lastRun: null });
          await interaction.reply(
            `Breakout on: every ${intervalMinutes} min, scanning Raydium's volume-ranked Solana pools (not ` +
            "restricted to brand-new pairs) for real liquidity " +
            `(≥$${degen.MIN_LIQUIDITY_USD.toLocaleString()}), market cap (≥$${degen.MIN_MARKET_CAP_USD.toLocaleString()}), real buy ` +
            `pressure (≥${degen.MIN_BUY_SELL_RATIO}x buys/sells, ${degen.MIN_H1_TXNS}+ trades/hr), and confirmed price momentum ` +
            `(≥${degen.MIN_H1_PRICE_CHANGE_PCT}% over 1h, not already dropping >${Math.abs(degen.MAX_M5_PRICE_DROP_PCT)}% in the last 5min) -- ` +
            `then screened against known rug-pull patterns via RugCheck (mint/freeze authority, insider wallet clustering, ` +
            `top-5-holder concentration >${degen.MAX_TOP5_HOLDER_PCT}% combined, unlocked-LP risk) -- posting to ${channel} only when one clears all of it. ` +
            "**High risk, unvalidated**: same screen as /degen, just without the age requirement -- an established coin " +
            "breaking out can alert here just as easily as a new one. These filters reduce exposure to known bad patterns, " +
            "they do not guarantee anything, and this can never be backtested (no historical candles exist for either " +
            "command to replay). Not a prediction -- do your own research."
          );
        } else if (sub === "off") {
          watchlist.setBreakoutSchedule(interaction.guildId, null);
          await interaction.reply("Breakout schedule turned off.");
        } else if (sub === "now") {
          await interaction.reply("Running a Breakout scan now -- this is fast (Raydium + DexScreener, not Twelve Data), posting here when it's done.");
          runBreakoutScan(interaction.guildId, interaction.channel, { includeClosest: true }).then(async ({ candidates, closest }) => {
            if (!candidates.length && !closest) {
              await interaction.channel.send("Breakout scan finished -- nothing cleared the bar, and no risk-screen-clean near-miss either this run.");
            }
          }).catch(err => {
            console.error(`Manual breakout run failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Breakout scan failed partway through — check the bot logs.").catch(() => {});
          });
        } else if (sub === "history") {
          const history = watchlist.getBreakoutAlertHistory(interaction.guildId);
          const eligible = history.filter(h => Date.now() - h.timestamp >= DEX_EVAL_MIN_AGE_MS);

          if (!history.length) {
            await interaction.reply({ content: "No Breakout alerts have fired yet for this server.", ephemeral: true });
            break;
          }
          if (!eligible.length) {
            await interaction.reply({
              content: `${history.length} Breakout alert(s) logged, but none are old enough yet to evaluate (needs ~1 hour since firing).`,
              ephemeral: true
            });
            break;
          }

          await interaction.reply(`Checking real performance of ${eligible.length} past Breakout alert(s)...`);
          runDexScreenerHistory(interaction.channel, eligible, breakoutHistoryEmbed, "Breakout").catch(err => {
            console.error(`Breakout history check failed for guild ${interaction.guildId}: ${err.message}`);
            interaction.channel.send("Breakout history check failed partway through — check the bot logs.").catch(() => {});
          });
        }
        break;
      }

      case "portfolio": {
        const sub = interaction.options.getSubcommand();
        if (sub !== "status" && !(await requireManageGuild(interaction))) break;
        if (sub === "start") {
          if (watchlist.getPortfolio(interaction.guildId)) {
            await interaction.reply({
              content: "A paper portfolio is already running for this server. Run `/portfolio reset` first if you want to wipe it and start over.",
              ephemeral: true
            });
            break;
          }
          const startingCash = Math.min(1000000, Math.max(100, interaction.options.getNumber("starting_cash") || 10000));
          watchlist.startPortfolio(interaction.guildId, startingCash);
          await interaction.reply(
            `Paper portfolio started with $${startingCash.toLocaleString()} in simulated cash -- not real money. ` +
            "It updates whenever this server's watchlist gets scanned via `/scan`, `/autoscan`, or `/alerts` " +
            "-- turn one of those on if you want it to progress on its own. Check it with `/portfolio status`."
          );
        } else if (sub === "reset") {
          watchlist.resetPortfolio(interaction.guildId);
          await interaction.reply("Paper portfolio reset. Run `/portfolio start` to begin a new one.");
        } else if (sub === "status") {
          await interaction.deferReply();
          let portfolio = watchlist.getPortfolio(interaction.guildId);
          if (!portfolio) {
            await interaction.editReply("No paper portfolio running yet. Start one with `/portfolio start`.");
            break;
          }

          // Fetch fresh data for every held position. This both prices them for display AND
          // gives them a chance to actually close (stop hit / sell signal) even if their ticker
          // has since been removed from the watchlist -- or replaced entirely by /watch
          // autobuild -- which would otherwise leave them stuck open forever, since no scan
          // would ever look at that symbol again.
          const symbols = Object.keys(portfolio.positions);
          const positionResults = [];
          const currentPrices = {};
          for (const symbol of symbols) {
            try {
              const rows = await fetchDailySeries(symbol);
              if (rows.length >= 30) {
                const analysis = analyze(rows);
                positionResults.push({ symbol, ...analysis });
                currentPrices[symbol] = analysis.last.close;
              }
            } catch (err) {
              console.error(`Portfolio status lookup failed for ${symbol}: ${err.message}`);
            }
            await sleep(PACING_MS);
          }

          if (positionResults.length) {
            updatePortfolio(interaction.guildId, positionResults);
            portfolio = watchlist.getPortfolio(interaction.guildId);
          }

          await interaction.editReply({
            embeds: [portfolioEmbed(portfolio, currentPrices)],
            files: [logoAttachment()]
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error(err);
    const msg = `Something went wrong: ${err.message}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
    else await interaction.reply({ content: msg, ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
