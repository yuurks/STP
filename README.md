# Signal Deck — Discord Bot

A Discord version of the Signal Deck scanner: technical indicators (SMA, EMA, RSI, MACD,
Bollinger Bands, ADX, Golden/Death Cross) blended into a composite Buy/Sell verdict, delivered
as slash commands and optional scheduled posts in a channel.

It **posts signals only** — it never places real trades and isn't connected to any brokerage.

## What you'll need

1. **A Discord bot application** — free, from the Discord Developer Portal.
2. **A market data API key** — this uses [Twelve Data](https://twelvedata.com/)'s free tier
   (800 requests/day, 8/minute). Swap `src/lib/marketData.js` for another provider if you like —
   just keep the same output shape.
3. **Somewhere to keep it running 24/7** — your own machine, a Raspberry Pi, or a free-tier
   host. A couple of notes on that last option, since free tiers change often:
   - **Railway** no longer has an ongoing free tier — it's a one-time $5 trial credit, then
     $5/month. Don't rely on it being free.
   - **Render**'s free web-service tier sleeps after 15 minutes of inactivity, which is a bad
     fit for a bot that needs to hold a persistent connection open — it'll drop offline.
   - **Fly.io** currently offers the most workable free tier for an always-on process like this
     (a few small VMs, no forced sleep). Worth checking their current limits before you commit.
   - Whatever you pick, verify their current free-tier terms yourself — these details shift
     regularly and this README can go stale.
   It won't run inside Claude.ai; this is a standalone Node process either way.
   - **Whatever host you use, attach persistent storage for `data/`.** Without it, every
     redeploy wipes your watchlist, paper portfolio, and alert history back to empty — this
     bit us once already. On Railway specifically: right-click the service box → **Attach
     volume** → mount path `/app/data` → you must then click the **Deploy** button (or
     Shift+Enter) to actually apply it, since Railway stages canvas changes rather than
     applying them immediately. Confirm it worked by checking the deploy logs for the
     `Watchlist data file: ...` line and cross-referencing it against Railway's own
     `RAILWAY_VOLUME_MOUNT_PATH` env var, not just by trusting the dashboard UI.

## Setup

### 1. Create the Discord application

1. Go to https://discord.com/developers/applications -> **New Application**.
2. Under **Bot**, click **Reset Token** and copy it -- this is your `DISCORD_TOKEN`.
3. Under **General Information**, copy the **Application ID** -- this is your `DISCORD_CLIENT_ID`.
4. Under **OAuth2 -> URL Generator**, check scopes `bot` and `applications.commands`, and under
   Bot Permissions check **Send Messages** and **Embed Links**. Open the generated URL to invite
   the bot to your server.

### 2. Install and configure

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `TWELVE_DATA_API_KEY`.

### 3. Register the slash commands (once, or whenever you edit them)

```bash
npm run deploy-commands
```

### 4. (Optional) Set the bot's avatar to your logo

`assets/logo.png` is already wired in — it shows up as a thumbnail on every `/scan` and
auto-scan embed automatically. To also make it the bot's Discord profile picture:

```bash
npm run set-avatar
```

This only needs to run once (Discord rate-limits how often an avatar can change). Swap
`assets/logo.png` for your own image any time and re-run it to update.

### 5. Run it

```bash
npm start
```

### 6. (Optional) Run the test suite

```bash
npm test
```

Uses Node's built-in test runner (`node --test`, no extra dependency), 51 tests across 16
suites. Covers the pure math in `src/lib/indicators.js` -- `findUnfilledGap`, `atr`, `adx`,
`backtest` (including a real no-lookahead check, not just a hand-wave: it runs two otherwise-
identical price series that only diverge after a cutoff day, and asserts every signal evaluated
before that day produces an identical verdict regardless of what happens afterward), `scoreAt`'s
Golden/Death Cross detection, and the `correlation`/`selectDiversified`/`avgDollarVolume`
functions behind autobuild's diversification (including a test that specifically locks in that
strong *negative* correlation should never disqualify a candidate, after an early version of
that same test caught the code initially treating positive and negative correlation the same
way). Also covers the paper-portfolio logic in `src/lib/portfolio.js` (conviction/volatility-
scaled position sizing, drawdown computation, equity-curve snapshot throttling, stop-hit vs.
sell-signal exits, and a regression test for a real bug this suite caught: a stop-out and an
unrelated same-pass Buy verdict on the same symbol could otherwise re-open the position it just
closed). It doesn't cover the Discord-facing code in `index.js` -- that still needs to be
exercised by hand in a real server.

