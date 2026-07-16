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

| Command | What it does |
|---|---|
| `/watch add ticker:AAPL` | Add tickers to this server's watchlist. Accepts crypto pairs like `BTC/USD` or `BTC-USD`, and multiple at once, comma or space separated (up to 50) |
| `/watch remove ticker:AAPL` | Remove one |
| `/watch list` | Show the current watchlist |
| `/watch clear` | Remove every ticker from the watchlist |
| `/watch autobuild universe:both count:15` | **One-off**: scan 300 candidates from `stocks.txt`/`crypto.txt` for the biggest potential movers, and **replace** the watchlist with the top `count`. Runs in the background and posts results when done |
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
| `/shorts on stocks_channel:#... crypto_channel:#...` | Turn on the daily YouTube Shorts content drop — scans for today's biggest winner/loser and posts a ready-to-record HTML file: stocks at 4:00pm ET, crypto at 8:00pm ET |
| `/shorts off` | Turn off the daily Shorts drop |
| `/shorts now which:both` | Run a Shorts scan immediately instead of waiting for the schedule |

## Notes and honest limitations

- **Crypto support**: add pairs like `BTC/USD` or `BTC-USD` alongside regular stock tickers —
  same Twelve Data endpoint, same free-tier quota, no separate setup. Crypto trades 24/7 so its
  daily candles won't have the weekend gaps stocks do, but the same SMA/EMA/RSI/MACD/Bollinger
  math applies either way.
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
  tune — it always scans 300 candidates (one API request each, no way around that on the free
  tier) to actually find the biggest potential movers rather than a smaller, less representative
  slice, which takes nearly 40 minutes. It *replaces* the entire watchlist rather than merging
  into it. The 24h-per-server cooldown exists because a single run eats a large chunk of the
  daily request quota by itself. "Biggest potential movers" here means highest recent volatility
  -- the standard deviation of daily % price changes over the fetched window -- a measure of how
  much a ticker moves, not a prediction of which direction it'll move next. Candidates with a
  confirmed weak/no trend (ADX < 15) are excluded, since pure volatility with nothing behind it
  is as often a spike about to mean-revert as it is a real opportunity. Thin/illiquid candidates
  are also excluded (avg. dollar volume -- price × volume -- under $1M/day), since a handful of
  trades moving a barely-traded ticker's price isn't the same thing as a real opportunity, even
  if it shows up as "volatile." Final selection uses real correlation, not a stock/crypto label
  split: candidates are ranked by volatility, but a candidate gets skipped if its recent daily
  returns are too *positively* correlated (> 0.7) with something already picked -- strong negative
  correlation is left alone, since two assets that move opposite each other are good
  diversification, not something to avoid. This replaced an earlier version that just alternated
  between the stock and crypto pools, which was a blunt proxy: two large-cap tech stocks can move
  together just as much as two random cryptos, so a label split doesn't actually guarantee
  uncorrelated exposure the way checking real correlation does.
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
- **Signal confidence filter**: a Buy/Sell verdict only survives if it's backed by both a real
  trend (ADX >= 20, Wilder's own threshold for "trending" vs. "range-bound") and above-average
  volume (20-day average). Otherwise it's downgraded to Neutral with a note explaining why, so
  `/alerts` stays quiet on crossovers that fire during a choppy, low-conviction market. This
  trades quantity for quality — expect noticeably fewer Buy/Sell verdicts than before. It does
  **not** make signals more likely to be profitable, only less likely to be a false positive
  from a well-known failure mode (crossover indicators whipsawing in sideways markets).
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
- **`/shorts` can't fully automate posting to YouTube**: the bot can't render its own animated
  HTML into a video or upload anywhere -- doing that would mean either a headless-browser
  dependency (puppeteer, ~300MB) or a new web server + public Railway domain, both bigger
  commitments than this feature warrants. Instead, at the scheduled time the bot scans a sample
  of `stocks.txt` (4pm ET) or `crypto.txt` (8pm ET) for the day's single biggest gainer/loser and
  posts a stats embed plus the finished, self-contained HTML file as a Discord attachment --
  download it, open it locally, and screen-record the first couple seconds (the % figures count
  up and the chart draws itself in) to get your actual video clip. Uploading to YouTube stays a
  manual, human step. Each scheduled run samples 100 candidates (not the full 300 `/watch
  autobuild` uses) specifically to keep two automatic runs a day from eating too much of the
  shared 800/day request quota.
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

