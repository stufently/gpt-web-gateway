const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  decideUserAgent,
  describeProxy,
  launchArgs,
  leaksHeadless,
  resolveChannel,
  resolveEngine,
  resolveProxy,
} = require('./browser-fingerprint');

// Which driver actually launches the browser. Resolved once, at import, so a typo in
// BROWSER_ENGINE fails at startup rather than on the first request.
//
// 'patchright' (default since 2.11.0) drives REAL Google Chrome through a maintained
// Playwright fork that patches the CDP-protocol leaks. Measured against the old stack
// (docs/2026-07-29-patchright-compat-probe.md): no `HeadlessChrome` token anywhere — including
// the high-entropy client hints, where the stealth bundle still leaks it — and no
// Linux-masked-as-Windows contradiction. 'stealth' keeps the legacy path for one-env-var
// rollback.
// Resolved LAZILY, not at import: the standalone entry points (`npm run auto-login`,
// `npm run login`) call `dotenv.config()` *after* requiring this module, so reading the env at
// import would make `BROWSER_ENGINE` from `.env` silently ignored for exactly the commands an
// operator uses to recover a session — i.e. the rollback switch would not apply to them
// (Codex review). Same reasoning as configureStealth() below.
let engineCache = null;
function browserEngine() {
  if (!engineCache) engineCache = resolveEngine();
  return engineCache;
}

// Required lazily and memoised: pulling in `playwright-extra` drags the whole stealth
// dependency graph along, and a patchright deployment has no reason to pay for it (nor to
// have a 2022 plugin's evasions anywhere near its page objects).
let chromiumDriver = null;
function getChromium() {
  if (!chromiumDriver) {
    chromiumDriver = browserEngine() === 'patchright'
      ? require('patchright').chromium
      : require('playwright-extra').chromium;
  }
  return chromiumDriver;
}

// A pinned user agent has to be installed INSIDE the stealth bundle, not around it.
// `puppeteer-extra-plugin-stealth` runs `Network.setUserAgentOverride` on every page, which
// overrides whatever `newContext({ userAgent })` asked for (measured 2026-07-26: pinning
// Chrome/149 still put stealth's Chrome/145 on the wire). Replacing the bundle's own
// user-agent-override evasion with a configured copy is the supported way to steer it.
//
// Caveat worth knowing before pinning anything: that evasion deliberately masks Linux as
// Windows. A pinned `X11; Linux x86_64 … Chrome/149` comes out as
// `Windows NT 10.0; Win64; x64 … Chrome/149` — version and brands honoured, platform
// rewritten — and it stays internally consistent (UA, Sec-CH-UA, navigator.platform all
// agree). Consistency is the property that matters, so this is left alone.
//
// Configured lazily, on first launch, NOT at import time: the standalone entry points
// (`npm run auto-login`, `npm run login`) call `dotenv.config()` *after* requiring this
// module, so reading the env at import would silently ignore `BROWSER_USER_AGENT` from
// `.env` for exactly those commands (Codex review, round 2).
let stealthPinnedUserAgent = '';
let stealthConfigured = false;
function configureStealth() {
  if (stealthConfigured) return stealthPinnedUserAgent;
  stealthConfigured = true;
  stealthPinnedUserAgent = String(process.env.BROWSER_USER_AGENT || '').trim();

  // Under patchright there is no bundle to configure — and deliberately so. Its documented
  // supported configuration is real Chrome with NO user-agent or header injection, because an
  // invented identity can only drift from the real Chrome the rest of the fingerprint comes
  // from. `BROWSER_USER_AGENT` survives as an operator escape hatch and is applied at context
  // level, where (with no stealth re-overriding it per page) it actually takes effect.
  if (browserEngine() === 'patchright') {
    if (stealthPinnedUserAgent) {
      console.log(
        '[browser] note: BROWSER_USER_AGENT is set while running patchright — patchright is ' +
          'designed to run WITHOUT user-agent injection, so this may make the fingerprint less ' +
          'coherent, not more.',
      );
    }
    return stealthPinnedUserAgent;
  }

  const chromium = getChromium();
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  const stealth = StealthPlugin();
  if (stealthPinnedUserAgent) {
    stealth.enabledEvasions.delete('user-agent-override');
    chromium.use(stealth);
    chromium.use(
      require('puppeteer-extra-plugin-stealth/evasions/user-agent-override')({
        userAgent: stealthPinnedUserAgent,
      }),
    );
  } else {
    chromium.use(stealth);
  }
  return stealthPinnedUserAgent;
}

