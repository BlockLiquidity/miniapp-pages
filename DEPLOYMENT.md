# DEPLOYMENT — miniapp-pages

Static HTML/JS pages for the BlockLiquidity mini-app. Each alert type is a
standalone page (e.g. `new_trade_alert.html`, `track_trade_direction_alert.html`,
`liquidation_alert.html`) opened by **bl-telegram-bot** as a Telegram WebApp. A
page collects input and returns it to the bot via `Telegram.WebApp.sendData(...)`;
the bot forwards it to **bl-alert-manager**. This repo replaces the deprecated
`telegram-miniapp` repo.

## Where it runs (since 2026-08-24)
- **Host / platform:** nginx on the **frontend-dev EC2** (`i-09cff225544276b46`, 13.196.43.235),
  vhost `/etc/nginx/sites-available/miniapp-pages`, docroot `/opt/miniapp-pages/current`
  (an rsync target, not a git checkout), behind **CloudFront** distribution `E44UYC083ZCGI`.
- **Public URL:** `https://dsxx57hefy9jg.cloudfront.net/` (per-page, e.g.
  `.../new_trade_alert.html`; extensionless paths like `/new_trade_alert` also work via
  nginx `try_files $uri $uri.html` — the bot links some pages without the suffix).
  These URLs are configured as the WebApp URLs in bl-telegram-bot (`MINIAPP_BASE_URL`).
- **Public access / DDoS:** the instance SG admits :80 only from CloudFront's origin-facing
  prefix list (`pl-58a04531`) — the origin is not directly reachable. AWS Shield Standard and
  CloudFront edge caching absorb floods; nginx adds a 10 r/s per-viewer `limit_req`
  (keyed on `CloudFront-Viewer-Address`) and only GET/HEAD are allowed. Origin sends
  `Cache-Control: max-age=300`; deploys invalidate the edge cache anyway.
- Replaces GitHub Pages (`static.yml`), which stopped publishing when org GitHub Actions
  were billing-blocked on 2026-08-21. The old `blockliquidity.github.io/miniapp-pages`
  site may still serve a stale copy until Pages is disabled by a repo admin.
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
- **Logs:** nginx access/error logs on the frontend-dev EC2; deploy logs in the Jenkins job
  (below).
- **Tests:** `npm ci && npm test` — headless Playwright smoke tests
  (`tests/*.test.js`) that drive the real pages in Chromium and assert the exact
  `sendData` payload. **They gate pull requests** (Jenkins PR check since 2026-10-28, see CI
  below); they used to be a developer tool nothing ran. Needs Node ≥ 20 (what the
  pinned Playwright requires) — the Playwright container used in CI already has
  it. `package.json` / `node_modules` are not part of the published site
  (`node_modules` is gitignored; `package-lock.json` is committed, and both are
  harmless in the Pages artefact, which uploads the whole repo).

## How to deploy — Jenkins (automatic on push to `main`)

Jenkins job **`miniapp-pages-deploy`** on the full-auto Jenkins
(https://full-auto.ddns.net:9999/job/miniapp-pages-deploy/), webhook-triggered with a 10-min
poll fallback: `git archive` of `main` → SSH to the EC2 (deploy key
`/opt/deploy-keys/frontend-dev-ec2.pem`) → rsync into `/opt/miniapp-pages/current`
(stamps `.deployed-commit`) → verify the vhost serves 200 → CloudFront invalidation
(`aws-deploy` credential) → verify the edge serves 200.

## CI — Jenkins PR check (since 2026-10-28)

Every pull request (built merged with its base) and every push to `main` runs `Jenkinsfile.ci` on the self-hosted
Jenkins: multibranch job [`miniapp-pages-pr-check`](https://deploy.blockliquidity.xyz/job/miniapp-pages-pr-check/). The result is the
GitHub commit status **`continuous-integration/jenkins/pr-merge`** on PRs (`.../branch` on trunk pushes).
It replaced `.github/workflows/ci.yml` (ClickUp 1243juph7mm); org GitHub Actions had been unreliable/billing-blocked.

- **Gates:** `npm ci` → `npm test` (headless Playwright page tests).
- **Where:** the isolated `ci-untrusted` EC2 spot agent (single use, no deploy keys, no instance profile,
  no Jenkins credentials), inside a digest-pinned `mcr.microsoft.com/playwright:v1.62.1-noble` container, as the Jenkins user
  `pr-check-runner-miniapp-pages`. Checkout uses that user's read-only repo deploy key.
- **`Jenkinsfile.ci` is not a deploy file** — keep deploy steps and credentials out of it. Only the Pipeline
  steps on the bl-build-identity allowlist work in it.
- **Re-run:** push to the PR, or Jenkins → `miniapp-pages-pr-check` → `PR-<n>` → *Build Now*. A PR opened before
  `Jenkinsfile.ci` reached its base gets the check after a rebase / base merge.
- Pattern, template and job config: bl-database `apps/jenkins-controller/pr-check/`.
- ⚠️ **The CI image tag and the `playwright` version in `package.json` must
  match exactly.** That is why the dependency is pinned to `1.62.1` rather than
  `^1.49.0`: a caret drifts away from whatever tag `Jenkinsfile.ci` names, and the
  browser in the image stops matching the client driving it. Bump both in the
  same commit (`CI_IMAGE` in `Jenkinsfile.ci`, with its new digest), and check the tag exists
  (`curl -s https://mcr.microsoft.com/v2/playwright/tags/list`).
- **`package-lock.json` is committed** so `npm ci` has something to install
  from. `npm ci` fails without it.
- Before 2026-10-28 the GitHub workflow targeted a self-hosted runner that was never
  registered, so these tests never actually ran on CI.

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
- **A token `symbol` is untrusted.** Anyone can deploy an ERC-20 and get it past
  `hl-evm-watchlist-populator`'s volume/liquidity floors, so a symbol is
  attacker-chosen text that lands in `innerHTML`. Every interpolation in
  `manage_alerts.html`'s `setupTokenPicker` goes through `esc()`;
  `evm_transfer_alert.html` builds its rows with `textContent` and must keep
  doing so. `tests/token_picker.test.js` fails if either regresses.
- **`t` may be incomplete — check `tn`/`dn`.** bl-telegram-bot caps the WebApp
  URL at 3900 characters and sends `tn` (real token count) / `dn` (real alert
  count) **only when it had to truncate**. Absent means "complete list", which is
  why these pages could be updated after the bot shipped. When `tn` is present
  the picker shows "Showing N of TN…" and the user can **paste a contract
  address** to select a token that is not in the list — the API validates it
  regardless and queues an uncollected one, so it is a working path.
- **An unpriced token is a hint, not an error, for "all collected tokens".**
  `bl-alert-manager` evaluates an ALL_TOKEN USD threshold against the priced
  subset, so blocking the form would refuse what the server accepts — and would
  break the DEFAULT form for everyone over a token the user never chose. Naming
  a specific unpriced token is still a hard error, and "all collected tokens"
  with nothing priced at all is still refused. Both pages mirror the API here; if
  the API's rule V6 changes, these two checks change with it.
- **`tokens` wire format is per-alert-kind.** The New Trade page (`new_trade_alert.html`)
  sends `tokens: "ALL_TOKEN"` (string) for all tokens or an array of exact symbols —
  matching bl-telegram-bot's `NewTradeParams`/`TokenFilter`. This is the **singular**
  `"ALL_TOKEN"` sentinel, distinct from the Track-Trade-Direction page's `["ALL_TOKENS"]`.
