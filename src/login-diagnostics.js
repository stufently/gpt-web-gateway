// Auto-login failure diagnostics.
//
// Why this exists: through three outages (2026-07-10 / 07-22 / 07-25) the only trace an
// auto-login failure ever left was a bare Playwright line —
//   `auto-login failed: locator.waitFor: Timeout 15000ms exceeded ... input[type="password"]`
// — with no page URL, no on-page error text and no screenshot. Which screen actually
// blocked the login (Cloudflare interstitial, captcha, "verify it's you", an attempt
// lockout, or a redesigned form) was therefore *unknowable* after the fact, and each
// incident had to be re-diagnosed by hand.
//
// This module turns any failed login step into a named, machine-readable cause plus a
// durable artifact:
//   - `classifyLoginBlocker()` — pure, unit-tested screen classifier
//   - `collectPageDiagnostics()` — one bounded page.evaluate: url, title, banners,
//      visible button labels, which inputs exist, iframe hosts
//   - `captureLoginFailure()` — logs the above and writes a masked screenshot + JSON
//      report into a directory that survives a pod restart (the auth PVC), rotated.
//
// Secret hygiene: every string that leaves this module goes through `redactSecrets()`
// (credentials from env, e-mail-shaped text, bearer/long opaque tokens), URLs drop the
// values of auth-ish query params, and screenshots are taken with every `<input>` masked
// by Playwright so a typed e-mail cannot end up in an image.

const fs = require('fs');
const path = require('path');

// Stable blocker labels — used as a Prometheus label value and in error messages, so the
// alerting side can key on them. Do not rename without updating the dashboards/README.
const LOGIN_BLOCKERS = [
  'cloudflare_challenge',
  'captcha',
  'rate_limited',
  'credentials_rejected',
  'device_verification',
  'mfa_required',
  'auth_route_error',
  'login_form_changed',
  'unknown',
];

const REDACTED = '[redacted]';
const MAX_TEXT = 1500;
const MAX_BUTTONS = 25;
const MAX_EVIDENCE = 200;

// ---------------------------------------------------------------- redaction

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Values that must never reach a log line, a JSON report or an API error body.
function secretValues(env = process.env) {
  return [env.CHATGPT_EMAIL, env.CHATGPT_PASSWORD, env.CHATGPT_TOTP_SECRET, env.API_KEY]
    .filter((v) => typeof v === 'string' && v.trim().length >= 3)
    .map((v) => v.trim());
}

function redactSecrets(input, env = process.env) {
  if (input == null) return '';
  let out = String(input);
  for (const secret of secretValues(env)) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'gi'), REDACTED);
  }
  // Generic shapes, in case the page echoes something we did not put there.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email redacted]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);
  // Long opaque blobs (JWTs, session tokens, TOTP secrets pasted into the DOM). `/` is
  // deliberately NOT in the class: including it would swallow long URLs, and the page URL
  // is the single most useful field in a login-failure report.
  out = out.replace(/\b[A-Za-z0-9._~+-]{40,}={0,2}\b/g, REDACTED);
  return out;
}

const SENSITIVE_PARAMS =
  /^(code|state|token|id_token|access_token|refresh_token|session|session_token|login_hint|email|username|password|otp|nonce|ticket)$/i;

// Keep origin + path (that is the diagnostic value: *which screen* are we on) and the
// parameter NAMES, but never their values — auth flows carry codes and tokens there.
function sanitizeUrl(rawUrl) {
  if (!rawUrl) return '';
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return redactSecrets(String(rawUrl).split('?')[0]);
  }
  const params = [];
  for (const key of u.searchParams.keys()) {
    if (params.includes(key)) continue;
    const value = u.searchParams.get(key);
    if (SENSITIVE_PARAMS.test(key) || (value && value.length > 24)) params.push(`${key}=${REDACTED}`);
    else params.push(`${key}=${redactSecrets(value)}`);
    if (params.length >= 8) break;
  }
  const qs = params.length ? `?${params.join('&')}` : '';
  return redactSecrets(`${u.origin}${u.pathname}${qs}`);
}

// ---------------------------------------------------------------- classifier