## Commands

Anyone in the server can run the read-only ones (`/scan`, `/backtest`, `/watch list`,
`/alerts history`, `/portfolio status`). Everything that changes server-wide config or state --
`/watch add/remove/clear/autobuild`, `/autoscan`, `/autobuild`, `/shorts`, `/discover`, `/degen`,
`/alerts on/off/digest-*`, `/portfolio start/reset` -- requires the **Manage Server** Discord
permission. Discord only restricts a whole command, not individual subcommands, which is why
`/watch` is entirely Manage-Server-gated (its own `list` included) while `/alerts` and
`/portfolio` stay open at the command level and check permission in code per-subcommand instead
(`requireManageGuild` in `index.js`) -- the only way to keep `history`/`status` open while
`on`/`off`/`start`/`reset` stay gated. Adjustable via Discord's own **Server Settings → Integrations**
if you want a different role than whoever already has Manage Server.

| Command | What it does |
|---|---|
| `/watch add ticker:BTC/USD` | Add tickers to this server's watchlist (crypto pairs like `BTC/USD` or `BTC-USD`; also accepts plain stock tickers if you ever want one, just not what the bot's built around anymore), multiple at once, comma or space separated (up to 50) |
| `/watch remove ticker:BTC/USD` | Remove one |
| `/watch list` | Show the current watchlist |
| `/watch clear` | Remove every ticker from the watchlist |
| `/watch autobuild count:15` | **One-off**: scan the crypto candidate pool for the biggest potential movers, and **replace** the watchlist with the top `count`. Runs in the background and posts results when done |
| `/autobuild on channel:#signals interval_hours:24 ...` | **Recurring** version of the above — automatically reruns `/watch autobuild` on a schedule (min 24h) and posts to a channel, instead of you triggering it manually each time |
| `/autobuild off` | Turn off scheduled autobuild |
| `/scan` | Run the scanner on the watchlist right now, posts a ranked embed |
| `/autoscan on channel:#signals interval_minutes:60` | Auto-run `/scan` on a schedule, posting the full ranked watchlist every time. Omit `interval_minutes` to use the fastest interval your watchlist size allows |
| `/autoscan off` | Turn scheduled scans off |
| `/alerts on channel:#signals interval_minutes:60` | Check on a schedule, but only post a ticker when its verdict *changes* to Buy/Sell (quiet otherwise). Omit `interval_minutes` to use the fastest interval your watchlist size allows |
| `/alerts off` | Turn signal alerts off |
| `/alerts history` | **One-off**: see how past alerts *actually* performed — fetches current prices for alerts at least ~5 days old and reports real win rate / avg return per verdict type |
| `/alerts digest-on channel:#signals interval_days:7` | **Recurring** version of the above — automatically posts the alert performance report on a schedule instead of you asking for it |
| `/alerts digest-off` | Turn off the automatic alert digest |
| `/backtest ticker:AAPL forward_days:5` | Replay this bot's own signal logic day-by-day over a ticker's history (no lookahead) and report what would have happened `forward_days` later after each signal |
| `/portfolio start starting_cash:10000` | Start a simulated paper-trading portfolio (no real money) that follows this bot's own Buy/Sell signals |
| `/portfolio status` | Show current cash, open positions with live unrealized P&L, total return, and recent closed trades |
| `/portfolio reset` | Wipe the paper portfolio and start over |
| `/shorts on channel:#...` | Turn on the daily YouTube Shorts content drop — scans small/mid-cap crypto for today's single biggest winner/loser by % change, posts a ready-to-use image, twice a day (4:00pm and 8:00pm ET) |
| `/shorts off` | Turn off the daily Shorts drop |
| `/shorts now` | Run a Shorts scan immediately instead of waiting for the schedule |
| `/discover on channel:#...` | Turn on recurring scans of the crypto pool for a fresh Buy/Strong Buy (RSI/MACD/EMA scoring + confirmed ADX trend) — posts an alert only when one qualifies, so you can look and decide, default every 4h |
| `/discover off` | Turn off recurring Discover scans |
| `/discover now` | Run a Discover scan immediately instead of waiting for the schedule |
| `/degen on channel:#...` | **HIGH RISK, unvalidated** — turn on recurring scans of DexScreener's newest Solana pairs for real liquidity + real buy pressure, default every 10 min. See limitations below before using this |
| `/degen off` | Turn off recurring Degen scans |
| `/degen now` | Run a Degen scan immediately instead of waiting for the schedule |

