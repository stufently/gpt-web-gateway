// Unit tests for the browser fingerprint / egress policy (src/browser-fingerprint.js).
//
// These encode the findings of the 2026-07-26 Cloudflare investigation, so a future change
// cannot quietly reintroduce them:
//   - a pinned UA that contradicts the platform and the client hints;
//   - a headless token reaching the wire without anyone noticing;
//   - a shared launch-args array that a third-party plugin mutates.

const assert = require('assert');
const {
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
} = require('../src/browser-fingerprint');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nheadless detection');

test('flags the headless token in a native UA', () => {
  assert.strictEqual(
    leaksHeadless('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36'),
    true,
  );
});

test('accepts a stealth-normalised UA', () => {
  assert.strictEqual(
    leaksHeadless('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36'),
    false,
  );
});

test('empty / missing UA is not treated as a leak', () => {
  assert.strictEqual(leaksHeadless(''), false);
  assert.strictEqual(leaksHeadless(undefined), false);
});

console.log('\ncoherent fallback identity');

test('major version parsed from a Playwright version string', () => {
  assert.strictEqual(majorVersion('145.0.7632.6'), '145');
  assert.strictEqual(majorVersion('150.0.0.0'), '150');
  assert.strictEqual(majorVersion('garbage'), '145'); // documented default
});

test('fallback UA says Linux — the platform we actually run on', () => {
  const ua = linuxChromeUserAgent('145.0.7632.6');
  assert.ok(ua.includes('X11; Linux x86_64'), ua);
  assert.ok(!/Macintosh|Windows/.test(ua), 'must not claim another OS');
});

test('fallback UA reports a reduced minor version, like real Chrome', () => {
  // Echoing the full build number (145.0.7632.6) is an anomaly no shipping Chrome produces.
  assert.ok(linuxChromeUserAgent('145.0.7632.6').includes('Chrome/145.0.0.0'));
});

test('fallback UA never contains the headless token', () => {
  assert.strictEqual(leaksHeadless(linuxChromeUserAgent('145.0.7632.6')), false);
});

console.log('\nuser-agent policy');

test('a clean effective UA is used as-is (we send no override)', () => {
  const d = decideUserAgent({
    effectiveUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36',
    browserVersion: '145.0.7632.6',
  });
  assert.strictEqual(d.source, 'browser');
  assert.strictEqual(d.userAgent, undefined, 'must not invent a UA when the real one is fine');
  assert.strictEqual(d.evasionsOk, true);
});

test('a headless effective UA triggers the coherent fallback and flags evasions', () => {
  const d = decideUserAgent({
    effectiveUserAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36',
    browserVersion: '145.0.7632.6',
  });
  assert.strictEqual(d.source, 'fallback');
  assert.strictEqual(d.evasionsOk, false, 'a headless leak must be reported, not papered over');
  assert.ok(d.userAgent.includes('Linux'));
});

test('no policy ever emits client-hint headers', () => {
  // Regression guard for a fix that made things worse: `extraHTTPHeaders` DOES take effect
  // while the context `userAgent` does NOT (stealth re-overrides it per page), so shipping
  // Sec-CH-UA alongside a UA we cannot enforce put stealth's "Windows" user agent on the wire
  // next to our own `Sec-CH-UA-Platform: "Linux"` — a brand new contradiction.
  for (const args of [
    { effectiveUserAgent: 'Chrome/145.0.0.0', browserVersion: '145.0.0.0' },
    { effectiveUserAgent: 'HeadlessChrome/145', browserVersion: '145.0.0.0' },
    { envUserAgent: 'Chrome/149.0.0.0' },
  ]) {
    const d = decideUserAgent(args);
    assert.ok(!('extraHTTPHeaders' in d) || d.extraHTTPHeaders == null, JSON.stringify(d));
  }
});

test('an unavailable probe result falls back rather than trusting nothing', () => {
  const d = decideUserAgent({ effectiveUserAgent: '', browserVersion: '145.0.7632.6' });
  assert.strictEqual(d.source, 'fallback');
});

test('an operator-pinned UA wins over everything', () => {
  const d = decideUserAgent({
    effectiveUserAgent: 'HeadlessChrome/145',
    browserVersion: '145.0.0.0',
    envUserAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/149.0.0.0 Safari/537.36',
  });
  assert.strictEqual(d.source, 'env');
  assert.ok(d.userAgent.includes('149'));
  assert.strictEqual(d.evasionsOk, true);
});

test('a pinned UA that itself leaks headless is still reported as not-ok', () => {
  const d = decideUserAgent({ envUserAgent: 'Mozilla/5.0 HeadlessChrome/145.0.0.0' });
  assert.strictEqual(d.source, 'env');
  assert.strictEqual(d.evasionsOk, false);
});

test('the regression itself: a macOS UA is never produced for this Linux runtime', () => {
  for (const effective of ['', 'HeadlessChrome/145', 'Chrome/145.0.0.0']) {
    const d = decideUserAgent({ effectiveUserAgent: effective, browserVersion: '145.0.7632.6' });
    assert.ok(!/Macintosh/.test(d.userAgent || ''), `produced a macOS UA for "${effective}"`);
  }
});

