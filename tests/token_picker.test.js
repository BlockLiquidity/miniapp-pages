// Regression tests for the kind-11 token picker on BOTH surfaces:
// manage_alerts.html (the Create sheet) and evm_transfer_alert.html.
//
// Three things are checked here, all of which the picker got wrong or lacked:
//
//  1. **Escaping.** A token `symbol` is chosen by whoever deployed the ERC-20,
//     and `manage_alerts.html` interpolated it straight into `innerHTML`.
//     Mirrors the existing `renderAlerts` escaping check on the alert name.
//  2. **Truncation notices.** `?t=` is capped by bl-telegram-bot, which sends
//     `tn`/`dn` with the real totals when it had to cut the list down.
//  3. **Contract-address free entry.** The way a user reaches a collected token
//     that fell outside the cap.
const { chromium } = require('playwright');
const managePath = require('path').join(__dirname, '..', 'manage_alerts.html');
const createPath = require('path').join(__dirname, '..', 'evm_transfer_alert.html');

const WHYPE = '0x5555555555555555555555555555555555555555';
const HOSTILE = '0x2222222222222222222222222222222222222222';
const UNLISTED = '0x3333333333333333333333333333333333333333';
const NOPRICE = '0x1111111111111111111111111111111111111111';
const WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const XSS = '<img src=x onerror=alert(1)>';

const tokens = [
  { token_address: WHYPE, symbol: 'WHYPE', price_usd: 42.11 },
  { token_address: HOSTILE, symbol: XSS, price_usd: 1.0 },
  { token_address: NOPRICE, symbol: 'NOPRICE', price_usd: null },
];

// The bot appends `d`/`t` through a URL builder, so they arrive percent-encoded:
// raw standard base64 contains `+`, which URLSearchParams would read as a space.
const b64 = (value) => encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64'));

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; } else { console.log('pass: ' + msg); }
};

// Both pages load the real Telegram WebApp SDK, which would overwrite the stub.
async function stubTelegram(page) {
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
}

// Open manage_alerts.html straight into the kind-11 create form with the token
// picker showing.
async function openEvmCreateForm(page, query) {
  await page.goto(`file://${managePath}?${query}`);
  await page.click('.fab-create');
  await page.click('.type-card:has-text("HyperEVM Transfer")');
  await page.click('.segmented-control[data-group="evmtokens"] .segment-option[data-seg="specific"]');
  await page.click('#tpSearch');
}