const SESSION_PATH = path.join(__dirname, '..', 'auth', 'session.json');

let browser = null;
let context = null;
let tmpUserDataDir = null;

// What the browser layer is actually advertising right now. Read by /metrics — see
// `gpt_web_gateway_browser_ua_evasion_ok`.
//
// `ua_evasion_ok` starts at 0 and only becomes 1 once a real page has been asked what it
// advertises — same convention as `session_valid`: "0 = bad, or not confirmed yet". An
// unverified browser must never read as verified-good, which is the whole failure mode this
// release is about.
//
// Scope, stated precisely because it is easy to overclaim: this flag tracks ONE observable —
// whether the effective `navigator.userAgent` still says "headless". A 0 is strong evidence
// the stealth evasions stopped applying. A 1 is NOT a clean bill of health for the whole
// fingerprint: in the configuration that passes Cloudflare today,
// `userAgentData.getHighEntropyValues()` still reports `HeadlessChrome` in `fullVersionList`.
const browserFingerprint = {
  ua_evasion_ok: 0,
  ua_source: 'unverified',   // 'browser' | 'env' | 'fallback' | 'external' | 'unverified'
  effective_ua: '',
  channel: 'headless-shell',
  proxy: 'direct (no proxy)',
  cloudflare_challenges: 0,
};

// Detect Chrome user data dir per platform
function detectChromeUserDataDir() {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  // linux
  return path.join(home, '.config', 'google-chrome');
}

// Copy Chrome profile to a temp dir (Chrome requires non-default data dir for debugging)
function copyProfileToTemp(userDataDir, profile) {
  const profileSrc = path.join(userDataDir, profile);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-chrome-'));
  const profileDst = path.join(tmp, profile);

  console.log(`Copying Chrome profile "${profile}" to ${tmp}...`);

  // Copy essential files: Cookies, Local State, profile dir
  // Use rsync for speed — only copy what we need
  const localStateSrc = path.join(userDataDir, 'Local State');
  if (fs.existsSync(localStateSrc)) {
    fs.copyFileSync(localStateSrc, path.join(tmp, 'Local State'));
  }

  // Copy the profile directory
  execSync(`cp -R "${profileSrc}" "${profileDst}"`);

  console.log('Profile copied.');
  return tmp;
}

// Launch flags, the browser channel, the egress proxy and the user-agent policy all live in
// ./browser-fingerprint (pure + unit-tested). NB for BROWSER_MODE=cdp: the external Chrome
// owns its own flags/proxy — we only attach to it.

// Hide the one automation marker that survives a stealth failure. Installed at CONTEXT level
// so it covers every page (auto-login, /login, the chat page) instead of the two that
// happened to remember to add it.
const HIDE_WEBDRIVER = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
};

/**
 * Install the webdriver mask — but only for the legacy engine.
 *
 * patchright removes `--enable-automation` and adds
 * `--disable-blink-features=AutomationControlled` itself, so `navigator.webdriver` is already
 * `false` at the browser level (measured: `webdriver=false` on a patchright context with no
 * init script at all). Layering our own `defineProperty` on top of that would replace a native
 * getter with a JS one for no gain — an extra patch a detector can notice, in a stack whose
 * whole selling point is not needing JS-level patches.
 */
async function maybeHideWebdriver(ctx) {
  if (browserEngine() === 'patchright') return;
  await ctx.addInitScript(HIDE_WEBDRIVER);
}

/**
 * Same decision, for the PAGE-level call sites (the chat page, auto-login, /login).
 *
 * They each had their own inline copy of the defineProperty, which quietly defeated the
 * context-level policy: under patchright `navigator.webdriver` is already `false` natively, and
 * those copies were still replacing the native getter with a JS one — an extra patch, on the
 * one stack whose selling point is not needing JS patches (Codex review).
 */