// Ordered: the first rule that matches wins. Cloudflare/captcha come first because those
// pages also contain generic "try again" wording that would otherwise look like a lockout.
const BLOCKER_RULES = [
  {
    blocker: 'cloudflare_challenge',
    re: /just a moment|checking (your|if the site connection is) (browser|secure)|verify (you are|you're) human|подождите|проверяем|cf-chl|challenges\.cloudflare\.com|cloudflare turnstile|cf_chl_opt|attention required/i,
  },
  {
    blocker: 'captcha',
    re: /recaptcha|hcaptcha|arkoselabs|funcaptcha|geetest|i'?m not a robot|я не робот|select all (images|squares)|solve (the|this) (puzzle|captcha)|captcha/i,
  },
  {
    // OpenAI's own auth app failing its data request, NOT a changed form. Seen immediately
    // after the password submit: the Remix route gets HTML where it expects JSON and renders
    // "Oops, an error occurred!". Classified separately because `login_form_changed` sends the
    // next investigation looking for a UI redesign that did not happen (Codex review).
    blocker: 'auth_route_error',
    re: /route error|invalid content type|oops,? an error occurred/i,
  },
  {
    blocker: 'rate_limited',
    re: /too many (attempts|requests|failed)|try again (later|in a few)|temporarily (blocked|locked|unavailable)|access (temporarily )?blocked|rate.?limit|account (is )?locked|слишком много/i,
  },
  {
    blocker: 'credentials_rejected',
    re: /incorrect (e-?mail|username|password)|wrong (e-?mail|password)|invalid (e-?mail|username|password|credentials|login)|password you entered is incorrect|(we )?(could ?n'?t|cannot|can'?t) find (an? )?account|no account (found|exists)|неверный (логин|пароль)/i,
  },
  {
    blocker: 'device_verification',
    re: /verify (it'?s )?(you|your identity|your device|your e-?mail)|check your (e-?mail|inbox)|we (sent|have sent) (you )?(a|an) (code|link|e-?mail)|confirm your (identity|account|e-?mail)|unusual (activity|sign.?in)|suspicious (activity|login)|help us keep your account safe|подтвердите/i,
  },
  {
    blocker: 'mfa_required',
    re: /two.?factor|2fa|multi.?factor|authenticator app|one.?time (code|password)|enter the (6|six).?digit|verification code|код подтверждения/i,
  },
];

/**
 * Classify *which screen* stopped the login, from an already-collected page observation.
 * Pure — no Playwright, no I/O — so it is unit-testable against captured fixtures.
 *
 * @param {object} obs  output shape of collectPageDiagnostics()
 * @returns {{blocker: string, evidence: string}}
 */
function classifyLoginBlocker(obs = {}) {
  const haystacks = [
    obs.title,
    obs.bodyText,
    ...(Array.isArray(obs.banners) ? obs.banners : []),
    ...(Array.isArray(obs.buttons) ? obs.buttons : []),
    ...(Array.isArray(obs.iframes) ? obs.iframes : []),
    obs.url,
  ]
    .filter((s) => typeof s === 'string' && s)
    .map((s) => s.slice(0, MAX_TEXT));

  for (const rule of BLOCKER_RULES) {
    for (const hay of haystacks) {
      const m = hay.match(rule.re);
      if (m) {
        const at = Math.max(0, m.index - 60);
        return {
          blocker: rule.blocker,
          evidence: redactSecrets(hay.slice(at, at + MAX_EVIDENCE).replace(/\s+/g, ' ').trim()),
        };
      }
    }
  }

  // An OTP box with no matching copy is still an MFA prompt.
  if (obs.inputs && obs.inputs.otp) {
    return { blocker: 'mfa_required', evidence: 'one-time-code input present' };
  }

  // We are somewhere in the auth flow but none of the expected fields are on screen and
  // nothing above matched → most likely the form itself changed (selector drift).
  const onAuth = /\/auth\/(login|signup)|auth0\.com|\/log-in|openai\.com\/auth/i.test(obs.url || '');
  if (onAuth && obs.inputs && !obs.inputs.email && !obs.inputs.password && !obs.inputs.otp) {
    return { blocker: 'login_form_changed', evidence: 'auth page with no email/password/otp input' };
  }

  return { blocker: 'unknown', evidence: '' };
}

// ---------------------------------------------------------------- page probe

// Node-side deadline. A hung renderer can leave `page.evaluate()` pending forever (its
// in-page timers are hostage to the same event loop), and this code runs on the failure
// path of a login that is already in trouble — diagnostics must never become the thing
// that hangs it (Codex review).
function withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch((e) => ({ __diagError: (e && e.message) || String(e) })),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function diagTimeoutMs() {
  const n = parseInt(process.env.LOGIN_DIAG_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

// One bounded evaluate — cheap, and safe to run on a page that is mid-navigation
// (everything is wrapped by the caller). Collects only what the classifier needs.
async function collectPageDiagnostics(page, { timeoutMs = diagTimeoutMs() } = {}) {
  const raw = await withDeadline(
    page.evaluate(() => {
      const text = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return !!r && r.width > 0 && r.height > 0;
      };
      const banners = [];
      const bannerSel = [
        '[role="alert"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
        '[id^="error"]',
        '[class*="error"]',
        '[data-testid*="error"]',
      ].join(',');
      for (const el of Array.from(document.querySelectorAll(bannerSel)).slice(0, 40)) {
        const t = text(el);
        if (t && t.length < 400 && !banners.includes(t)) banners.push(t);
        if (banners.length >= 8) break;
      }
      const buttons = [];
      for (const el of Array.from(document.querySelectorAll('button, a[href], [role="button"]')).slice(0, 200)) {
        if (!visible(el)) continue;
        const t = (text(el) || el.getAttribute('aria-label') || '').slice(0, 60);
        if (t && !buttons.includes(t)) buttons.push(t);
        if (buttons.length >= 25) break;
      }
      // Shadow-piercing on purpose. A plain `document.querySelectorAll('iframe')` cannot see
      // an iframe that lives inside a shadow root, and that blindness is what made the
      // 2026-07-27 capture report `iframes: []` for a page whose own screenshot plainly showed
      // a Cloudflare Turnstile widget — the failure was then misfiled as "the login form
      // changed" and three fixes went looking for a UI redesign. Only OPEN roots are walkable
      // here; the closed ones are covered by the frame graph on the Node side, which is where
      // Cloudflare's own widget actually turns up.
      const iframeEls = [];
      const seenRoots = new Set();
      const collectFrames = (root, depth) => {
        if (!root || depth > 12 || seenRoots.has(root) || iframeEls.length >= 10) return;
        seenRoots.add(root);
        if (!root.querySelectorAll) return;
        for (const f of Array.from(root.querySelectorAll('iframe'))) {
          if (iframeEls.length >= 10) break;
          iframeEls.push(f);
        }
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.shadowRoot) collectFrames(el.shadowRoot, depth + 1);
        }
      };
      collectFrames(document, 0);
      const iframes = iframeEls.map((f) => {
        try {
          return new URL(f.src, location.href).host + (f.title ? ` (${f.title})` : '');
        } catch {
          return f.title || 'iframe';
        }
      });
      const has = (sel) => !!document.querySelector(sel);
      return {
        url: location.href,
        title: document.title || '',
        bodyText: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
        banners,
        buttons,
        iframes,
        inputs: {
          email: has('input[type="email"], input[name="username"], input[id="username"], input[name="email"], input[id="email"]'),
          password: has('input[type="password"]'),
          otp: has('input[name="code"], input[autocomplete="one-time-code"], input[type="text"][maxlength="6"]'),
          noAuthModal: has('#modal-no-auth-login, [data-testid="modal-no-auth-login"]'),
        },
      };
    }),
    timeoutMs,
    { __diagError: `page.evaluate did not answer within ${timeoutMs}ms` },
  );

  // page.url() works even when evaluate() fails (detached/renderer-crashed page).
  let fallbackUrl = '';
  try {
    fallbackUrl = page.url();
  } catch {}

  const failed = !raw || raw.__diagError;
  const obs = failed ? { evaluateError: (raw && raw.__diagError) || 'no diagnostics collected' } : raw;

  // Playwright's frame graph is built from CDP target information rather than DOM queries, so
  // it sees what the in-page walk above structurally cannot: a cross-origin iframe under a
  // CLOSED shadow root — exactly how Cloudflare ships Turnstile. Merged in rather than
  // replacing the DOM list, because the two answer different questions and a disagreement
  // between them is worth seeing in a capture. It also survives a failed `evaluate`, which is
  // when a capture needs every scrap of evidence it can still get.
  const graphFrames = [];
  try {
    const main = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
    for (const f of page.frames() || []) {
      if (f === main) continue;
      let host = '';
      try {
        host = new URL(f.url()).host;
      } catch {}
      if (host && !graphFrames.includes(host)) graphFrames.push(host);
    }
  } catch {}

  // Graph frames go FIRST. The list is capped at 10, and a page with ten ordinary iframes
  // would otherwise push the one entry this whole fix exists to surface —
  // `challenges.cloudflare.com` — straight off the end again. Dedup is by exact hostname; a
  // `startsWith` match would also swallow an unrelated `challenges.cloudflare.com.evil.test`.
  const hostOf = (entry) => String(entry).split(' ')[0];
  const domFrames = (obs.iframes || []).map((f) => redactSecrets(f));
  const allFrames = [
    ...graphFrames.map((h) => `${h} (frame-graph)`),
    ...domFrames.filter((f) => !graphFrames.includes(hostOf(f))),
  ];

  return {
    url: sanitizeUrl(obs.url || fallbackUrl),
    title: redactSecrets((obs.title || '').slice(0, 200)),
    bodyText: redactSecrets((obs.bodyText || '').slice(0, MAX_TEXT)),
    banners: (obs.banners || []).map((b) => redactSecrets(b)).slice(0, 8),
    buttons: (obs.buttons || []).map((b) => redactSecrets(b)).slice(0, MAX_BUTTONS),
    iframes: allFrames.slice(0, 10),
    inputs: obs.inputs || { email: false, password: false, otp: false, noAuthModal: false },
    evaluateError: obs.evaluateError ? redactSecrets(obs.evaluateError) : undefined,
  };
}

// ---------------------------------------------------------------- artifacts

// Screenshots and reports live next to session.json on the auth volume: it is the only
// directory that survives a pod restart, and it is private (never served over HTTP,
// unlike public/images) — a login screenshot is not something to publish.
function diagDir() {
  return process.env.LOGIN_DIAG_DIR || path.join(__dirname, '..', 'auth', 'diag');
}

function diagKeep() {
  const n = parseInt(process.env.LOGIN_DIAG_KEEP, 10);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

// Screenshots are the richest evidence but also the only artifact we cannot fully
// redact by construction — an escape hatch for anyone unwilling to store them.
function screenshotsEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.LOGIN_DIAG_SCREENSHOTS || '').trim());
}

