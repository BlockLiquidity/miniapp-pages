// Headless smoke test of the kind-11 (HyperEVM Transfer) surface in
// miniapp-pages/manage_alerts.html: the list rendering and the create form.
const { chromium } = require('playwright');
const path = require('path').join(__dirname, '..', 'manage_alerts.html');

const WHYPE = '0x5555555555555555555555555555555555555555';
const NOPRICE = '0x1111111111111111111111111111111111111111';
const WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const tokens = [
  { token_address: WHYPE, symbol: 'WHYPE', decimals: 18, price_usd: 42.11 },
  { token_address: NOPRICE, symbol: 'NOPRICE', decimals: 18, price_usd: null },
];
const alerts = [
  {
    id: '900',
    kind: 11,
    extra: { address: WALLET, direction: 'OUT', tokens: [WHYPE], min_usd: 1000, name: 'Whale #1' },
  },
];

// The bot appends `d`/`t` through a URL builder, so they arrive percent-encoded:
// raw standard base64 contains `+`, which URLSearchParams would read as a space.
const b64 = (value) => encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64'));
const url = `file://${path}?d=${b64(alerts)}&t=${b64(tokens)}`;

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; } else { console.log('pass: ' + msg); }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The page loads the real Telegram WebApp SDK, which would overwrite the stub
  // below. Block it so `sendData` is observable.
  await page.route('**/telegram-web-app.js', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.addInitScript(() => {
    window.__sent = [];
    window.confirm = () => true;
    window.Telegram = {
      WebApp: {
        ready() {}, expand() {}, close() {}, themeParams: {},
        MainButton: { hide() {} },
        HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
        initDataUnsafe: { user: { id: 1 } },
        sendData(d) { window.__sent.push(d); },
      },
    };
  });
  await page.goto(url);

  // ---- the list ---------------------------------------------------------
  const card = page.locator('#card-900');
  assert(await card.isVisible(), 'a kind-11 alert renders in the list');
  const detail = await card.locator('.alert-detail').textContent();
  assert((await card.locator('.alert-title').textContent()).includes('Whale #1'),
    'the custom name is the title');
  assert(detail.includes('0xabcd…abcd'), 'the wallet is shortened: ' + detail);
  assert(detail.includes('OUT'), 'the direction is shown');
  assert(detail.includes('WHYPE'), 'token ADDRESSES are resolved to symbols: ' + detail);
  assert(!detail.includes(WHYPE), 'and the raw address is not shown');
  assert(detail.includes('min $1000'), 'the USD threshold is shown');

  assert((await page.locator('#tabs .tab', { hasText: 'HyperEVM Transfer' }).count()) === 1,
    'a HyperEVM Transfer tab appears once there is one');

  // The custom name is user-supplied and lands in innerHTML.
  await page.goto(`file://${path}?d=${b64([{ ...alerts[0], id: '901',
    extra: { ...alerts[0].extra, name: '<img src=x onerror=alert(1)>' } }])}&t=${b64(tokens)}`);
  const injected = page.locator('#card-901');
  assert((await injected.locator('.alert-title').textContent()).includes('<img'),
    'the raw name is shown as TEXT');
  assert((await injected.locator('img').count()) === 0,
    'a name carrying markup does not become an element');

  // ---- delete -----------------------------------------------------------
  // Back to the original fixture: the injection check above navigated away, and
  // a Playwright locator re-resolves against whatever page is current.
  await page.goto(url);
  await card.locator('.btn-delete').click();
  await page.waitForFunction(() => window.__sent.length > 0);
  let payload = JSON.parse((await page.evaluate(() => window.__sent))[0]);
  assert(payload.type === 'delete_alert' && payload.data.id === '900',
    'delete sends the alert id unchanged (as a string, so 64-bit ids survive)');

  // ---- create form ------------------------------------------------------
  await page.goto(url);
  await page.click('.fab-create');
  await page.click('.type-card:has-text("HyperEVM Transfer")');

  // No wallet + all collected tokens is refused.
  await page.click('#createSubmit');
  assert((await page.locator('#createError').textContent()).includes('at least one token'),
    'no-wallet + all-tokens is refused');

  // An ALL_TOKEN USD threshold with an unpriced token in the watchlist is now a
  // HINT, not a refusal — the API evaluates it against the priced subset, so
  // blocking here would refuse what the server allows.
  await page.fill('#fAddress', WALLET);
  assert((await page.locator('#evmUnpricedHint').textContent()).includes('NOPRICE'),
    'the unpriced token is named as a hint under the threshold');
  await page.click('#createSubmit');
  let submitted = JSON.parse((await page.evaluate(() => window.__sent)).pop());
  assert(submitted.data.tokens === 'ALL_TOKEN' && submitted.data.min_usd === 1000,
    'and the default ALL_TOKEN + $1000 form submits: ' + JSON.stringify(submitted.data));

  // Re-open: submitting closed the sheet.
  await page.goto(url);
  await page.click('.fab-create');
  await page.click('.type-card:has-text("HyperEVM Transfer")');
  await page.fill('#fAddress', WALLET);

  // Narrow to the priced token and submit.
  await page.click('.segmented-control[data-group="evmtokens"] .segment-option[data-seg="specific"]');
  await page.click('#tpSearch');
  await page.locator('#tpDropdown .tp-item', { hasText: 'WHYPE' }).dispatchEvent('mousedown');
  await page.click('.segmented-control[data-group="evmdir"] .segment-option[data-seg="IN"]');
  await page.click('#createSubmit');

  const sent = await page.evaluate(() => window.__sent);
  payload = JSON.parse(sent[sent.length - 1]);
  assert(payload.type === 'evm_transfer', 'the create payload type is evm_transfer');
  assert(payload.data.address === WALLET, 'the wallet is carried, lowercased');
  assert(payload.data.direction === 'IN', 'the chosen direction is carried');
  assert(Array.isArray(payload.data.tokens) && payload.data.tokens[0] === WHYPE,
    'tokens carries ADDRESSES, not symbols: ' + JSON.stringify(payload.data.tokens));
  assert(payload.data.min_usd === 1000, 'the $1000 default is sent as min_usd');
  assert(payload.data.min_amount === undefined, 'min_usd replaces min_amount');

  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
  console.log(process.exitCode ? 'RESULT: FAILURES' : 'RESULT: all checks passed');
})();
