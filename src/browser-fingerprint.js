// Browser fingerprint / egress policy — the pure half of browser.js.
//
// Why this file exists (investigation of 2026-07-26, see
// docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md):
//
// The gateway sat behind a Cloudflare "Just a moment…" interstitial that never cleared, and
// the leading hypothesis was a self-contradictory fingerprint — `src/browser.js` pinned a
// **macOS Chrome/131** user agent while running headless Chromium 145 on **Linux**.
// Measuring it refuted the hypothesis and replaced it with facts worth encoding here:
//
//   1. That pinned UA never reached the network. `puppeteer-extra-plugin-stealth` installs a
//      per-page `Network.setUserAgentOverride`, which **beats** the context-level
//      `userAgent` option (measured: pinning `Chrome/149` still put stealth's
//      `Windows … Chrome/145.0.7632.6` on the wire). Any UA this service wants to control
//      must therefore go THROUGH the stealth plugin, not around it — a context-level UA is
//      inert while stealth is alive, and only takes effect once stealth is dead.
//
//   2. The stealth bundle is what keeps this gateway out of a challenge. With it: HTTP 200.
//      Without it: 403 `cf-mitigated: challenge`, same host, same image, same minute.
//      Nothing verified it was still working, so this module also provides the leak test
//      that turns "stealth silently stopped applying" into an observable event.
//
//      Scope note, deliberately conservative: the test looks at `navigator.userAgent` only.
//      That is a *symptom* of the evasions being dead, not a full audit of them — in the
//      configuration that passes Cloudflare, `userAgentData.getHighEntropyValues()` still
//      reports `HeadlessChrome` in `fullVersionList`. So a clean UA does not prove the
//      fingerprint is clean; a dirty one does prove the evasions stopped applying.
//
// Everything here is pure (no Playwright, no I/O) so the policy is unit-testable.

// A headless build advertises itself in the UA string. It is the cheapest, most reliable
// "the evasions are not running" signal available — not, on its own, the thing anti-bot
// systems key on (see the scope note above).
const HEADLESS_TOKEN_RE = /headlesschrome|\bheadless\b/i;

/** True when the effective user agent still advertises a headless build. */
function leaksHeadless(userAgent) {
  return HEADLESS_TOKEN_RE.test(String(userAgent || ''));
}

/** Major version out of a Playwright `browser.version()` ("145.0.7632.6" → "145"). */
function majorVersion(version, fallback = '145') {
  const m = String(version || '').match(/^(\d+)\./);
  return m ? m[1] : fallback;
}

/**
 * A coherent desktop-Linux Chrome UA for the version we are actually running.
 *
 * Deliberately Linux, not macOS/Windows: this process runs on Linux, and `navigator.platform`
 * / WebGL / font metrics cannot be talked out of saying so. Minor version is `0.0.0` because
 * real Chrome has reported a frozen minor version since the UA-reduction rollout — echoing a
 * full build number (`145.0.7632.6`) is an anomaly no shipping browser produces.
 *
 * Used only as a **fallback identity**, when the evasions are confirmed dead and the
 * browser would otherwise announce itself as headless.
 */
