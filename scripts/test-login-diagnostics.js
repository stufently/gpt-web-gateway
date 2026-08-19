// Tests for src/login-diagnostics.js — the "why did the login fail" classifier, the
// secret redaction that guards everything it writes, and artifact rotation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  redactSecrets,
  sanitizeUrl,
  classifyLoginBlocker,
  captureLoginFailure,
  collectPageDiagnostics,
  rotateDiagFiles,
  LOGIN_BLOCKERS,
} = require('../src/login-diagnostics');

let passed = 0;
function ok(name, fn) { fn(); console.log(`PASS: ${name}`); passed++; }
async function okAsync(name, fn) { await fn(); console.log(`PASS: ${name}`); passed++; }

const FAKE_ENV = {
  CHATGPT_EMAIL: 'robot@example.com',
  CHATGPT_PASSWORD: 'Sup3rSecret!Passw0rd',
  CHATGPT_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
};

// ------------------------------------------------------------------ redaction

ok('credentials from env never survive redaction', () => {
  const raw = `login as ${FAKE_ENV.CHATGPT_EMAIL} with ${FAKE_ENV.CHATGPT_PASSWORD} totp ${FAKE_ENV.CHATGPT_TOTP_SECRET}`;
  const out = redactSecrets(raw, FAKE_ENV);
  assert.ok(!out.includes(FAKE_ENV.CHATGPT_PASSWORD), 'password leaked');
  assert.ok(!out.includes(FAKE_ENV.CHATGPT_EMAIL), 'email leaked');
  assert.ok(!out.includes(FAKE_ENV.CHATGPT_TOTP_SECRET), 'totp secret leaked');
});

ok('any e-mail-shaped text is masked even if it is not ours', () => {
  const out = redactSecrets('Signed in as someone.else+tag@mail.co.uk', FAKE_ENV);
  assert.ok(!/someone\.else/.test(out));
  assert.ok(out.includes('[email redacted]'));
});

ok('bearer tokens and long opaque blobs are masked', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
  const out = redactSecrets(`Authorization: Bearer ${jwt}`, FAKE_ENV);
  assert.ok(!out.includes(jwt), 'token leaked');
});

ok('empty/short env values do not turn redaction into a wildcard', () => {
  const out = redactSecrets('hello world', { CHATGPT_EMAIL: '', CHATGPT_PASSWORD: 'a' });
  assert.strictEqual(out, 'hello world');
});

ok('sanitizeUrl keeps the screen identity but drops auth parameter values', () => {
  const out = sanitizeUrl('https://auth.openai.com/authorize?client_id=abc&code=SECRETCODE&state=SECRETSTATE');
  assert.ok(out.startsWith('https://auth.openai.com/authorize'), out);
  assert.ok(out.includes('client_id=abc'));
  assert.ok(!out.includes('SECRETCODE'), 'code leaked');
  assert.ok(!out.includes('SECRETSTATE'), 'state leaked');
});

ok('sanitizeUrl survives a garbage url', () => {
  assert.strictEqual(sanitizeUrl('not a url?code=x'), 'not a url');
  assert.strictEqual(sanitizeUrl(''), '');
});

// ---------------------------------------------------------------- classifier

const EMPTY_INPUTS = { email: false, password: false, otp: false, noAuthModal: false };

ok('Cloudflare interstitial is named, not reported as a timeout', () => {
  const r = classifyLoginBlocker({
    url: 'https://chatgpt.com/auth/login',
    title: 'Just a moment...',
    bodyText: 'Checking your browser before accessing chatgpt.com',
    buttons: [],
    iframes: ['challenges.cloudflare.com'],
    inputs: EMPTY_INPUTS,
  });
  assert.strictEqual(r.blocker, 'cloudflare_challenge');
  assert.ok(r.evidence.length > 0);
});

ok('turnstile iframe alone is enough to name Cloudflare', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: 'Log in',
    bodyText: '',
    buttons: ['Continue'],
    iframes: ['challenges.cloudflare.com (Widget containing a Cloudflare security challenge)'],
    inputs: { ...EMPTY_INPUTS, email: true },
  });
  assert.strictEqual(r.blocker, 'cloudflare_challenge');
});

ok('captcha screen is classified', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: 'Verify',
    bodyText: 'Please solve this puzzle to continue',
    buttons: [],
    iframes: ['newassets.hcaptcha.com'],
    inputs: EMPTY_INPUTS,
  });
  assert.strictEqual(r.blocker, 'captcha');
});

