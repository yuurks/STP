# Signal Deck — Discord Bot

A Discord version of the Signal Deck scanner: technical indicators (SMA, EMA, RSI, MACD,
Bollinger Bands) blended into a composite Buy/Sell verdict, delivered as slash commands and
optional scheduled posts in a channel.

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

## Commands

| Command | What it does |
|---|---|
| `/watch add ticker:AAPL` | Add tickers to this server's watchlist. Accepts crypto pairs like `BTC/USD` or `BTC-USD`, and multiple at once, comma or space separated (up to 50) |
| `/watch remove ticker:AAPL` | Remove one |
| `/watch list` | Show the current watchlist |
| `/watch clear` | Remove every ticker from the watchlist |
| `/watch autobuild universe:both sample:100 count:15` | Sample random candidates from `stocks.txt`/`crypto.txt`, rank by recent volatility, and **replace** the watchlist with the most volatile `count` of them. Runs in the background and posts results when done (once per 24h per server) |
| `/scan` | Run the scanner on the watchlist right now, posts a ranked embed |
| `/autoscan on channel:#signals interval_minutes:60` | Auto-run `/scan` on a schedule, posting the full ranked watchlist every time. Omit `interval_minutes` to use the fastest interval your watchlist size allows |
| `/autoscan off` | Turn scheduled scans off |
| `/alerts on channel:#signals interval_minutes:60` | Check on a schedule, but only post a ticker when its verdict *changes* to Buy/Sell (quiet otherwise). Omit `interval_minutes` to use the fastest interval your watchlist size allows |
| `/alerts off` | Turn signal alerts off |

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
- **`/watch autobuild` is expensive and destructive**: it uses one API request per candidate
  checked (up to 300), can take nearly 40 minutes for a full-size sample, and *replaces* the
  entire watchlist rather than merging into it. The 24h-per-server cooldown exists because a
  single large run can eat a large chunk of the daily request quota by itself. Volatility here
  is just the standard deviation of daily % price changes over the fetched window — a measure
  of how much a ticker moves, not a prediction of which direction it'll move next.
- **Gap to fill**: every scan (`/scan`, `/alerts`, `/watch autobuild`) also reports the nearest
  unfilled price gap for each ticker, if one exists — a day whose price jumped clean past the
  prior day's high/low with no trading in between. Shown as how far price still has to move,
  and in which direction, to trade back through that level. This is a purely mechanical
  reading of the candle data, not a prediction that the gap will actually get filled.
- **No order execution**: this only posts signals. Turning any of this into real trades would
  require a brokerage API (e.g. Alpaca, Interactive Brokers) and is a meaningfully bigger,
  higher-stakes project than a signal bot -- build and paper-test a strategy thoroughly first.
- **Persistence** is a flat JSON file (`data/watchlists.json`). Fine for one server or a few;
  swap in a real database if you're running this across many servers.
- Nothing here is financial advice.