console.log('\nlaunch args');

test('every launch gets its own array', () => {
  const a = launchArgs();
  const b = launchArgs();
  assert.notStrictEqual(a, b);
  assert.deepStrictEqual(a, b);
});

test('mutating one launch cannot affect the next (stealth does exactly this)', () => {
  // Measured: puppeteer-extra-plugin-stealth appends to the --disable-blink-features flag
  // of the array it is handed, so a shared array grew on every browser restart.
  const first = launchArgs();
  first[0] += ',AutomationControlled';
  first.push('--mutated');
  const second = launchArgs();
  assert.deepStrictEqual(second, [...COMMON_CHROMIUM_ARGS]);
  assert.ok(!second.includes('--mutated'));
});

test('the automation flag is present', () => {
  assert.ok(launchArgs().some((a) => a.startsWith('--disable-blink-features=AutomationControlled')));
});

console.log('\nchannel selection');

test('default now drives real Chrome, because the default engine is patchright', () => {
  // Behaviour changed deliberately on 2026-07-29. Before, an unset CHROMIUM_CHANNEL meant
  // Playwright's bundled headless shell; patchright's supported configuration is real Chrome,
  // so the default follows the engine rather than staying pinned to the old stack.
  assert.strictEqual(resolveChannel({}), 'chrome');
  assert.strictEqual(resolveChannel({ CHROMIUM_CHANNEL: '  ' }), 'chrome');
  // Rolling the engine back rolls the channel back with it, in one setting.
  assert.strictEqual(resolveChannel({ BROWSER_ENGINE: 'stealth' }), undefined);
});

test('CHROMIUM_CHANNEL opts into another build', () => {
  assert.strictEqual(resolveChannel({ CHROMIUM_CHANNEL: 'chromium' }), 'chromium');
  assert.strictEqual(resolveChannel({ CHROMIUM_CHANNEL: ' chrome ' }), 'chrome');
});

console.log('\negress proxy');

test('no PROXY_SERVER means a direct connection', () => {
  assert.strictEqual(resolveProxy({}), null);
  assert.strictEqual(resolveProxy({ PROXY_SERVER: '   ' }), null);
});

test('host and port are kept, path/credentials are not smuggled into server', () => {
  const p = resolveProxy({ PROXY_SERVER: 'http://proxy.example.com:8888' });
  assert.deepStrictEqual(p, { server: 'http://proxy.example.com:8888' });
});

test('discrete credentials are picked up', () => {
  const p = resolveProxy({
    PROXY_SERVER: 'http://proxy.example.com:8888',
    PROXY_USERNAME: 'bob',
    PROXY_PASSWORD: 's3cret',
  });
  assert.strictEqual(p.username, 'bob');
  assert.strictEqual(p.password, 's3cret');
});

test('credentials embedded in the URL are extracted and url-decoded', () => {
  const p = resolveProxy({ PROXY_SERVER: 'http://bob:p%40ss@proxy.example.com:8888' });
  assert.strictEqual(p.server, 'http://proxy.example.com:8888', 'server must carry no credentials');
  assert.strictEqual(p.username, 'bob');
  assert.strictEqual(p.password, 'p@ss');
});

test('discrete vars override credentials embedded in the URL', () => {
  const p = resolveProxy({
    PROXY_SERVER: 'http://urluser:urlpass@proxy.example.com:8888',
    PROXY_USERNAME: 'envuser',
    PROXY_PASSWORD: 'envpass',
  });
  assert.strictEqual(p.username, 'envuser');
  assert.strictEqual(p.password, 'envpass');
});

test('socks proxies are supported without credentials', () => {
  assert.strictEqual(resolveProxy({ PROXY_SERVER: 'socks5://10.0.0.1:1080' }).server, 'socks5://10.0.0.1:1080');
});

test('socks + credentials is rejected up front, not at first request', () => {
  // Verified against playwright-core 1.58.2: launch throws
  // "Browser does not support socks5 proxy authentication". Chromium implements proxy auth
  // for http(s) only, so this can never work and should say so at startup.
  assert.throws(
    () => resolveProxy({ PROXY_SERVER: 'socks5://10.0.0.1:1080', PROXY_USERNAME: 'u', PROXY_PASSWORD: 'p' }),
    /authentication is not supported/,
  );
  assert.throws(
    () => resolveProxy({ PROXY_SERVER: 'socks4://u:p@10.0.0.1:1080' }),
    /authentication is not supported/,
  );
});

test('a DEBUG setting that would print the proxy password is refused', () => {
  // playwright-extra logs the full launch options under its debug namespace — verified: the
  // sentinel password appeared twice in stderr. Refuse rather than leak.
  //
  // The glob and whitespace forms are the ones a first, regex-on-the-raw-string attempt let
  // through — including `playwright-extra*,puppeteer-extra*`, which is the form
  // playwright-extra's own README tells people to use.
  const leaky = [
    'playwright-extra',
    '*',
    'foo,playwright-extra',
    'puppeteer-extra:*',
    'playwright-extra*,puppeteer-extra*',
    'foo playwright-extra',
    '*extra*',
    'playwright-extra:plugins',
    '  playwright-extra  ',
  ];
  for (const DEBUG of leaky) {
    assert.throws(
      () => resolveProxy({ PROXY_SERVER: 'http://p:8888', PROXY_PASSWORD: 'hunter2', DEBUG }),
      /makes playwright-extra log/,
      `DEBUG="${DEBUG}" should have been refused`,
    );
  }
});