ok('attempt lockout is classified as rate_limited', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: 'Log in',
    bodyText: '',
    banners: ['Too many attempts. Please try again later.'],
    buttons: [],
    iframes: [],
    inputs: { ...EMPTY_INPUTS, email: true },
  });
  assert.strictEqual(r.blocker, 'rate_limited');
});

ok('wrong credentials are classified separately from a lockout', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: 'Log in',
    bodyText: '',
    banners: ['Incorrect email or password. Please try again.'],
    buttons: [],
    iframes: [],
    inputs: { ...EMPTY_INPUTS, password: true },
  });
  assert.strictEqual(r.blocker, 'credentials_rejected');
});

ok('"verify it is you" / e-mail confirmation is device_verification', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: 'Verify your identity',
    bodyText: "We sent a code to your email. Help us keep your account safe.",
    buttons: ['Resend'],
    iframes: [],
    inputs: EMPTY_INPUTS,
  });
  assert.strictEqual(r.blocker, 'device_verification');
});

ok('a bare one-time-code input is mfa_required', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: '',
    bodyText: '',
    buttons: [],
    iframes: [],
    inputs: { ...EMPTY_INPUTS, otp: true },
  });
  assert.strictEqual(r.blocker, 'mfa_required');
});

ok('auth page with none of the expected fields = login_form_changed', () => {
  const r = classifyLoginBlocker({
    url: 'https://chatgpt.com/auth/login',
    title: 'ChatGPT',
    bodyText: 'Welcome back',
    buttons: ['Continue with Google', 'Continue with Apple'],
    iframes: [],
    inputs: EMPTY_INPUTS,
  });
  assert.strictEqual(r.blocker, 'login_form_changed');
});

ok('a plain slow login form is not force-classified', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: 'Log in',
    bodyText: 'Welcome back',
    buttons: ['Continue'],
    iframes: [],
    inputs: { ...EMPTY_INPUTS, email: true },
  });
  assert.strictEqual(r.blocker, 'unknown');
});

ok('classifier evidence is redacted', () => {
  const r = classifyLoginBlocker({
    url: 'https://auth.openai.com/log-in',
    title: '',
    bodyText: `Incorrect password for ${FAKE_ENV.CHATGPT_EMAIL}`,
    buttons: [],
    iframes: [],
    inputs: EMPTY_INPUTS,
  });
  assert.strictEqual(r.blocker, 'credentials_rejected');
  assert.ok(!r.evidence.includes(FAKE_ENV.CHATGPT_EMAIL), 'evidence leaked the email');
});

ok('every blocker label the classifier can emit is a declared label', () => {
  const emitted = [
    'cloudflare_challenge', 'captcha', 'rate_limited', 'credentials_rejected',
    'device_verification', 'mfa_required', 'login_form_changed', 'unknown',
  ];
  for (const e of emitted) assert.ok(LOGIN_BLOCKERS.includes(e), `${e} missing from LOGIN_BLOCKERS`);
});

// ---------------------------------------------------------------- rotation

ok('rotateDiagFiles keeps the newest N incident pairs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
  for (const stamp of ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23']) {
    fs.writeFileSync(path.join(dir, `login-fail-${stamp}-password-field.jpg`), 'x');
    fs.writeFileSync(path.join(dir, `login-fail-${stamp}-password-field.json`), '{}');
  }
  fs.writeFileSync(path.join(dir, 'session.json'), '{}'); // unrelated file must survive
  rotateDiagFiles(dir, 2);
  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes('session.json'), 'rotation deleted an unrelated file');
  assert.ok(left.includes('login-fail-2026-07-23-password-field.jpg'));
  assert.ok(left.includes('login-fail-2026-07-22-password-field.json'));
  assert.ok(!left.some((n) => n.includes('2026-07-20')), 'stale incident not rotated out');
  assert.ok(!left.some((n) => n.includes('2026-07-21')), 'stale incident not rotated out');
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('rotateDiagFiles on a missing directory is a no-op', () => {
  assert.deepStrictEqual(rotateDiagFiles('/nonexistent/gwg-diag', 5), []);
});

// ------------------------------------------------------- captureLoginFailure

function fakePage(observation, { screenshotFails = false } = {}) {
  const calls = { screenshots: [], masked: false };
  return {
    calls,
    url: () => observation.url,
    evaluate: async () => observation,
    locator: (sel) => { if (sel === 'input') calls.masked = true; return { first: () => ({}) }; },
    screenshot: async (opts) => {
      if (screenshotFails) throw new Error('screenshot boom');
      calls.screenshots.push(opts);
      fs.writeFileSync(opts.path, 'JPEGDATA');
    },
  };
}

