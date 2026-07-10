require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");

const { analyze, backtest } = require("./lib/indicators");
const { fetchDailySeries } = require("./lib/marketData");
const watchlist = require("./lib/watchlist");
const universe = require("./lib/universe");
const portfolioLib = require("./lib/portfolio");
const {
  scanEmbed, alertEmbed, volatilityEmbed, backtestEmbed, alertHistoryEmbed, portfolioEmbed, logoAttachment
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
// the most volatile ones found. Runs detached from the interaction -- with up to 300 candidates
// at 7.5s pacing this can take well over the 15-minute window Discord gives an interaction to
// respond, so progress/results are posted as normal channel messages instead of interaction replies.
const NO_TREND_ADX = 15;
async function runAutobuild(guildId, channel, candidates, count, universeChoice) {
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
  const eligible = found.filter(f => f.adx == null || f.adx >= NO_TREND_ADX);

  let top;
  if (universeChoice === "both") {
    // Crypto's baseline volatility runs structurally higher than stocks', so a single global
    // ranking crowds out stocks almost every time -- rank each pool separately and blend the
    // top of each instead, so the result is actually diversified rather than crypto-only.
    const isCrypto = f => f.symbol.includes("/");
    const cryptoRanked = eligible.filter(isCrypto).sort((a, b) => b.volatility - a.volatility);
    const stockRanked = eligible.filter(f => !isCrypto(f)).sort((a, b) => b.volatility - a.volatility);
    const half = Math.ceil(count / 2);
    top = [...stockRanked.slice(0, half), ...cryptoRanked.slice(0, count - half)];
    if (top.length < count) {
      const used = new Set(top.map(t => t.symbol));
      const backfill = eligible
        .filter(f => !used.has(f.symbol))
        .sort((a, b) => b.volatility - a.volatility)
        .slice(0, count - top.length);
      top = [...top, ...backfill];
    }
    top.sort((a, b) => b.volatility - a.volatility);
  } else {
    top = [...eligible].sort((a, b) => b.volatility - a.volatility).slice(0, count);
  }

  if (!top.length) {
    await channel.send("Volatility scan finished, but no candidates returned usable data — watchlist left unchanged.");
    return;
  }

  const tickers = watchlist.replaceTickers(guildId, top.map(t => t.symbol));
  await channel.send({
    content: `Volatility scan complete: checked ${found.length}/${candidates.length} candidates ` +
      `(${found.length - eligible.length} excluded for having no real trend). ` +
      `Watchlist replaced with the ${tickers.length} most volatile.`,
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
async function runAlertHistory(channel, eligible) {
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
    embeds: [alertHistoryEmbed(summary, evaluated.length)],
    files: [logoAttachment()]
  });
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
      const { channelId, intervalHours, universe: universeChoice, sample, count } = guildData.autobuildSchedule;
      // Shares the same cooldown clock as manual /watch autobuild, so a scheduled and a manual
      // run can never overlap/double-spend the daily request quota.
      const lastRun = watchlist.getAutobuildLastRun(guildId);
      const due = !lastRun || now - lastRun >= intervalHours * 60 * 60 * 1000;
      if (!due) continue;

      try {
        const pool = universe.loadUniverse(universeChoice);
        if (!pool.length) continue;
        const candidates = universe.sample(pool, sample);
        const channel = await client.channels.fetch(channelId);
        watchlist.markAutobuildRun(guildId, now); // mark before the long scan starts, not after
        await channel.send(`Scheduled volatility scan starting: checking ${candidates.length} candidates from the ${universeChoice} pool...`);
        await runAutobuild(guildId, channel, candidates, count, universeChoice);
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

          const valid = candidates.filter(c => watchlist.isValidTicker(c));
          const invalid = candidates.filter(c => !watchlist.isValidTicker(c));

          if (!valid.length) {
            await interaction.reply({
              content: "None of that looked like a valid ticker — use short symbols like `AAPL` or pairs like `BTC/USD`, comma or space separated.",
              ephemeral: true
            });
            break;
          }

          const tickers = watchlist.addTickers(interaction.guildId, valid);
          const addedNote = `Added ${valid.length} ticker${valid.length === 1 ? "" : "s"}.`;
          const skippedNote = invalid.length ? ` Skipped ${invalid.length} invalid: ${formatTickerList(invalid)}.` : "";
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

          const universeChoice = interaction.options.getString("universe") || "both";
          const sample = Math.min(300, Math.max(10, interaction.options.getInteger("sample") || 100));
          const count = Math.min(50, Math.max(1, interaction.options.getInteger("count") || 15));

          const pool = universe.loadUniverse(universeChoice);
          if (!pool.length) {
            await interaction.reply({ content: "Candidate pool is empty — stocks.txt/crypto.txt may be missing.", ephemeral: true });
            break;
          }
          const candidates = universe.sample(pool, sample);
          const etaMin = Math.ceil((candidates.length * PACING_MS) / 60000);

          watchlist.markAutobuildRun(interaction.guildId, Date.now());
          await interaction.reply(
            `Scanning ${candidates.length} random candidates from the ${universeChoice} pool for volatility — ` +
            `this'll take about ${etaMin} min. I'll post here and replace the watchlist with the top ${count} when done.`
          );
          runAutobuild(interaction.guildId, interaction.channel, candidates, count, universeChoice).catch(err => {
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
        if (!watchlist.isValidTicker(ticker)) {
          await interaction.editReply("That doesn't look like a valid ticker.");
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
          const universeChoice = interaction.options.getString("universe") || "both";
          const sample = Math.min(300, Math.max(10, interaction.options.getInteger("sample") || 100));
          const count = Math.min(50, Math.max(1, interaction.options.getInteger("count") || 15));
          watchlist.setAutobuildSchedule(interaction.guildId, {
            channelId: channel.id, intervalHours, universe: universeChoice, sample, count
          });
          await interaction.reply(
            `Scheduled autobuild on: every ${intervalHours}h, sampling ${sample} candidates from the ${universeChoice} pool, ` +
            `keeping the top ${count} most volatile, posting to ${channel}. Shares its cooldown with manual \`/watch autobuild\`, ` +
            "so running that separately will push back the next scheduled run."
          );
        } else if (sub === "off") {
          watchlist.setAutobuildSchedule(interaction.guildId, null);
          await interaction.reply("Scheduled autobuild turned off.");
        }
        break;
      }

      case "portfolio": {
        const sub = interaction.options.getSubcommand();
        if (sub === "start") {
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
          const portfolio = watchlist.getPortfolio(interaction.guildId);
          if (!portfolio) {
            await interaction.editReply("No paper portfolio running yet. Start one with `/portfolio start`.");
            break;
          }

          const symbols = Object.keys(portfolio.positions);
          const currentPrices = {};
          for (const symbol of symbols) {
            try {
              const rows = await fetchDailySeries(symbol, 5);
              if (rows.length) currentPrices[symbol] = rows[rows.length - 1].close;
            } catch (err) {
              console.error(`Portfolio status lookup failed for ${symbol}: ${err.message}`);
            }
            await sleep(PACING_MS);
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