test('an unrelated DEBUG namespace is left alone', () => {
  for (const DEBUG of ['myapp:*', 'express', '', 'foo,bar']) {
    const p = resolveProxy({ PROXY_SERVER: 'http://p:8888', PROXY_PASSWORD: 'hunter2', DEBUG });
    assert.strictEqual(p.password, 'hunter2', `DEBUG="${DEBUG}" should not have been refused`);
  }
});

test('an explicit exclusion re-enables the password', () => {
  // `debug` honours a leading "-" as "not this namespace"; so must we, or we would reject a
  // configuration that is in fact safe.
  const p = resolveProxy({
    PROXY_SERVER: 'http://p:8888',
    PROXY_PASSWORD: 'hunter2',
    DEBUG: '*,-playwright-extra*,-puppeteer-extra*',
  });
  assert.strictEqual(p.password, 'hunter2');
});

test('a passwordless proxy is unaffected by DEBUG', () => {
  assert.ok(resolveProxy({ PROXY_SERVER: 'http://p:8888', DEBUG: '*' }));
});

test('a malformed proxy fails loudly instead of being ignored', () => {
  // Silently dropping it would send traffic out of the very address the setting exists to
  // avoid — the failure this whole release is about.
  assert.throws(() => resolveProxy({ PROXY_SERVER: 'not a url' }), /not a valid URL/);
  assert.throws(() => resolveProxy({ PROXY_SERVER: 'ftp://proxy:21' }), /not supported/);
});

test('a proxy error message never contains the password', () => {
  try {
    resolveProxy({ PROXY_SERVER: 'ftp://bob:hunter2@proxy.example.com:21' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(!e.message.includes('hunter2'), e.message);
  }
});

test('log helpers never leak credentials', () => {
  assert.ok(!redactProxyUrl('http://bob:hunter2@proxy:8888').includes('hunter2'));
  const desc = describeProxy({ server: 'http://proxy:8888', username: 'bob', password: 'hunter2' });
  assert.ok(!desc.includes('hunter2'), desc);
  assert.ok(desc.includes('auth: yes'));
  assert.strictEqual(describeProxy(null), 'direct (no proxy)');
});

// ---------------------------------------------------------------- engine selection
//
// The 2026-07-29 migration: patchright + real Chrome replaces playwright-extra + the 2022
// stealth bundle. The legacy path stays reachable by one env var, because the fingerprint is
// the whole point of the change and a rollback must not need an image rebuild.

test('patchright is the default engine', () => {
  assert.strictEqual(resolveEngine({}), 'patchright');
});

test('the legacy stealth stack stays reachable for rollback', () => {
  assert.strictEqual(resolveEngine({ BROWSER_ENGINE: 'stealth' }), 'stealth');
  assert.strictEqual(resolveEngine({ BROWSER_ENGINE: '  STEALTH ' }), 'stealth');
});

test('an unknown engine fails loudly instead of silently picking one', () => {
  // Silently defaulting would hide a typo in the one setting that decides which fingerprint
  // goes on the wire — exactly the class of silent failure this module exists to remove.
  assert.throws(() => resolveEngine({ BROWSER_ENGINE: 'camoufox' }), /BROWSER_ENGINE/);
});

test('patchright drives real Chrome by default, stealth keeps its own channel', () => {
  // patchright's supported configuration is channel:"chrome"; its bundled-Chromium and
  // headless variants were both measured as 403 while real Chrome headed passed.
  assert.strictEqual(resolveChannel({}, 'patchright'), 'chrome');
  // The legacy path must keep behaving exactly as it did — no channel unless asked.
  assert.strictEqual(resolveChannel({}, 'stealth'), undefined);
  assert.strictEqual(resolveChannel({ CHROMIUM_CHANNEL: 'chromium' }, 'stealth'), 'chromium');
});

test('an explicit CHROMIUM_CHANNEL still wins under patchright', () => {
  assert.strictEqual(resolveChannel({ CHROMIUM_CHANNEL: 'chromium' }, 'patchright'), 'chromium');
});

test('only the legacy engine wants the automation-controlled flag', () => {
  // patchright adds --disable-blink-features=AutomationControlled itself and removes
  // --enable-automation; passing our own copy duplicates a flag it manages.
  assert.ok(launchArgs('stealth').some((a) => a.includes('AutomationControlled')));
  assert.ok(!launchArgs('patchright').some((a) => a.includes('AutomationControlled')));
  // The anti-throttling flags are ours in both engines — a backgrounded renderer does not
  // commit ChatGPT's streamed text.
  for (const engine of ['stealth', 'patchright']) {
    assert.ok(launchArgs(engine).includes('--disable-renderer-backgrounding'), engine);
  }
});

console.log(`\n${passed} assertions passed`);