(async () => {
  await okAsync('captureLoginFailure writes a named, redacted report + masked screenshot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    const prevEnv = { ...process.env };
    Object.assign(process.env, FAKE_ENV);
    try {
      const page = fakePage({
        url: 'https://auth.openai.com/log-in?code=SECRETCODE',
        title: 'Just a moment...',
        bodyText: `Checking your browser. Signed in as ${FAKE_ENV.CHATGPT_EMAIL}`,
        banners: [`password ${FAKE_ENV.CHATGPT_PASSWORD} rejected`],
        buttons: ['Log in', 'Sign up for free'],
        iframes: ['challenges.cloudflare.com'],
        inputs: { email: true, password: false, otp: false, noAuthModal: false },
      });
      const err = new Error(`locator.waitFor: Timeout 15000ms exceeded (pw ${FAKE_ENV.CHATGPT_PASSWORD})`);
      const res = await captureLoginFailure(page, { step: 'password-field', error: err, dir, keep: 5 });

      assert.strictEqual(res.blocker, 'cloudflare_challenge', 'blocker not named');
      assert.strictEqual(res.files.length, 2, 'expected a .jpg and a .json artifact');
      assert.ok(page.calls.masked, 'screenshot did not mask input fields');
      assert.strictEqual(page.calls.screenshots[0].type, 'jpeg');

      const written = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
      assert.ok(!written.includes(FAKE_ENV.CHATGPT_PASSWORD), 'password leaked into the report');
      assert.ok(!written.includes(FAKE_ENV.CHATGPT_EMAIL), 'email leaked into the report');
      assert.ok(!written.includes('SECRETCODE'), 'auth code leaked into the report');

      const report = JSON.parse(fs.readFileSync(res.files.find((f) => f.endsWith(".json")), "utf8"));
      assert.strictEqual(report.step, 'password-field');
      assert.strictEqual(report.blocker, 'cloudflare_challenge');
      assert.ok(report.url.startsWith('https://auth.openai.com/log-in'), 'url missing from report');
      assert.deepStrictEqual(report.buttons, ['Log in', 'Sign up for free']);
      assert.strictEqual(report.inputs.password, false, 'input inventory missing');
      assert.ok(report.error.includes('Timeout 15000ms'), 'underlying error missing');
    } finally {
      process.env = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('captureLoginFailure never throws when the page is unusable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    try {
      const broken = {
        url: () => { throw new Error('page closed'); },
        evaluate: async () => { throw new Error('Execution context was destroyed'); },
        locator: () => ({ first: () => ({}) }),
        screenshot: async () => { throw new Error('screenshot boom'); },
      };
      const res = await captureLoginFailure(broken, { step: 'chat ready', error: new Error('boom'), dir, keep: 5 });
      assert.strictEqual(res.blocker, 'unknown');
      // The JSON report must still be written even without a screenshot.
      assert.ok(fs.readdirSync(dir).some((n) => n.endsWith('.json')), 'no report written');
      assert.ok(fs.readdirSync(dir).every((n) => !n.endsWith('.jpg')), 'unexpected screenshot');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('a hung page.evaluate cannot hang the diagnostics', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    const prevTimeout = process.env.LOGIN_DIAG_TIMEOUT_MS;
    process.env.LOGIN_DIAG_TIMEOUT_MS = '50';
    try {
      const hung = {
        url: () => 'https://chatgpt.com/auth/login',
        evaluate: () => new Promise(() => {}), // never settles, like a wedged renderer
        locator: () => ({ first: () => ({}) }),
        screenshot: async (opts) => { fs.writeFileSync(opts.path, 'JPEGDATA'); },
      };
      const started = Date.now();
      const res = await captureLoginFailure(hung, { step: 'password-field', error: new Error('boom'), dir, keep: 5 });
      assert.ok(Date.now() - started < 3000, 'diagnostics blocked on the hung page');
      // The URL is still recoverable via page.url() even when evaluate() is dead.
      const report = JSON.parse(fs.readFileSync(res.files.find((f) => f.endsWith(".json")), "utf8"));
      assert.ok(report.url.includes('/auth/login'), 'url lost');
      assert.ok(/did not answer/.test(report.evaluateError || ''), 'deadline not reported');
    } finally {
      if (prevTimeout === undefined) delete process.env.LOGIN_DIAG_TIMEOUT_MS;
      else process.env.LOGIN_DIAG_TIMEOUT_MS = prevTimeout;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('rotation runs BEFORE writing, so a full volume still gets reclaimed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    try {
      for (const stamp of ['2020-01-01', '2020-01-02', '2020-01-03']) {
        fs.writeFileSync(path.join(dir, `login-fail-${stamp}-x.jpg`), 'x');
        fs.writeFileSync(path.join(dir, `login-fail-${stamp}-x.json`), '{}');
      }
      const page = fakePage({ url: 'https://chatgpt.com/auth/login', title: '', bodyText: '', banners: [], buttons: [], iframes: [], inputs: {} });
      page.screenshot = async () => { throw new Error('ENOSPC: no space left on device'); };
      await captureLoginFailure(page, { step: 'goto-login', error: new Error('boom'), dir, keep: 3 });
      const groups = new Set(fs.readdirSync(dir).map((n) => n.replace(/\.(jpg|json)$/, '')));
      assert.strictEqual(groups.size, 3, `expected 3 incidents kept, got ${[...groups]}`);
      assert.ok(!fs.readdirSync(dir).some((n) => n.includes('2020-01-01')), 'oldest not reclaimed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('screenshots can be turned off entirely', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    process.env.LOGIN_DIAG_SCREENSHOTS = '0';
    try {
      const page = fakePage({ url: 'https://chatgpt.com/auth/login', title: '', bodyText: '', banners: [], buttons: [], iframes: [], inputs: {} });
      const res = await captureLoginFailure(page, { step: 'chat-ready', error: new Error('boom'), dir, keep: 5 });
      assert.strictEqual(res.files.length, 1, 'screenshot written despite being disabled');
      assert.strictEqual(page.calls.screenshots.length, 0);
    } finally {
      delete process.env.LOGIN_DIAG_SCREENSHOTS;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('captureLoginFailure rotates old artifacts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    try {
      for (const stamp of ['2020-01-01', '2020-01-02', '2020-01-03']) {
        fs.writeFileSync(path.join(dir, `login-fail-${stamp}-x.jpg`), 'x');
        fs.writeFileSync(path.join(dir, `login-fail-${stamp}-x.json`), '{}');
      }
      const page = fakePage({ url: 'https://chatgpt.com/auth/login', title: '', bodyText: '', banners: [], buttons: [], iframes: [], inputs: {} });
      await captureLoginFailure(page, { step: 'goto-login', error: new Error('boom'), dir, keep: 2 });
      const groups = new Set(fs.readdirSync(dir).map((n) => n.replace(/\.(jpg|json)$/, '')));
      assert.strictEqual(groups.size, 2, `expected 2 incidents kept, got ${[...groups]}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('a caller hint names a header-only Cloudflare block the DOM cannot see', async () => {
    // The real shape: retries spent on `403 cf-mitigated: challenge`, page still blank. The
    // DOM classifier's fallback for an empty auth page is `login_form_changed` — a wrong
    // answer that sends the next reader hunting a UI redesign (Codex review, round 3).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    try {
      const page = fakePage({
        url: 'https://chatgpt.com/auth/login', title: '', bodyText: '',
        banners: [], buttons: [], iframes: [], inputs: {},
      });
      const bare = await captureLoginFailure(page, {
        step: 'goto-login', error: new Error('challenge did not clear'), dir, keep: 3,
      });
      assert.strictEqual(bare.blocker, 'login_form_changed', 'precondition: the DOM alone misreads this');

      const hinted = await captureLoginFailure(page, {
        step: 'goto-login', error: new Error('challenge did not clear'),
        blockerHint: 'cloudflare_challenge', dir, keep: 3,
      });
      assert.strictEqual(hinted.blocker, 'cloudflare_challenge');
      assert.ok(LOGIN_BLOCKERS.includes(hinted.blocker), 'the hint must be a declared label');
      assert.match(hinted.evidence, /reported by the caller/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('a confident DOM verdict beats the caller hint', async () => {
    // The hint fills a gap; it does not overrule evidence the caller never had.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-diag-'));
    try {
      const page = fakePage({
        url: 'https://auth.openai.com/log-in', title: 'Log in',
        bodyText: 'Too many attempts. Please try again later.',
        banners: [], buttons: [], iframes: [], inputs: { email: true },
      });
      const r = await captureLoginFailure(page, {
        step: 'submit-password', error: new Error('boom'),
        blockerHint: 'cloudflare_challenge', dir, keep: 3,
      });
      assert.strictEqual(r.blocker, 'rate_limited');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


// ------------------------------------------------- frame graph in the capture

// A page whose DOM walk reports `domIframes` and whose Playwright frame graph reports
// `graphHosts`. The 2026-07-27 capture said `iframes: []` for a page that visibly had a
// Cloudflare widget, because the DOM walk cannot see through a shadow root — these pin the
// merge that fixes it.
function fakeDiagPage({ domIframes = [], graphHosts = [] } = {}) {
  const main = { url: () => 'https://auth.openai.com/' };
  return {
    url: () => 'https://auth.openai.com/',
    mainFrame: () => main,
    frames: () => [main, ...graphHosts.map((h) => ({ url: () => `https://${h}/x` }))],
    async evaluate() {
      return {
        url: 'https://auth.openai.com/',
        title: 'Just a moment...',
        bodyText: 'Performing security verification',
        banners: [],
        buttons: ['Cloudflare'],
        iframes: domIframes,
        inputs: { email: false, password: false, otp: false, noAuthModal: false },
      };
    },
  };
}

await okAsync('the frame graph reaches the capture even when the DOM sees no iframes', async () => {
  const page = fakeDiagPage({ domIframes: [], graphHosts: ['challenges.cloudflare.com'] });
  const obs = await collectPageDiagnostics(page);
  assert.ok(
    obs.iframes.some((f) => f.startsWith('challenges.cloudflare.com')),
    `expected the challenge host in ${JSON.stringify(obs.iframes)}`,
  );
});

await okAsync('a crowded DOM cannot push the challenge host out of the capture', async () => {
  // Ten ordinary iframes used to fill the list first and the graph entries were appended, so
  // the final slice(0, 10) dropped the one entry the fix exists to surface.
  const page = fakeDiagPage({
    domIframes: Array.from({ length: 10 }, (_, i) => `cdn${i}.openai.com`),
    graphHosts: ['challenges.cloudflare.com'],
  });
  const obs = await collectPageDiagnostics(page);
  assert.ok(
    obs.iframes.some((f) => f.startsWith('challenges.cloudflare.com')),
    `challenge host was crowded out: ${JSON.stringify(obs.iframes)}`,
  );
});

await okAsync('a challenge visible only to the frame graph still classifies correctly', async () => {
  const page = fakeDiagPage({ domIframes: [], graphHosts: ['challenges.cloudflare.com'] });
  const obs = await collectPageDiagnostics(page);
  const { blocker } = classifyLoginBlocker(obs);
  assert.strictEqual(blocker, 'cloudflare_challenge');
});

await okAsync('the same host is not listed twice by the two collectors', async () => {
  const page = fakeDiagPage({
    domIframes: ['challenges.cloudflare.com'],
    graphHosts: ['challenges.cloudflare.com'],
  });
  const obs = await collectPageDiagnostics(page);
  const hits = obs.iframes.filter((f) => f.startsWith('challenges.cloudflare.com'));
  assert.strictEqual(hits.length, 1, `duplicated: ${JSON.stringify(obs.iframes)}`);
});

ok('an auth route error is not filed as a changed login form', () => {
  // The screen seen right after the password submit on 2026-07-27. Filing it as
  // `login_form_changed` sends the next investigation looking for a UI redesign.
  const { blocker } = classifyLoginBlocker({
    title: 'Oops, an error occurred! - OpenAI',
    bodyText: 'Oops, an error occurred! Route Error (400 Invalid content type: text/html; charset=UTF-8)',
    buttons: ['Try again'],
    iframes: ['sentinel.openai.com (frame-graph)'],
    url: 'https://auth.openai.com/log-in/password',
    inputs: { email: false, password: false, otp: false },
  });
  assert.strictEqual(blocker, 'auth_route_error');
});

ok('a Cloudflare page still wins over the route-error wording', () => {
  const { blocker } = classifyLoginBlocker({
    title: 'Just a moment...',
    bodyText: 'Performing security verification. Oops, an error occurred!',
    buttons: [], iframes: [], url: 'https://auth.openai.com/',
    inputs: { email: false, password: false, otp: false },
  });
  assert.strictEqual(blocker, 'cloudflare_challenge');
});

  console.log(`\nAll ${passed} login-diagnostics tests passed.`);
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