(async () => {
  const browser = await chromium.launch();

  // ======================================================================
  // manage_alerts.html
  // ======================================================================
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await stubTelegram(page);

    await openEvmCreateForm(page, `d=${b64([])}&t=${b64(tokens)}`);

    // ---- 1. escaping, dropdown -----------------------------------------
    const hostileItem = page.locator('#tpDropdown .tp-item', { hasText: '<img' });
    assert((await hostileItem.count()) === 1, 'the hostile symbol renders as one dropdown row');
    assert((await hostileItem.textContent()).includes(XSS),
      'the hostile symbol is shown verbatim as TEXT');
    assert((await page.locator('#tpDropdown img').count()) === 0,
      'a symbol carrying markup does not become an element in the dropdown');

    // ---- 2. escaping, chips ---------------------------------------------
    await hostileItem.dispatchEvent('mousedown');
    assert((await page.locator('#tpChips .tp-chip').first().textContent()).includes(XSS),
      'the hostile symbol is shown verbatim in the chip');
    assert((await page.locator('#tpChips img').count()) === 0,
      'a symbol carrying markup does not become an element in the chips');
    assert((await page.locator('img').count()) === 0, 'no injected <img> anywhere on the page');

    // The chip must still be removable — escaping `data-t` must not break the
    // round trip through the dataset.
    await page.locator('#tpChips .tp-x').first().click();
    assert((await page.locator('#tpChips .tp-chip').count()) === 0, 'the chip is removable');

    assert(errors.length === 0, 'no page errors from the hostile symbol: ' + errors.join(' | '));

    // ---- 3. the picker still selects a normal token ---------------------
    await page.click('#tpSearch');
    await page.locator('#tpDropdown .tp-item', { hasText: 'WHYPE' }).dispatchEvent('mousedown');
    await page.fill('#fAddress', WALLET);
    await page.click('#createSubmit');
    let payload = JSON.parse((await page.evaluate(() => window.__sent)).pop());
    assert(payload.data.tokens.length === 1 && payload.data.tokens[0] === WHYPE,
      'a normal token still selects and submits: ' + JSON.stringify(payload.data.tokens));

    // ---- 4. contract-address free entry --------------------------------
    await openEvmCreateForm(page, `d=${b64([])}&t=${b64(tokens)}&tn=200`);
    await page.fill('#tpSearch', UNLISTED);
    const pasted = page.locator('#tpDropdown .tp-item', { hasText: UNLISTED.slice(0, 8) });
    assert((await pasted.count()) === 1, 'an address that is not in the list is offered');
    await pasted.dispatchEvent('mousedown');
    await page.fill('#fAddress', WALLET);
    await page.click('#createSubmit');
    payload = JSON.parse((await page.evaluate(() => window.__sent)).pop());
    assert(payload.data.tokens.includes(UNLISTED),
      'the pasted address is submitted: ' + JSON.stringify(payload.data.tokens));

    // A collected token typed by address must not be offered twice.
    await openEvmCreateForm(page, `d=${b64([])}&t=${b64(tokens)}`);
    await page.fill('#tpSearch', WHYPE);
    assert((await page.locator('#tpDropdown .tp-item').count()) === 1,
      'an address already in the list is offered once, not duplicated');

    // Anything that is not a well-formed address offers nothing.
    await page.fill('#tpSearch', '0xnothex');
    assert((await page.locator('#tpDropdown .tp-item:not(.tp-empty)').count()) === 0,
      'a malformed address offers no row');

    // ---- 5. truncation notices ------------------------------------------
    await openEvmCreateForm(page, `d=${b64([])}&t=${b64(tokens)}&tn=200`);
    const tnNotice = await page.locator('#evmTruncated').textContent();
    assert(tnNotice.includes('Showing 3 of 200'), 'the picker states the real total: ' + tnNotice);
    assert(tnNotice.toLowerCase().includes('contract address'),
      'and says how to reach a token that is not listed');

    await openEvmCreateForm(page, `d=${b64([])}&t=${b64(tokens)}`);
    assert((await page.locator('#evmTruncated').count()) === 0,
      'no `tn` means no notice — the list is complete');

    const alerts = [{ id: '900', kind: 11, extra: { address: WALLET, direction: 'BOTH', min_amount: 1 } }];
    await page.goto(`file://${managePath}?d=${b64(alerts)}&t=${b64(tokens)}&dn=42`);
    const dnNotice = await page.locator('#alertsTruncated').textContent();
    assert(dnNotice.includes('Showing 1 of 42'), 'the alert list states the real total: ' + dnNotice);
    assert(dnNotice.toLowerCase().includes('website'), 'and points at the website');

    await page.goto(`file://${managePath}?d=${b64(alerts)}&t=${b64(tokens)}`);
    assert((await page.locator('#alertsTruncated').count()) === 0, 'no `dn` means no notice');

    // ---- 6. the unpriced check is a hint for ALL_TOKEN -------------------
    // The API now accepts an ALL_TOKEN USD threshold against the priced subset,
    // so blocking here would refuse what the server allows.
    await page.goto(`file://${managePath}?d=${b64([])}&t=${b64(tokens)}`);
    await page.click('.fab-create');
    await page.click('.type-card:has-text("HyperEVM Transfer")');
    await page.fill('#fAddress', WALLET);
    const hint = await page.locator('#evmUnpricedHint').textContent();
    assert(hint.includes('NOPRICE'), 'the hint names the unpriced token: ' + hint);
    await page.click('#createSubmit');
    payload = JSON.parse((await page.evaluate(() => window.__sent)).pop());
    assert(payload.data.tokens === 'ALL_TOKEN' && payload.data.min_usd === 1000,
      'the default ALL_TOKEN + $1000 form submits: ' + JSON.stringify(payload.data));

    // …but naming the unpriced token explicitly still blocks, mirroring the API.
    await openEvmCreateForm(page, `d=${b64([])}&t=${b64(tokens)}`);
    await page.locator('#tpDropdown .tp-item', { hasText: 'NOPRICE' }).dispatchEvent('mousedown');
    await page.fill('#fAddress', WALLET);
    await page.click('#createSubmit');
    assert((await page.locator('#createError').textContent()).includes('NOPRICE'),
      'explicitly selecting the unpriced token is still refused by name');

    assert(errors.length === 0, 'no page errors overall: ' + errors.join(' | '));
    await page.close();
  }

  // ======================================================================
  // evm_transfer_alert.html
  // ======================================================================
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await stubTelegram(page);

    // This page builds its rows with textContent, so escaping is already
    // correct — asserted so a refactor to innerHTML cannot pass unnoticed.
    await page.goto(`file://${createPath}?t=${b64(tokens)}`);
    await page.click('#allTokensToggle');
    await page.click('#tokenSearch');
    assert((await page.locator('#dropdownList img').count()) === 0,
      'standalone page: a symbol carrying markup does not become an element');
    assert((await page.locator('#dropdownList .dropdown-item', { hasText: '<img' }).count()) === 1,
      'standalone page: the hostile symbol is shown verbatim');

    // ---- truncation notice ----------------------------------------------
    await page.goto(`file://${createPath}?t=${b64(tokens)}&tn=200`);
    const notice = await page.locator('#tokensTruncated').textContent();
    assert(notice.includes('Showing 3 of 200'), 'standalone page states the real total: ' + notice);

    await page.goto(`file://${createPath}?t=${b64(tokens)}`);
    assert(!(await page.locator('#tokensTruncated').isVisible()),
      'standalone page: no `tn` means no notice');

    // ---- contract-address free entry -------------------------------------
    await page.goto(`file://${createPath}?t=${b64(tokens)}&tn=200`);
    await page.click('#allTokensToggle');
    await page.fill('#tokenSearch', UNLISTED);
    const pasted = page.locator('#dropdownList .dropdown-item', { hasText: UNLISTED.slice(0, 8) });
    assert((await pasted.count()) === 1, 'standalone page offers an unlisted address');
    await pasted.dispatchEvent('mousedown');
    await page.fill('#address', WALLET);
    await page.click('#submitBtn');
    let payload = JSON.parse((await page.evaluate(() => window.__sent)).pop());
    assert(payload.data.tokens.includes(UNLISTED),
      'standalone page submits the pasted address: ' + JSON.stringify(payload.data.tokens));

    await page.fill('#tokenSearch', 'not-an-address');
    assert((await page.locator('#dropdownList .dropdown-item:not(.no-results)').count()) === 0,
      'standalone page: a malformed address offers no row');

    // ---- the unpriced check is a hint for ALL_TOKEN ----------------------
    await page.goto(`file://${createPath}?t=${b64(tokens)}`);
    await page.fill('#address', WALLET);
    const hint = await page.locator('#unpricedHint').textContent();
    assert(hint.includes('NOPRICE'), 'standalone page hint names the unpriced token: ' + hint);
    // The hint is ALL_TOKEN-only, so it has to follow the scope toggle.
    await page.click('#allTokensToggle');
    assert(!(await page.locator('#unpricedHint').isVisible()),
      'standalone page: the hint clears when the scope stops being all-collected');
    await page.click('#allTokensToggle');
    assert(await page.locator('#unpricedHint').isVisible(),
      'standalone page: and returns when it goes back');
    await page.click('#submitBtn');
    payload = JSON.parse((await page.evaluate(() => window.__sent)).pop());
    assert(payload.data.tokens === 'ALL_TOKEN' && payload.data.min_usd === 1000,
      'standalone page: the default form submits: ' + JSON.stringify(payload.data));

    // …but naming the unpriced token explicitly still blocks.
    await page.goto(`file://${createPath}?t=${b64(tokens)}`);
    await page.fill('#address', WALLET);
    await page.click('#allTokensToggle');
    await page.click('#tokenSearch');
    await page.locator('#dropdownList .dropdown-item', { hasText: 'NOPRICE' }).dispatchEvent('mousedown');
    await page.click('#submitBtn');
    assert((await page.locator('#thresholdError').textContent()).includes('NOPRICE'),
      'standalone page: explicitly selecting the unpriced token is still refused');

    assert(errors.length === 0, 'standalone page: no page errors: ' + errors.join(' | '));
    await page.close();
  }

  await browser.close();
  console.log(process.exitCode ? 'RESULT: FAILURES' : 'RESULT: all checks passed');
})();
