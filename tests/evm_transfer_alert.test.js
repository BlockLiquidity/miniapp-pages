// Headless smoke test of miniapp-pages/evm_transfer_alert.html:
// drives the real page and asserts the exact sendData payload.
const { chromium } = require('playwright');
const path = require('path').join(__dirname, '..', 'evm_transfer_alert.html');

const WHYPE = '0x5555555555555555555555555555555555555555';
const NOPRICE = '0x1111111111111111111111111111111111111111';
const WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const tokens = [
  { token_address: WHYPE, symbol: 'WHYPE', decimals: 18, price_usd: 42.11 },
  { token_address: NOPRICE, symbol: 'NOPRICE', decimals: 18, price_usd: null },
];
// The bot appends `t` through a URL builder, so it arrives percent-encoded:
// raw standard base64 contains `+`, which URLSearchParams would read as a space.
const b64 = (value) => encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64'));
const t = b64(tokens);

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; } else { console.log('pass: ' + msg); } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The page loads the real Telegram WebApp SDK, which would overwrite the stub
  // below. Block it so `sendData` is observable.
  await page.route('**/telegram-web-app.js', (route) => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.addInitScript(() => {
    window.__sent = [];
    window.Telegram = {
      WebApp: {
        ready() {}, expand() {}, MainButton: { hide() {} },
        HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
        initDataUnsafe: { user: { id: 1 } },
        sendData(d) { window.__sent.push(d); },
      },
    };
  });
  await page.goto(`file://${path}?t=${t}`);

  // 1. Direction is hidden until a wallet is entered.
  assert(await page.locator('#directionSection').isHidden(), 'direction hidden with no wallet');

  // 2. No wallet + all tokens is refused (the API rejects it outright).
  await page.click('#submitBtn');
  assert(await page.locator('#scopeError').isVisible(), 'no-wallet + all-tokens is refused, visibly');
  assert((await page.evaluate(() => window.__sent.length)) === 0, 'nothing submitted on a refusal');

  // 3. A bad address is caught.
  await page.fill('#address', '0xnope');
  assert(await page.locator('#directionSection').isVisible(), 'direction appears once a wallet is typed');
  await page.click('#submitBtn');
  assert(await page.locator('#addressError').isVisible(), 'a malformed address is refused');

  // 4. Happy path: wallet + OUT + all tokens + $1000 (the pre-filled default).
  //    Reloaded with a fully-priced watchlist: with an unpriced token in scope a
  //    USD threshold is (correctly) refused, which case 5 covers.
  await page.goto(`file://${path}?t=${b64([tokens[0]])}`);
  await page.fill('#address', WALLET.toUpperCase().replace('0X', '0x'));
  await page.click('#directionControl .segment-option[data-value="OUT"]');
  await page.click('#submitBtn');
  let sent = await page.evaluate(() => window.__sent);
  assert(sent.length === 1, 'a valid form submits exactly once');
  let payload = JSON.parse(sent[0]);
  assert(payload.type === 'evm_transfer', 'payload type is evm_transfer');
  assert(payload.data.address === WALLET, 'address is lowercased: ' + payload.data.address);
  assert(payload.data.direction === 'OUT', 'direction is carried');
  assert(payload.data.tokens === 'ALL_TOKEN', 'all tokens is the ALL_TOKEN string');
  assert(payload.data.min_usd === 1000, 'the $1000 default is sent as min_usd');
  assert(payload.data.min_amount === undefined, 'min_usd replaces min_amount');

  // 5. A USD threshold over an unpriced token is refused with its symbol named.
  await page.goto(`file://${path}?t=${t}`);
  await page.fill('#address', WALLET);
  await page.uncheck('#allTokensToggle');
  await page.click('#tokenSearch');
  await page.locator('#dropdownList .dropdown-item', { hasText: 'NOPRICE' }).dispatchEvent('mousedown');
  await page.click('#submitBtn');
  assert(await page.locator('#thresholdError').isVisible(), 'a USD threshold on an unpriced token is refused');
  assert((await page.locator('#thresholdError').textContent()).includes('NOPRICE'), 'the refusal names the token');

  // 6. ...but a token-amount threshold on that same token goes through.
  await page.click('#unitControl .segment-option[data-value="amount"]');
  await page.fill('#threshold', '250');
  await page.click('#submitBtn');
  sent = await page.evaluate(() => window.__sent);
  payload = JSON.parse(sent[sent.length - 1]);
  assert(payload.data.min_amount === 250, 'a token amount is sent as min_amount');
  assert(payload.data.min_usd === undefined, 'no min_usd alongside it');
  assert(Array.isArray(payload.data.tokens) && payload.data.tokens[0] === NOPRICE,
    'tokens carries ADDRESSES, not symbols: ' + JSON.stringify(payload.data.tokens));

  // 7. A token-only subscription omits the wallet (and the direction with it).
  await page.goto(`file://${path}?t=${t}`);
  await page.uncheck('#allTokensToggle');
  await page.click('#tokenSearch');
  await page.locator('#dropdownList .dropdown-item', { hasText: 'WHYPE' }).dispatchEvent('mousedown');
  await page.click('#submitBtn');
  sent = await page.evaluate(() => window.__sent);
  payload = JSON.parse(sent[sent.length - 1]);
  assert(payload.data.address === undefined, 'a token-only subscription omits the address');
  assert(payload.data.direction === undefined, 'and omits the direction');

  // 8. The native-HYPE boundary is stated on the page.
  assert((await page.locator('.coverage-notice').textContent()).includes('Native HYPE'),
    'the native-HYPE boundary is stated');

  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
  console.log(process.exitCode ? 'RESULT: FAILURES' : 'RESULT: all checks passed');
})();
