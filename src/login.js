/**
 * Interactive login script.
 * Opens a visible browser, lets you log in manually,
 * then saves the session to auth/session.json.
 *
 * Usage: npm run login
 */

// Engine-aware, like the server (Codex review): this script exists to hand-recover a session,
// so it must produce the SAME fingerprint the server will then use. Hard-wiring the legacy
// stealth stack here meant a `BROWSER_ENGINE=patchright` deployment got its cookies from a
// browser it never runs — and a `BROWSER_ENGINE=stealth` rollback silently did not apply.
const { resolveEngine, resolveChannel, launchArgs } = require('./browser-fingerprint');
const LOGIN_ENGINE = resolveEngine();
const chromium = LOGIN_ENGINE === 'patchright'
  ? require('patchright').chromium
  : require('playwright-extra').chromium;
if (LOGIN_ENGINE === 'stealth') {
  chromium.use(require('puppeteer-extra-plugin-stealth')());
}
const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, '..', 'auth', 'session.json');

(async () => {
  console.log('Opening browser for ChatGPT login...');
  console.log('Log in manually, then press Enter in this terminal to save the session.\n');

  const channel = resolveChannel(process.env, LOGIN_ENGINE);
  console.log(`[login] engine=${LOGIN_ENGINE} channel=${channel || 'bundled'}`);
  const browser = await chromium.launch({
    headless: false,
    args: launchArgs(LOGIN_ENGINE),
    ...(channel ? { channel } : {}),
  });
  // No user agent of our own. The pinned "macOS Chrome/131" that used to be here was inert
  // (the stealth bundle re-overrides the UA on every page) and, on the one occasion it would
  // NOT have been inert — stealth failing to apply — it announced macOS from a Linux host
  // with Linux client hints. See docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Hide automation indicators — legacy engine only; patchright reports webdriver=false
  // natively, and layering a JS getter on top of that is an extra patch for nothing.
  if (LOGIN_ENGINE === 'stealth') await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Browser opened. Log in to ChatGPT, then press Enter here.');

  // Wait for user to press Enter
  await new Promise((resolve) => {
    process.stdin.once('data', resolve);
  });

  // Save session
  const state = await context.storageState();
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
  console.log(`Session saved to ${SESSION_PATH}`);

  await browser.close();
  process.exit(0);
})();