// Keep the newest `keep` incidents (a .jpg + .json pair each), drop the rest, so the
// small auth PVC cannot fill up with screenshots.
function rotateDiagFiles(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const groups = new Set();
  for (const n of names) {
    if (n.startsWith('login-fail-')) groups.add(n.replace(/\.(jpg|json)$/i, ''));
  }
  // Names embed an ISO timestamp → lexicographic sort is chronological.
  const sorted = Array.from(groups).sort().reverse();
  const removed = [];
  for (const stale of sorted.slice(keep)) {
    for (const ext of ['.jpg', '.json']) {
      const p = path.join(dir, stale + ext);
      try {
        fs.unlinkSync(p);
        removed.push(p);
      } catch {}
    }
  }
  return removed;
}

function slug(s) {
  return String(s || 'step')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'step';
}

/**
 * Capture everything needed to explain a login failure after the fact. Never throws —
 * diagnostics must not be able to break the flow they are diagnosing.
 *
 * @returns {{blocker: string, evidence: string, report: object, files: string[]}}
 */
async function captureLoginFailure(
  page, { step, error, blockerHint, dir = diagDir(), keep = diagKeep() } = {},
) {
  const stepName = slug(step);
  const errMessage = redactSecrets((error && error.message) || String(error || 'unknown error'));
  let obs = { url: '', title: '', bodyText: '', banners: [], buttons: [], iframes: [], inputs: {} };
  try {
    obs = await collectPageDiagnostics(page);
  } catch (e) {
    obs.evaluateError = redactSecrets((e && e.message) || String(e));
  }

  let { blocker, evidence } = classifyLoginBlocker(obs);
  // The caller may KNOW what blocked it — e.g. a navigation that exhausted its Cloudflare
  // retries on a `cf-mitigated` response whose page has no title yet. The DOM classifier
  // cannot see that, and its fallback verdict for an empty auth page is `login_form_changed`,
  // which sends the reader looking for a UI redesign that never happened (Codex review).
  // The hint only fills in a weak verdict — a confident DOM match (captcha, rate limit,
  // rejected credentials) is evidence the caller did not have, and it wins.
  // Only a DECLARED label, and redacted on the way in: the hint travels on an error message
  // and must not be able to invent a blocker name or smuggle text into the report.
  const hint = LOGIN_BLOCKERS.includes(blockerHint) ? blockerHint : null;
  if (hint && (blocker === 'unknown' || blocker === 'login_form_changed')) {
    const note = redactSecrets(`reported by the caller: ${hint}`);
    evidence = evidence ? `${evidence}; ${note}` : note;
    blocker = hint;
  }
  const files = [];

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Rotate BEFORE writing, not only after: on a full volume the write throws straight
    // into the catch and the old files would never be reclaimed (Codex review).
    rotateDiagFiles(dir, Math.max(0, keep - 1));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `login-fail-${stamp}-${stepName}`);

    // The JSON report is the important artifact — write it FIRST, so a screenshot that
    // fails (or fills the disk) cannot cost us the textual diagnosis.
    const report = {
      at: new Date().toISOString(),
      step: stepName,
      blocker,
      evidence,
      error: errMessage,
      ...obs,
    };
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    files.push(`${base}.json`);

    if (screenshotsEnabled()) {
      // mask: Playwright paints over the matched elements *while rendering*, so nothing
      // sensitive exists in the image file (no DOM mutation, no state corruption).
      // Beyond form fields, mask anything rendering the configured e-mail as plain text —
      // "we sent a code to you@example.com" is exactly what a verification screen shows.
      const masks = [];
      if (page.locator) {
        masks.push(page.locator('input'), page.locator('textarea'), page.locator('[contenteditable]'));
        const email = (process.env.CHATGPT_EMAIL || '').trim();
        if (email && page.getByText) masks.push(page.getByText(email, { exact: false }));
      }
      await page
        .screenshot({ path: `${base}.jpg`, type: 'jpeg', quality: 55, timeout: 10000, mask: masks })
        .then(() => files.push(`${base}.jpg`))
        .catch((e) => console.log('[auto-login][diag] screenshot failed:', redactSecrets(e.message)));
    }
  } catch (e) {
    console.log('[auto-login][diag] could not persist diagnostics:', redactSecrets(e.message));
  }
  // Always re-rotate, including after a failed write, so a wedged volume self-heals.
  try {
    rotateDiagFiles(dir, keep);
  } catch {}

  // One grep-able line that answers "what stopped the login" without opening any file.
  console.log(
    `[auto-login][diag] step=${stepName} blocker=${blocker} url=${obs.url || '?'} ` +
      `title="${obs.title || ''}" inputs=email:${!!obs.inputs.email},password:${!!obs.inputs.password},otp:${!!obs.inputs.otp} ` +
      `banners=${JSON.stringify(obs.banners)} buttons=${JSON.stringify(obs.buttons)} ` +
      `iframes=${JSON.stringify(obs.iframes)} artifacts=${JSON.stringify(files)}`,
  );
  if (blocker !== 'unknown') {
    console.log(`[auto-login] BLOCKED by ${blocker} at step "${stepName}": ${evidence || errMessage}`);
  } else {
    console.log(`[auto-login] step "${stepName}" failed, no known blocker screen matched: ${errMessage}`);
  }

  return { blocker, evidence, report: { ...obs, step: stepName, blocker, evidence, error: errMessage }, files };
}

module.exports = {
  LOGIN_BLOCKERS,
  redactSecrets,
  sanitizeUrl,
  classifyLoginBlocker,
  collectPageDiagnostics,
  captureLoginFailure,
  rotateDiagFiles,
  diagDir,
  diagKeep,
};
