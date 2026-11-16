const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const source = (name) => fs.readFileSync(path.join(__dirname, '..', 'SafariDarkMode', name), 'utf8');
let browser;
before(async () => {
  const engine = process.env.SDM_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch({
    executablePath: process.env.SDM_BROWSER_PATH || undefined,
    headless: true
  });
});
after(async () => browser?.close());

async function fixture(t, { dark = false, settings = {}, early = false, timeoutIdle = false } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://fixture.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>
      html,body { min-height:100%; margin:0; }
      body { background:${dark ? '#111419' : '#ffffff'}; color:${dark ? '#edf1f7' : '#18202c'}; }
      #card { background:${dark ? '#1b2028' : '#ffffff'}; padding:20px; color:${dark ? '#edf1f7' : '#18202c'}; }
      img { filter:grayscale(1); }
      #image-background { background-image:linear-gradient(red, blue); }
      </style></head><body><div id="card">Text</div>
      <img alt="sample" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
      <video></video><canvas></canvas><div id="image-background">Background</div></body></html>`
  }));
  await page.addInitScript(({ initial, timeoutIdle }) => {
    if (timeoutIdle) {
      window.requestIdleCallback = (callback) => setTimeout(() => callback({
        didTimeout: true,
        timeRemaining: () => 0
      }), 0);
    }
    window.testSettings = { globalEnabled: true, excludedHosts: [], ...initial };
    window.browser = {
      storage: {
        local: { get: async () => window.testSettings },
        onChanged: { addListener(fn) { window.settingsChanged = fn; } }
      },
      runtime: { onMessage: { addListener(fn) { window.messageHandler = fn; } } }
    };
    window.changeSettings = (value) => {
      Object.assign(window.testSettings, value);
      window.settingsChanged({}, 'local');
    };
  }, { initial: settings, timeoutIdle });
  if (early) await page.addInitScript({ content: source('content.js') });
  await page.goto('http://fixture.test/');
  const original = await media(page);
  await page.addStyleTag({ content: source('dark-mode.css') });
  if (!early) await page.addScriptTag({ content: source('content.js') });
  await page.waitForFunction(() => {
    let status;
    window.messageHandler({ type: 'sdm:get-status' }, {}, (value) => { status = value; });
    return !['checking', 'processing'].includes(status.pageKind);
  });
  return { page, original };
}

function media(page) {
  return page.evaluate(() => Object.fromEntries(['img', 'video', 'canvas', '#image-background'].map((selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    return [selector, { filter: style.filter, backgroundImage: style.backgroundImage }];
  })));
}

async function active(page) {
  return page.locator('html').getAttribute('data-sdm-active');
}

test('light pages darken, preserve author media styling, and handle inserted content', async (t) => {
  const { page, original } = await fixture(t);
  assert.equal(await active(page), 'true');
  assert.notEqual(await page.locator('#card').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  assert.deepEqual(await media(page), original);
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.id = 'inserted';
    card.style.cssText = 'background:white;color:black';
    card.textContent = 'Added later';
    document.body.append(card);
  });
  await page.waitForFunction(() => document.querySelector('#inserted').hasAttribute('data-sdm-bg'));
  assert.notEqual(await page.locator('#inserted').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
});

test('already-dark pages retain original colors and receive no overrides', async (t) => {
  const { page } = await fixture(t, { dark: true });
  assert.equal(await active(page), null);
  assert.equal(await page.locator('#card').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(27, 32, 40)');
  assert.equal(await page.locator('[data-sdm-bg], [data-sdm-fg]').count(), 0);
});

test('content script can start before the document root exists', async (t) => {
  const { page } = await fixture(t, { early: true });
  assert.equal(await active(page), 'true');
});

test('restyling a transformed element settles without a mutation feedback loop', async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(() => {
    window.mutationCount = 0;
    new MutationObserver((records) => { window.mutationCount += records.length; })
      .observe(document.querySelector('#card'), { attributes: true });
    document.querySelector('#card').className = 'harmless';
  });
  await page.waitForTimeout(300);
  const count = await page.evaluate(() => window.mutationCount);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.mutationCount), count);
  await page.locator('#card').evaluate((el) => { el.style.backgroundColor = '#eee'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#card')).backgroundColor !== 'rgb(238, 238, 238)');
});

test('disabled and excluded settings restore author colors', async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(() => window.changeSettings({ globalEnabled: false }));
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-sdm-active'));
  assert.equal(await page.locator('#card').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  await page.evaluate(() => window.changeSettings({ globalEnabled: true, excludedHosts: ['fixture.test'] }));
  await page.waitForTimeout(100);
  assert.equal(await active(page), null);
  await page.evaluate(() => window.changeSettings({ excludedHosts: [] }));
  await page.waitForFunction(() => document.documentElement.getAttribute('data-sdm-active') === 'true');
});

test('timed-out idle callbacks make progress with no idle time remaining', async (t) => {
  const { page } = await fixture(t, { timeoutIdle: true });
  assert.equal(await active(page), 'true');
  assert.notEqual(await page.locator('#card').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
});

test('queued mutation work cannot change the page after disabling', async (t) => {
  const { page } = await fixture(t);
  const authorStyle = await page.evaluate(() => {
    window.pendingIdleWork = [];
    window.requestIdleCallback = (callback) => window.pendingIdleWork.push(callback);
    const card = document.createElement('div');
    card.id = 'queued-card';
    card.style.cssText = 'background:white;color:black';
    card.textContent = 'Waiting for processing';
    document.body.append(card);
    return card.getAttribute('style');
  });
  await page.waitForFunction(() => window.pendingIdleWork.length > 0);
  await page.evaluate(() => window.changeSettings({ globalEnabled: false }));
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-sdm-active'));
  await page.evaluate(() => {
    while (window.pendingIdleWork.length) {
      window.pendingIdleWork.shift()({ didTimeout: true, timeRemaining: () => 0 });
    }
  });
  assert.equal(await active(page), null);
  assert.equal(await page.locator('#queued-card').getAttribute('style'), authorStyle);
  assert.deepEqual(await page.locator('#queued-card').evaluate((el) => el.getAttributeNames().sort()), ['id', 'style']);
});

test('popup reads the main frame and stores only explicit preferences', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(source('popup.html').replace(/<script[^>]*src="popup.js"[^>]*><\/script>/, ''));
  await page.evaluate(() => {
    window.calls = [];
    window.writes = [];
    window.browser = {
      storage: { local: { get: async (defaults) => defaults, set: async (value) => window.writes.push(value) } },
      tabs: {
        query: async () => [{ id: 1, url: 'https://fixture.test/path?private=value' }],
        sendMessage: async (id, message, options) => {
          window.calls.push({ id, message, options });
          return { pageKind: 'light-darkened' };
        }
      }
    };
  });
  await page.addScriptTag({ content: source('popup.js') });
  await page.waitForFunction(() => window.calls.length > 0);
  await page.locator('#site-toggle').uncheck();
  await page.locator('#global-toggle').uncheck();
  assert.deepEqual(await page.evaluate(() => window.writes), [
    { excludedHosts: ['fixture.test'] }, { globalEnabled: false }
  ]);
  assert.ok(await page.evaluate(() => window.calls.every((call) => call.options?.frameId === 0)));
});