async function maybeHideWebdriverOnPage(page) {
  if (browserEngine() === 'patchright') return;
  await page.addInitScript(HIDE_WEBDRIVER);
}

/**
 * Ask the browser what it actually advertises, on a throwaway page, before the real context
 * exists. `puppeteer-extra-plugin-stealth` rewrites the UA per page, so a blank page already
 * reflects whether the evasions are live (verified 2026-07-26).
 *
 * Never throws: a failed probe must not stop the gateway from starting — it only means we
 * fall back to the browser's own UA, which is what we would have used anyway.
 */
async function probeEffectiveUserAgent(br) {
  let probeCtx = null;
  try {
    probeCtx = await br.newContext();
    const page = await probeCtx.newPage();
    return await page.evaluate(() => navigator.userAgent);
  } catch (e) {
    console.log('[browser] could not probe effective user agent:', e.message);
    return '';
  } finally {
    if (probeCtx) await probeCtx.close().catch(() => {});
  }
}

const FINGERPRINT_PROBE_TIMEOUT_MS = 10000;

/**
 * Record what the FINAL context really advertises, whatever route built it.
 *
 * Runs for every `BROWSER_MODE`, including `chrome` and `cdp`. Those two skip the launch-time
 * plumbing entirely, and without this they would leave the gauge at its initial value — the
 * "unverified reads as healthy" bug this release exists to remove.
 *
 * Always opens its OWN page and closes it. Reusing whatever tab happens to exist is wrong
 * twice over: in `chrome` the persistent context's initial `about:blank` predates the
 * playwright-extra page hooks and would report a false negative, and in `cdp` it is somebody
 * else's tab, which may be closed or wedged. For the same reason the probe is raced against a
 * Node-side deadline — a hung foreign renderer must not be able to hang `getContext()`
 * (Codex review, round 2).
 *
 * `evasionsExpected === false` means the pre-context probe already caught the evasions not
 * applying and a fallback identity was substituted. That substitution makes the FINAL user
 * agent look clean, so trusting the final reading alone would erase the very failure the
 * gauge exists to publish. The negative verdict wins.
 */
