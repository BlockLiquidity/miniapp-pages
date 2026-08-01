# DEPLOYMENT — miniapp-pages

Static HTML/JS pages for the BlockLiquidity mini-app. Each alert type is a
standalone page (e.g. `new_trade_alert.html`, `track_trade_direction_alert.html`,
`liquidation_alert.html`) opened by **bl-telegram-bot** as a Telegram WebApp. A
page collects input and returns it to the bot via `Telegram.WebApp.sendData(...)`;
the bot forwards it to **bl-alert-manager**. This repo replaces the deprecated
`telegram-miniapp` repo.

## Where it runs
- **Host / platform:** GitHub Pages (static hosting). No server, no datastore, no
  backend of its own.
- **Public URL:** `https://blockliquidity.github.io/miniapp-pages/` (per-page, e.g.
  `.../new_trade_alert.html`). These URLs are configured as the WebApp URLs in
  bl-telegram-bot.
- **Run-as / ports:** none (static assets served by the GitHub Pages CDN).
- **External services called from the browser:**
  - the Hyperliquid public info API (`https://api.hyperliquid.xyz/info`) via
    `token-fetcher.js` to populate token pickers;
  - `https://telegram.org/js/telegram-web-app.js` for the Telegram WebApp SDK.

## How it runs
- Pure static files — no process manager, no build step (plain HTML/CSS/vanilla JS).
- **Local preview:** serve the repo root over HTTP, e.g. `python3 -m http.server 8000`,
  then open `http://localhost:8000/new_trade_alert.html`. Pages fall back to a
  console/`alert()` "simulated send" when opened outside Telegram
  (`tg.initDataUnsafe.user` is absent).
- **Logs:** none server-side; use the browser console. Deploy logs are in the repo's
  GitHub **Actions** tab.
- **Tests:** `npm install && npm test` — headless Playwright smoke tests
  (`tests/*.test.js`) that drive the real pages in Chromium and assert the exact
  `sendData` payload. They are a developer tool only; nothing in the deploy
  pipeline runs them, and `package.json` / `node_modules` are not part of the
  published site (`node_modules` is gitignored).

## How to deploy
- **CI:** `.github/workflows/static.yml` — on every push to `main` (or manual
  `workflow_dispatch`), it uploads the entire repository and deploys it to GitHub
  Pages via `actions/upload-pages-artifact` + `actions/deploy-pages`. Concurrency
  group `pages` (in-progress deploys are not cancelled).
- **Procedure:** merge the change to `main` → the "Deploy static content to Pages"
  workflow publishes automatically (usually < 1–2 min).
- **Verify:** open the deployed page URL in a browser (hard-refresh to bypass CDN
  cache) and confirm the new UI/behaviour, or open it from the bot in Telegram and
  complete a submission end-to-end. Check the Actions tab for a green run.
- **Rollback:** revert the offending commit on `main` (or re-run the workflow from a
  previous good commit) — Pages re-publishes the reverted content. There is no build
  artifact to manage.

## Dependencies & prerequisites
- No runtime/toolchain needed to build (static files).
- GitHub Pages must be enabled for the repo with the source set to "GitHub Actions".
- The bot's WebApp URLs must point at the deployed Pages URLs.

## Notes
- **Token symbols must match `node_events:fills` exactly.** Token pickers submit the
  canonical Hyperliquid coin symbol from `token-fetcher.js` (perps bare e.g. `BTC`;
  HIP-3 perps namespaced e.g. `xyz:GOOGL`), because bl-notification-core filters
  alerts by an exact string match on `fill.coin`. Do not substitute display names.
- **Not every picker can fetch its own list.** The Hyperliquid pages read their
  token universe straight from the public HL info API (`token-fetcher.js`). The
  **HyperEVM Transfer** page (`evm_transfer_alert.html`) cannot: its list is the
  `hl_evm_watched_tokens` watchlist, which lives behind bl-alert-manager's bearer
  auth, and this site holds no credentials. bl-telegram-bot therefore reads it
  server-side and hands it over in the **`t` query parameter** as base64 JSON —
  the same mechanism `manage_alerts.html` already uses for `d` (the user's
  alerts). `index.html` forwards `t` on to the page. Opened without `t` (e.g.
  straight from a browser) the picker is simply empty; the page still works for
  an "all collected tokens" subscription and the API validates either way.
- **kind 11 submits token ADDRESSES, not symbols.** Symbols are not unique on an
  EVM chain and the transfer rows carry only `token_address`, so the picker shows
  `WHYPE` but submits `0x5555…5555`. `min_usd` **replaces** `min_amount` — never
  send both.
- **`tokens` wire format is per-alert-kind.** The New Trade page (`new_trade_alert.html`)
  sends `tokens: "ALL_TOKEN"` (string) for all tokens or an array of exact symbols —
  matching bl-telegram-bot's `NewTradeParams`/`TokenFilter`. This is the **singular**
  `"ALL_TOKEN"` sentinel, distinct from the Track-Trade-Direction page's `["ALL_TOKENS"]`.