function linuxChromeUserAgent(version) {
  const major = majorVersion(version);
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Decide the context's UA policy from what the browser actually advertises.
 *
 *   'browser'  — the effective UA is already clean: send nothing of our own. A UA we invent
 *                can only drift away from the rest of the fingerprint; the browser's own
 *                (as rewritten by stealth) is self-consistent by construction
 *   'env'      — operator pinned BROWSER_USER_AGENT; obey it verbatim
 *   'fallback' — the UA still says "headless", i.e. the evasions are dead. Substitute a
 *                coherent Linux Chrome identity and flag it loudly
 *
 * NOTE — no client-hint headers are returned. An earlier revision also injected matching
 * `Sec-CH-UA*` via `extraHTTPHeaders`, on the theory that Playwright derives the platform
 * hint from a custom UA but not the brand list. Measured, that made things strictly worse:
 * `extraHTTPHeaders` DOES take effect while the context `userAgent` does NOT (stealth
 * overrides it), so the pair produced a *new* contradiction on the wire — stealth's
 * `Windows` user agent alongside our `Sec-CH-UA-Platform: "Linux"`. A header we cannot keep
 * in sync with the UA is worse than the leak it was meant to patch.
 */
function decideUserAgent({ effectiveUserAgent, browserVersion, envUserAgent } = {}) {
  const pinned = String(envUserAgent || '').trim();
  if (pinned) {
    return { source: 'env', userAgent: pinned, evasionsOk: !leaksHeadless(pinned) };
  }
  if (effectiveUserAgent && !leaksHeadless(effectiveUserAgent)) {
    return { source: 'browser', userAgent: undefined, evasionsOk: true };
  }
  return {
    source: 'fallback',
    userAgent: linuxChromeUserAgent(browserVersion),
    evasionsOk: false,
  };
}

// ------------------------------------------------------------------ egress proxy

const SUPPORTED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks4:']);
// Chromium implements proxy authentication for HTTP(S) proxies only. Playwright rejects the
// rest at launch with "Browser does not support socks5 proxy authentication" (verified
// against playwright-core 1.58.2), so catching it here turns a crash on the first request
// into a clear message at startup.
const SCHEMES_SUPPORTING_AUTH = new Set(['http:', 'https:']);

// Namespaces that make playwright-extra / puppeteer-extra print the full launch options —
// proxy password included (verified: the sentinel appeared twice in stderr).
const LEAKY_DEBUG_NAMESPACES = [
  'playwright-extra',
  'playwright-extra:plugins',
  'playwright-extra:puppeteer-compat',
  'puppeteer-extra',
  'puppeteer-extra:plugins',
];

/**
 * Would this `DEBUG` value enable a namespace that echoes our launch options?
 *
 * Implements the `debug` package's own matching rules rather than pattern-matching the string,
 * because a first attempt at the latter missed real-world values. `debug` splits on whitespace
 * OR commas, treats `*` as a wildcard, and treats a leading `-` as an exclusion — so the form
 * playwright-extra itself documents, `DEBUG=playwright-extra*,puppeteer-extra*`, sails straight
 * past a naive "exact token between commas" regex while still printing the password
 * (reproduced — Codex review, round 2).
 */
function debugEnablesLeakyNamespace(debugEnv) {
  const raw = String(debugEnv || '').trim();
  if (!raw) return false;
  const names = [];
  const skips = [];
  for (const part of raw.split(/[\s,]+/)) {
    if (!part) continue;
    const negated = part[0] === '-';
    const pattern = new RegExp(`^${(negated ? part.slice(1) : part).replace(/\*/g, '.*?')}$`, 'i');
    (negated ? skips : names).push(pattern);
  }
  return LEAKY_DEBUG_NAMESPACES.some(
    (ns) => names.some((re) => re.test(ns)) && !skips.some((re) => re.test(ns)),
  );
}

/**
 * Optional egress proxy for the browser.
 *
 * Rationale (measured, not assumed): the identical image and fingerprint that is served
 * HTTP 200 from one egress IP is answered with 403 `cf-mitigated: challenge` from the
 * production node's IP (a freshly allocated hosting range Cloudflare scores as low-trust).
 * No fingerprint change moved that outcome; changing the egress did. So the gateway needs to
 * be able to leave through a different address without a code change.
 *
 * Credentials may be embedded in the URL (`http://user:pass@host:port`) or supplied
 * separately; the discrete vars win, so a shared PROXY_SERVER can be overridden per
 * deployment.
 *
 * @returns {null | {server: string, username?: string, password?: string}}
 * @throws {Error} on a malformed URL, an unsupported scheme, credentials on a scheme that
 *                 cannot carry them, or a debug configuration that would print the password.
 *                 Failing loudly at startup beats silently ignoring the one setting that was
 *                 meant to fix the outage — or silently leaking the credential.
 */
function resolveProxy(env = process.env) {
  const raw = String(env.PROXY_SERVER || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PROXY_SERVER is not a valid URL: ${redactProxyUrl(raw)}`);
  }
  if (!SUPPORTED_PROXY_SCHEMES.has(url.protocol)) {
    throw new Error(
      `PROXY_SERVER scheme "${url.protocol}" is not supported (use http/https/socks5/socks4)`,
    );
  }
  if (!url.hostname) throw new Error('PROXY_SERVER has no host');

  const proxy = { server: `${url.protocol}//${url.host}` };
  const username = String(env.PROXY_USERNAME || '').trim() || decodeURIComponent(url.username || '');
  const password = String(env.PROXY_PASSWORD || '') || decodeURIComponent(url.password || '');
  if (username) proxy.username = username;
  if (password) proxy.password = password;

  if ((proxy.username || proxy.password) && !SCHEMES_SUPPORTING_AUTH.has(url.protocol)) {
    throw new Error(
      `proxy authentication is not supported for "${url.protocol}" — Chromium implements it ` +
        'for http/https proxies only. Use an http(s) proxy, or drop PROXY_USERNAME/PROXY_PASSWORD.',
    );
  }
  if (proxy.password && debugEnablesLeakyNamespace(env.DEBUG)) {
    throw new Error(
      `DEBUG="${env.DEBUG}" makes playwright-extra log the full launch options, which include ` +
        'the proxy password. Narrow DEBUG or unset PROXY_PASSWORD.',
    );
  }
  return proxy;
}

/** Strip credentials out of a proxy URL so it can be logged. */
function redactProxyUrl(raw) {
  return String(raw || '').replace(/\/\/[^/@]*@/, '//[redacted]@');
}

/** One-line, credential-free description of the proxy for logs. */
function describeProxy(proxy) {
  if (!proxy) return 'direct (no proxy)';
  return `${redactProxyUrl(proxy.server)} (auth: ${proxy.username ? 'yes' : 'no'})`;
}

// ------------------------------------------------------------------ launch options

// Anti-throttling (2026-07-11): the ChatGPT streaming renderer does not commit response text
// on a "backgrounded" page, and a headless window always looks backgrounded.
// AutomationControlled: removes the Blink flag that advertises remote control.
const COMMON_CHROMIUM_ARGS = Object.freeze([
  '--disable-blink-features=AutomationControlled',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]);

/**
 * A FRESH args array for every launch.
 *
 * Not cosmetic: `puppeteer-extra-plugin-stealth` mutates the array it is handed — it appends
 * its own `AutomationControlled` entry to the existing `--disable-blink-features=` flag.
 * Sharing one module-level array across launches therefore grows the flag on every browser
 * restart (measured after four launches:
 * `--disable-blink-features=AutomationControlled,AutomationControlled,…`). Harmless today,
 * but it is unbounded growth in a command line driven by a third-party plugin.
 *
 * `AutomationControlled` is OMITTED under patchright: that fork curates the default args
 * itself (adds this flag, removes `--enable-automation`, `--disable-component-update` and
 * friends, each removal a documented detection point). Handing it our own copy duplicates a
 * flag it manages. The anti-throttling flags stay in both engines — they are ours, and a
 * renderer treated as backgrounded does not commit ChatGPT's streamed text.
 */
function launchArgs(engine = 'stealth') {
  return engine === 'patchright'
    ? COMMON_CHROMIUM_ARGS.filter((a) => !a.startsWith('--disable-blink-features='))
    : [...COMMON_CHROMIUM_ARGS];
}

// ------------------------------------------------------------------ engine selection

const ENGINES = new Set(['patchright', 'stealth']);

/**
 * Which automation driver to load (2026-07-29 migration).
 *
 *   'patchright' (default) — the maintained Playwright fork, driving REAL Google Chrome. It
 *       patches the CDP-protocol leaks (`Runtime.enable`, `Console.enable`) that the 2022
 *       `puppeteer-extra-plugin-stealth` release cannot touch, and — measured, see
 *       docs/2026-07-29-patchright-compat-probe.md — produces a fingerprint with no
 *       `HeadlessChrome` token anywhere (including the high-entropy client hints, where the
 *       stealth stack still leaks it) and no Linux-masked-as-Windows contradiction.
 *
 *   'stealth' — the legacy playwright-extra + stealth-bundle path. Kept deliberately: the
 *       fingerprint IS the point of this change, so a rollback has to be one env var rather
 *       than an image rebuild.
 *
 * An unrecognised value throws instead of quietly picking a default — this setting decides
 * which identity goes on the wire, and a typo that silently selects the other stack is the
 * exact class of silent failure this module exists to remove.
 */
function resolveEngine(env = process.env) {
  const raw = String(env.BROWSER_ENGINE || '').trim().toLowerCase();
  if (!raw) return 'patchright';
  if (!ENGINES.has(raw)) {
    throw new Error(
      `BROWSER_ENGINE "${env.BROWSER_ENGINE}" is not supported (use ${[...ENGINES].join(' or ')})`,
    );
  }
  return raw;
}

/**
 * Which Chromium build to drive.
 *
 * Default (empty) keeps Playwright's bundled **headless shell**. `CHROMIUM_CHANNEL=chromium`
 * switches to the full browser in new-headless mode. Measured trade-off: the full build is a
 * closer match to real Chrome (5 plugin entries vs 3, UA reports the reduced `145.0.0.0`
 * instead of the full build number) but costs roughly twice the resident memory on an idle
 * page — 722 MB vs 377 MB — against a 3 Gi pod limit that already peaks near 1.7 GiB. It did
 * NOT change the Cloudflare outcome in either direction (both pass from a clean egress, both
 * are challenged from the blocked one), so it stays opt-in rather than becoming the default.
 */
function resolveChannel(env = process.env, engine = resolveEngine(env)) {
  const channel = String(env.CHROMIUM_CHANNEL || '').trim();
  if (channel) return channel;
  // patchright's supported configuration is real Chrome. Its bundled-Chromium and headless
  // variants were both measured at 403 against chatgpt.com where real Chrome headed passed,
  // and its own documentation says to use `channel: "chrome"` without fingerprint injection.
  return engine === 'patchright' ? 'chrome' : undefined;
}

module.exports = {
  leaksHeadless,
  majorVersion,
  linuxChromeUserAgent,
  decideUserAgent,
  resolveProxy,
  redactProxyUrl,
  describeProxy,
  launchArgs,
  resolveChannel,
  resolveEngine,
  COMMON_CHROMIUM_ARGS,
  debugEnablesLeakyNamespace,
};