async function verifyContextFingerprint(ctx, { requestedUserAgent, source, evasionsExpected } = {}) {
  let page = null;
  try {
    page = await ctx.newPage();
    let timer;
    const effective = await Promise.race([
      page.evaluate(() => navigator.userAgent).catch(() => ''),
      new Promise((resolve) => { timer = setTimeout(() => resolve(''), FINGERPRINT_PROBE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));

    if (source) browserFingerprint.ua_source = source;
    if (!effective) {
      // Unverified must not read as verified-good — leave the gauge at its reset 0.
      console.log('[browser] could not read the effective user agent — fingerprint stays unverified');
      return;
    }
    browserFingerprint.effective_ua = effective;
    const uaClean = !leaksHeadless(effective);
    browserFingerprint.ua_evasion_ok = uaClean && evasionsExpected !== false ? 1 : 0;

    if (requestedUserAgent && effective !== requestedUserAgent) {
      console.log(
        `[browser] note: requested user agent was not applied verbatim — asked for ` +
          `"${requestedUserAgent}", page reports "${effective}" (the stealth bundle rewrites it).`,
      );
    }
    if (!browserFingerprint.ua_evasion_ok) {
      // The single most consequential line in this file's logs: with the evasions active the
      // gateway is served HTTP 200, without them it gets `403 cf-mitigated: challenge` from
      // the same host in the same minute — and it used to fail silently.
      const detail = uaClean
        ? 'the browser advertised a headless build before a fallback identity was substituted'
        : `the browser still advertises a headless build ("${effective}")`;
      console.log(
        `[browser] WARNING: anti-automation evasions are NOT active — ${detail}. Expect ` +
          'anti-bot challenges until this is fixed (check playwright-extra / ' +
          'puppeteer-extra-plugin-stealth compatibility).',
      );
    }
  } catch (e) {
    console.log('[browser] could not verify context fingerprint:', e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Single-flight guard: the startup warm-up (server.js) and the first queued request can both
// call getContext() before `context` is assigned. Without this, two concurrent callers each
// pass the `if (context)` check, launch a browser, and race to overwrite the singleton —
// orphaning one browser and (via autoLogin→clearSession) potentially wiping the other's
// cookies mid-request. Memoize the in-flight promise so concurrent callers share one launch.
let contextPromise = null;
async function getContext() {
  if (context) return context;
  if (contextPromise) return contextPromise;
  contextPromise = _createContext();
  try {
    return await contextPromise;
  } finally {
    contextPromise = null;
  }
}

async function _createContext() {
  if (context) return context;

  // Every browser rebuild starts unverified. Without this reset a later launch whose probe
  // fails would inherit the previous run's `1` and keep reporting a healthy fingerprint it
  // never checked (Codex review, round 2).
  browserFingerprint.ua_evasion_ok = 0;
  browserFingerprint.ua_source = 'unverified';
  browserFingerprint.effective_ua = '';

  const pinnedUserAgent = configureStealth();
  const mode = process.env.BROWSER_MODE || 'default';
  const headless = process.env.HEADLESS !== 'false';
  const channel = resolveChannel(process.env, browserEngine());
  // Fail loudly on a malformed PROXY_SERVER: silently ignoring it would leave the gateway
  // going out of the address the setting exists to avoid.
  const proxy = resolveProxy();

  // Mode 1: Connect to running Chrome via CDP (chrome launched with --remote-debugging-port)
  if (mode === 'cdp') {
    // We attach to a browser somebody else launched, so its egress and its identity are its
    // own. Say so instead of letting the settings look effective.
    if (proxy) {
      console.log(
        `[browser] WARNING: PROXY_SERVER is set but BROWSER_MODE=cdp attaches to an external ` +
          'Chrome — the proxy is NOT applied. Launch that Chrome with --proxy-server=… instead.',
      );
    }
    if (pinnedUserAgent) {
      console.log(
        '[browser] WARNING: BROWSER_USER_AGENT is set but BROWSER_MODE=cdp does not control the ' +
          'external browser\'s identity — the value is NOT applied.',
      );
    }
    const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
    browser = await getChromium().connectOverCDP(cdpUrl);
    context = browser.contexts()[0] || await browser.newContext();
    browserFingerprint.channel = 'cdp (external)';
    browserFingerprint.proxy = 'external browser';
    await verifyContextFingerprint(context, { source: 'external' });
    return context;
  }

  // Mode 2: Use real Chrome with copied profile (Chrome can stay open!)
  if (mode === 'chrome') {
    const userDataDir = process.env.CHROME_USER_DATA_DIR || detectChromeUserDataDir();
    const profile = process.env.CHROME_PROFILE || 'Default';

    tmpUserDataDir = copyProfileToTemp(userDataDir, profile);

    context = await getChromium().launchPersistentContext(tmpUserDataDir, {
      headless,
      channel: 'chrome',
      args: [
        ...launchArgs(browserEngine()),
        `--profile-directory=${profile}`,
      ],
      viewport: { width: 1280, height: 800 },
      ...(proxy ? { proxy } : {}),
    });
    browser = context;
    await maybeHideWebdriver(context);
    browserFingerprint.channel = 'chrome';
    browserFingerprint.proxy = describeProxy(proxy);
    await verifyContextFingerprint(context, {
      source: pinnedUserAgent ? 'env' : 'browser',
      requestedUserAgent: pinnedUserAgent || undefined,
    });
    return context;
  }

  // Mode 3: Default — Playwright Chromium with saved session
  browser = await getChromium().launch({
    headless,
    args: launchArgs(browserEngine()),
    ...(channel ? { channel } : {}),
    ...(proxy ? { proxy } : {}),
  });

  // Ask the browser what it advertises instead of asserting it from a constant. A pinned
  // string cannot know whether the stealth evasions applied, and it drifts with every
  // Playwright bump — the removed "macOS Chrome/131" was three major versions behind the
  // Chromium it was running on, on the wrong OS.
  const effectiveUserAgent = await probeEffectiveUserAgent(browser);
  const ua = decideUserAgent({
    effectiveUserAgent,
    browserVersion: browser.version(),
    envUserAgent: pinnedUserAgent,
  });

  browserFingerprint.channel = channel || 'headless-shell';
  browserFingerprint.proxy = describeProxy(proxy);

  const storageState = fs.existsSync(SESSION_PATH) ? SESSION_PATH : undefined;

  context = await browser.newContext({
    storageState,
    // Usually undefined — the browser's own (stealth-rewritten) UA is self-consistent and a
    // UA we invent can only drift from it. A value here is inert while stealth is alive (it
    // re-overrides per page); it matters exactly in the case it is set for: a pinned UA, and
    // the fallback used when the evasions are confirmed dead and nothing is overriding.
    ...(ua.userAgent ? { userAgent: ua.userAgent } : {}),
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await maybeHideWebdriver(context);

  // Publish what the finished context REALLY reports, not what we asked for. `evasionsExpected`
  // carries the pre-context verdict forward so a substituted fallback identity cannot make a
  // broken stealth bundle look healthy.
  await verifyContextFingerprint(context, {
    requestedUserAgent: ua.userAgent,
    source: ua.source,
    evasionsExpected: ua.evasionsOk,
  });
  console.log(
    `[browser] channel=${browserFingerprint.channel} egress=${browserFingerprint.proxy} ` +
      `ua_source=${browserFingerprint.ua_source} ua_evasion_ok=${browserFingerprint.ua_evasion_ok} ` +
      `ua="${browserFingerprint.effective_ua}"`,
  );

  return context;
}

// Cloudflare clearance cookies — must survive clearSession(), otherwise a headless
// re-login starts from a clean browser and gets stuck on the CF "Just a moment"
// challenge forever (it cannot solve a fresh challenge), so the session never recovers.
const CF_COOKIE_RE = /^(cf_clearance|__cf_bm|__cfruid|__cflb)$/;

async function clearSession() {
  if (!context) return;
  // Preserve Cloudflare cookies so re-login isn't blocked by a fresh CF challenge.
  // Drop already-expired ones (expires === -1 means a session cookie → keep).
  let cfCookies = [];
  try {
    const now = Date.now() / 1000;
    cfCookies = (await context.cookies()).filter(
      (c) => CF_COOKIE_RE.test(c.name) && (c.expires === -1 || c.expires > now + 30)
    );
  } catch {}
  await context.clearCookies();
  if (cfCookies.length) {
    await context.addCookies(cfCookies).catch(() => {});
    console.log(`[clearSession] preserved ${cfCookies.length} Cloudflare cookie(s)`);
  }
  // Clear localStorage/sessionStorage on all pages
  for (const page of context.pages()) {
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
  }
}

async function saveSession() {
  if (!context) return;
  // Don't overwrite Chrome profile sessions
  if (process.env.BROWSER_MODE === 'chrome' || process.env.BROWSER_MODE === 'cdp') return;
  const state = await context.storageState();
  // 0700 / 0600: this file is the live ChatGPT session — cookies that are, in
  // practice, the account. Default permissions would leave it world-readable,
  // which matters as soon as the volume is shared or the image runs multi-user.
  // `mode` only applies on create, so chmod unconditionally for files written
  // by an earlier version.
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(SESSION_PATH, 0o600);
}

async function closeBrowser() {
  if (browser) {
    // Reset the singletons even if close() rejects — otherwise a failed close would leave
    // a stale non-null context and getContext() would never rebuild a fresh browser.
    try {
      await browser.close();
    } finally {
      browser = null;
      context = null;
    }
  }
  // Clean up temp profile dir
  if (tmpUserDataDir) {
    fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    tmpUserDataDir = null;
  }
}

module.exports = {
  getContext,
  saveSession,
  clearSession,
  maybeHideWebdriverOnPage,
  browserEngine,
  closeBrowser,
  SESSION_PATH,
  browserFingerprint,
};