## Notes and honest limitations

- **This bot is crypto-focused**: `/watch autobuild`, `/autobuild`, and `/shorts` all draw from
  `crypto.txt` only -- there's no stock candidate pool anymore. `/watch add` will still take a
  plain stock ticker if you ever type one in manually (the underlying scan math doesn't care what
  asset class it's fed), it's just not what anything is built around. Crypto trades 24/7 so its
  daily candles won't have the weekend gaps a stock would, but the same SMA/EMA/RSI/MACD/Bollinger
  math applies regardless.
- **Rate limits**: the free Twelve Data tier allows 8 requests/minute and 800/day. The bot paces
  requests at 7.5s apart to respect the per-minute cap. `/autoscan on` and `/alerts on` both
  reject an `interval_minutes` that would exceed the daily cap for your current watchlist size
  (and if you don't specify one, they default to the fastest interval that stays under it).
  Running both on the same server doubles API usage, since each runs its own scan. Upgrade your
  data plan if you need faster or more frequent scanning than the free tier allows.
- **Alerts fire on change, not on every check**: `/alerts` remembers each ticker's last verdict
  and only posts when it flips (e.g. Neutral -> Buy). Since indicators are computed from daily
  candles, meaningful changes typically happen at most once a day regardless of how often you
  set it to check.
- **`/watch autobuild` is expensive and destructive**: there's no user-facing "sample size" to
  tune — it always scans up to 300 candidates from the crypto pool (one API request each, no way
  around that on the free tier; `crypto.txt` currently has ~243, so in practice that's the whole
  pool) to actually find the biggest potential movers rather than a smaller, less representative
  slice, which takes up to ~30 minutes. It *replaces* the entire watchlist rather than merging
  into it. The 24h-per-server cooldown exists because a single run eats a large chunk of the
  daily request quota by itself. "Biggest potential movers" here means highest recent volatility
  -- the standard deviation of daily % price changes over the fetched window -- a measure of how
  much a ticker moves, not a prediction of which direction it'll move next. Candidates with a
  confirmed weak/no trend (ADX < 15) are excluded, since pure volatility with nothing behind it
  is as often a spike about to mean-revert as it is a real opportunity. There's deliberately no
  liquidity/thin-trading filter here: Twelve Data doesn't return volume data for crypto pairs at
  all (see the "no crypto volume data" note below), so a dollar-volume floor would silently
  exclude every single candidate rather than actually filtering anything. Final selection uses
  real correlation-based diversification:
  candidates are ranked by volatility, but a candidate gets skipped if its recent daily returns
  are too *positively* correlated (> 0.7) with something already picked -- strong negative
  correlation is left alone, since two assets that move opposite each other are good
  diversification, not something to avoid.
- **`/autobuild on` and manual `/watch autobuild` share one cooldown clock**: both write to the
  same "last run" timestamp, so triggering one pushes back when the other is next allowed to
  run. This is deliberate — it stops a scheduled and a manual run from ever overlapping and
  double-spending the daily request quota. `/backtest` isn't offered as a scheduled command: it's
  a one-ticker diagnostic, and "automating" it would mean deciding which ticker(s) to run it
  against and how to summarize the results, which felt like a call worth making explicitly
  rather than guessing at.
- **Suggested stops**: `/scan`, `/alerts`, and `/watch autobuild` show a suggested stop-loss at
  2x ATR (Average True Range) from the current price on any Buy/Sell verdict — sized to that
  ticker's own typical daily range rather than a flat percentage. It's a standard starting point
  for risk sizing, not a guarantee, and the bot doesn't track whether you'd have actually hit it.
- **Gap to fill**: every scan (`/scan`, `/alerts`, `/watch autobuild`) also reports the nearest
  unfilled price gap for each ticker, if one exists — a day whose price jumped clean past the
  prior day's high/low with no trading in between. Shown as how far price still has to move,
  and in which direction, to trade back through that level. This is a purely mechanical
  reading of the candle data, not a prediction that the gap will actually get filled.
- **Signal confidence filter**: a Buy/Sell verdict only survives if it's backed by a real trend
  (ADX >= 20, Wilder's own threshold for "trending" vs. "range-bound"). Otherwise it's downgraded
  to Neutral with a note explaining why, so `/alerts` stays quiet on crossovers that fire during a
  choppy, low-conviction market. This trades quantity for quality — expect noticeably fewer
  Buy/Sell verdicts than before. It does **not** make signals more likely to be profitable, only
  less likely to be a false positive from a well-known failure mode (crossover indicators
  whipsawing in sideways markets). The filter also has an above-average-volume check in its code
  (`applyConfidenceFilter` in `indicators.js`), but it's a silent no-op for every symbol this bot
  actually scans now: Twelve Data returns 0 for crypto volume, and 0 is never less than 0, so the
  check can never trigger. It would still work correctly if you manually watch a stock ticker
  (Twelve Data does provide real volume there) -- see "No crypto volume data" below.
- **Golden Cross / Death Cross**: the 50-day SMA crossing the 200-day SMA, a specifically-named,
  widely-watched longer-horizon signal distinct from the faster 20/50 SMA pair already used
  elsewhere in the score. Needs ~200 days of history to ever fire (the default fetch window was
  bumped from 120 to 250 days specifically for this) -- newer tickers without that much history
  just won't show it, same graceful "not enough data" behavior as every other indicator here.
- **`/backtest` and `/alerts history` are the only things that actually validate this bot** —
  everything else is textbook indicator theory that sounds reasonable but has never been checked
  against real outcomes. `/backtest` replays history fast but on necessarily small samples
  (a single ticker's fetched window rarely produces more than a handful of qualifying signals,
  given how selective the confidence filter is). `/alerts history` is slower to build up (needs
  real time to pass) but measures actual forward performance, not a simulation. Neither is
  statistical proof of anything — treat both as a rough, honest gut-check, not validation.
  Both are stop-aware: they walk day-by-day through the time since the signal fired and check
  whether the same 2x-ATR stop shown in `/scan` would have been hit first, scoring the outcome
  at the stop price rather than the latest close if so (shown as "Stopped out: X/N" per verdict
  type). `/alerts history` can only do this for alerts fired after ATR started being logged
  alongside them — older log entries fall back to a plain latest-price-vs-fired-price comparison.
- **`/shorts` can't fully automate posting to YouTube**: at the scheduled time (4pm and 8pm ET,
  both) the bot scans a sample of small/mid-cap crypto for the day's single biggest gainer/loser,
  renders the result as a 1080x1920 PNG (built as SVG server-side and rasterized with `sharp`, not
  a headless browser -- puppeteer was ruled out early on as too heavy, ~300MB, for what this
  needs), and posts it directly as a Discord image. Turning that into an actual uploaded YouTube
  Short and posting it still needs a human -- the bot won't ever render/mux video or touch
  YouTube's API on its own. Each scheduled run samples 100 candidates (not the full 300 `/watch
  autobuild` uses) specifically to keep two automatic runs a day from eating too much of the
  shared 800/day request quota. A separate manual pipeline (`scripts/find-movers.js` +
  `scripts/generate-short.js`) still produces an animated, interactive HTML version of the same
  visual (count-up numbers, self-drawing chart) for when you want something to screen-record
  instead of a static image.
- **`/shorts` is crypto-only, skewed toward small/mid-cap**: `crypto.txt` is compiled roughly
  biggest-to-smallest by market cap, so the scan pool skips the top ~50 entries (the majors) and
  samples from the rest -- an approximation, not real live market-cap data (Twelve Data's free
  tier doesn't expose one). Honest limitation: Twelve Data's free crypto coverage thins out fast
  past the majors, so a real chunk of each sample (often a third or more) returns no data at all
  and gets skipped -- the "checked" count will run noticeably lower than the candidate count.
- **No crypto volume data**: confirmed 2026-07-22, across `time_series`, `quote`, and
  `time_series` with an explicit `exchange` param -- Twelve Data simply does not return volume
  for crypto pairs. Not a free-tier restriction; the field is absent or reads 0 everywhere tried.
  This is a real limitation, not a design choice: `/shorts` originally tried to prioritize a
  volume *surge* (today's volume vs. a coin's own recent normal) when picking the winner/loser,
  and `/watch autobuild` originally excluded thin-volume candidates below a dollar-volume floor --
  both were silently broken by this (the surge check always read as 0, and the liquidity floor
  excluded every single candidate, every run) until caught and removed. `/discover` (below) was
  designed and built with a volume-surge requirement too, cut before ever shipping once this was
  confirmed. If a real crypto volume data source ever gets integrated (e.g. CoinGecko has one),
  all three are the places to revisit.
- **`/discover` alerts on trend + score alone, not volume**: scans a sample of the crypto pool
  (default 50 candidates, configurable interval, default every 4h) using the same RSI/MACD/EMA
  scoring and ADX trend confirmation `/scan` and `/alerts` use, and posts an alert the first time
  a symbol transitions into Buy/Strong Buy (edge-triggered, like `/alerts` -- won't re-alert every
  run it stays there). This flags coins worth a manual look, not a prediction of future profit --
  see the "No crypto volume data" note above for why volume isn't part of the check despite being
  originally requested. Tracks verdicts in its own storage bucket, separate from the watchlist's,
  so a `/scan` on a symbol that's also on your watchlist doesn't suppress a `/discover` alert on
  it (or vice versa).
- **`/degen` is a fundamentally different, much higher-risk feature -- read this before turning
  it on**: this bot's entire indicator engine (RSI/MACD/ADX/SMA/EMA) needs a historical time
  series of past prices, and Twelve Data simply has no coverage of brand-new tokens like
  Solana meme/pump.fun coins at all. `/degen` uses [DexScreener's free API](https://docs.dexscreener.com/api/reference)
  instead (no key needed, 60 req/min, entirely separate from Twelve Data's 800/day -- doesn't
  compete with any other feature's quota) -- but that API only exposes a live snapshot (current
  price, liquidity, and buy/sell counts over rolling 5m/1h/6h/24h windows), never historical
  candles. So `/degen` can't run the RSI/MACD/ADX engine at all -- it's a different model
  entirely: liquidity (≥$5K), market cap (≥$50K), and real buy pressure (≥2x buys/sells over the
  last hour, with a minimum trade count so the ratio isn't computed from a handful of trades),
  over a pair age under 48h (all in `src/lib/degen.js`). It scans DexScreener's rolling feed of
  newly-profiled Solana tokens (`/token-profiles/latest/v1`, filtered client-side to
  `chainId === "solana"`) -- a feed of the last ~15-30 minutes of activity, not an archive, and
  only tokens whose creator submitted profile metadata, not literally every pair that launches.
  **This can never be backtested** -- `/backtest` works by replaying real history, and there is
  no history for a token that's existed for an hour, so this is permanently unvalidated by
  design, more so than anything else in this bot.
- **`/degen`'s risk screen reduces exposure to known rug-pull patterns -- it cannot guarantee a
  token isn't a scam**: candidates that clear the liquidity/market-cap/buy-pressure filters above
  get one more check via [RugCheck's free API](https://api.rugcheck.xyz/swagger/index.html) (no
  key, 3 req/sec, only called for the few candidates that already look promising, so this stays
  cheap): reject if RugCheck has already flagged the token as rugged, if mint or freeze authority
  wasn't renounced (either lets the deployer inflate supply or freeze holder accounts), if
  RugCheck detected a connected/insider wallet cluster, if RugCheck's own 0-100 risk score exceeds
  50 (`MAX_RUGCHECK_SCORE` -- a judgment call, not a documented threshold; legitimate tokens
  checked during development scored in the low single digits), or if any single wallet holds more
  than 20% of supply (`MAX_TOP_HOLDER_PCT` -- catches concentration RugCheck's own score doesn't
  always flag: a real copycat token found during testing held 42% in one wallet and still scored
  as "safe"). Verified working end-to-end against live data: a token that passed every DexScreener
  filter got correctly rejected by this screen for a detected insider wallet cluster. None of
  this is a safety guarantee -- a coordinated team can pass every check here and still dump on
  holders. Every alert links to the pair's DexScreener page so you can look at the actual
  chart/holders yourself before doing anything -- treat that as mandatory, not optional.
- **No real order execution**: `/portfolio` simulates trading (see below), but it is not
  connected to any brokerage and never risks real money. Turning this into real automated
  trades would require a brokerage API (e.g. Alpaca, Interactive Brokers), real capital at risk
  with no human confirming each order, and is a meaningfully bigger, higher-stakes project than
  anything else in this repo -- if you ever go there, paper-trade with that brokerage's own
  paper account first, not real funds, no matter how good `/backtest` or `/portfolio` look.
- **`/portfolio` is a paper-trading simulator, long-only**: it mechanically opens a simulated
  position on every Buy/Strong Buy (sized at 20% of current simulated cash, up to 8 concurrent
  positions) and closes it on a Sell/Strong Sell verdict or a 2x-ATR stop hit, whichever comes
  first -- same stop shown in `/scan`. It does **not** open short positions on Sell signals. It
  only advances when this server's watchlist actually gets scanned (via `/scan`, `/autoscan`, or
  `/alerts`) -- with nothing scheduled, positions won't move until you check. `/portfolio status`
  additionally re-fetches and re-checks every currently *held* position on its own regardless of
  whether it's still on the watchlist, specifically so a position can still hit its stop or a
  sell signal even after its ticker gets removed (or replaced entirely by `/watch autobuild`) --
  otherwise it would just sit open forever, since no scan would ever look at that symbol again.
  `/portfolio start` refuses to run if a portfolio is already active, to avoid silently wiping
  its history -- run `/portfolio reset` first if you actually want to restart.
- **Position sizing scales with conviction and volatility, not a flat percentage**: a base 20%
  of current cash is scaled up for higher-conviction signals (score magnitude, so a Strong Buy
  gets more than a bare Buy) and scaled down for more volatile tickers (so a wild mover and a
  calm one don't end up carrying the same dollar risk just because they got the same dollar
  size) -- capped at 40% of cash per position either way, and 8 concurrent positions max. This
  is still a simple, hand-picked formula, not a rigorously risk-optimized one -- it exists so the
  simulation's position sizes track the bot's own stated confidence, not so it reflects
  professional portfolio-construction practice.
- **`/portfolio status` shows max drawdown, not just current return**: a portfolio snapshot gets
  recorded (at most once/hour) every time the watchlist is scanned, building an equity curve that
  `/portfolio status` reduces to max drawdown (the worst peak-to-trough decline ever recorded)
  and current drawdown (how far below the all-time peak it sits right now). A steady climb to
  +5% and a wild +30%-then--25%-then-+5% ride look identical if you only look at the current
  return number -- drawdown is what actually tells those two apart, and it's the number that
  matters most before ever considering real money.
- **Persistence** is a flat JSON file (`data/watchlists.json`). Fine for one server or a few;
  swap in a real database if you're running this across many servers.
- Nothing here is financial advice.

