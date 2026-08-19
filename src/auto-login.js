// src/auto-login.js
// Headless auto-login for ChatGPT using email + password + TOTP.
// Usage as module: await autoLogin(context)
// Usage as script: node src/auto-login.js
//
// Every step runs through `step()`, which on failure captures a full diagnostic bundle
// (page URL, on-page banner text, visible buttons, which inputs exist, a masked
// screenshot on the auth volume) and re-throws a typed error naming the screen that
// blocked the login — `cloudflare_challenge`, `captcha`, `rate_limited`,
// `device_verification`, `mfa_required`, `credentials_rejected`, `login_form_changed`.
// Before this, three separate outages left nothing but
// `Timeout 15000ms exceeded ... input[type="password"]` and the cause was unknowable.

const crypto = require('crypto');
const { getContext, saveSession, clearSession, closeBrowser, maybeHideWebdriverOnPage } = require('./browser');
const { captureLoginFailure, redactSecrets, sanitizeUrl } = require('./login-diagnostics');
const { gotoWithChallengeRetry } = require('./cf-navigate');
const { waitForThroughChallenge, waitForAnyThroughChallenge } = require('./turnstile');

// How long a post-submit field gets to appear.
//
// Was a flat 15 s, which is what turned the 2026-07-27 challenge into an outage: Cloudflare
// put a "Verify you are human" checkbox on the redirect after the email submit, the wait
// expired in front of it, and the failure was filed against the password field. A solve needs
// the click plus ~15 s of settling, so the budget has to be able to contain one.
// `Number.isFinite` and not just `||`: `LOGIN_FIELD_TIMEOUT_SEC=Infinity` parses to a number,
// survives the fallback, and turns the step into a wait that never ends.
const FIELD_TIMEOUT_SEC = Number(process.env.LOGIN_FIELD_TIMEOUT_SEC);
const FIELD_TIMEOUT_MS = Math.max(15, Number.isFinite(FIELD_TIMEOUT_SEC) && FIELD_TIMEOUT_SEC > 0
  ? FIELD_TIMEOUT_SEC
  : 60) * 1000;

// Both navigations below are plain GETs made BEFORE any credential is typed, so retrying them
// is free of side effects. They need the retry for the same reason the app-shell loader does:
// a Cloudflare challenge here used to end as "waited for the password field, gave up", which
// then armed the login cooldown — a recoverable challenge turned into a stuck session.
// Two, matching the default navigation budget in cf-navigate.js: a third attempt would be
// unreachable inside 90 s even with instant navigations, i.e. configuration that reads as a
// retry and never runs (Codex review, round 4).
const LOGIN_NAV_ATTEMPTS = 2;

function generateTOTP(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = [];
  let bits = 0, value = 0;
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xFF); }
  }
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter & 0xFFFFFFFF, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xF;
  return ((hmac.readUInt32BE(offset) & 0x7FFFFFFF) % 1000000).toString().padStart(6, '0');
}

// How long the composer gets to appear after the password submit.
//
// Env-driven since 2.8.2 because this budget is what bounds the Cloudflare challenge LOOP
// measured on 2026-07-27: each clear-then-re-challenge cycle costs ~15 s, so 60 s allowed
// exactly three before the step gave up. Whether that loop is finite is the open question;
// a bigger budget is the cheap way to ask it.
const CHAT_READY_SEC = Number(process.env.CHAT_READY_TIMEOUT_SEC);
const CHAT_READY_TIMEOUT_MS = Math.max(30, Number.isFinite(CHAT_READY_SEC) && CHAT_READY_SEC > 0
  ? CHAT_READY_SEC
  : 60) * 1000;

/**
 * Recover from OpenAI's own auth app failing its data request.
 *
 * Right after the password submit the flow can land on a Remix error page —
 * "Oops, an error occurred! Route Error (400 Invalid content type: text/html; charset=UTF-8)"
 * — which means that request was answered with HTML where it expected JSON. It is NOT a
 * changed login form, and it is not something a longer wait fixes. The page ships a
 * "Try again" button, which re-issues the request; taking it once is the app's own recovery
 * path, and by then a clearance cookie the first attempt lacked may well be set.
 *
 * Best-effort by design: returns false when this is some other screen, leaving the caller's
 * diagnosis untouched.
 */
async function recoverAuthRouteError(page) {
  const looksLikeRouteError = await page
    .evaluate(() => /route error|invalid content type|oops,? an error occurred/i
      .test((document.body && document.body.innerText) || ''))
    .catch(() => false);
  if (!looksLikeRouteError) return false;

  const button = page.locator('button:has-text("Try again"), a:has-text("Try again")').first();
  if (!await button.isVisible().catch(() => false)) return false;
  console.log('[auto-login] OpenAI auth route error — taking its own "Try again"');
  await button.click().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return true;
}

// Run one login step; on failure, diagnose the page before giving up.
async function step(page, name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.loginBlocker) throw e; // already diagnosed by a nested step
    // A step that knows what stopped it says so (`loginBlockerHint`); the page diagnosis
    // still runs and still wins when it finds something conclusive.
    const { blocker, evidence } = await captureLoginFailure(page, {
      step: name, error: e, blockerHint: e && e.loginBlockerHint,
    });
    const detail = evidence ? `: ${evidence}` : '';
    const err = new Error(
      `blocked at step "${name}" by ${blocker}${detail} (underlying: ${redactSecrets(e && e.message)})`,
    );
    err.code = 'login_failed';
    err.loginStep = name;
    err.loginBlocker = blocker;
    // Surfaced verbatim to API callers as `model_message` — the on-page reason, redacted.
    if (evidence) err.modelMessage = evidence;
    err.cause = e;
    throw err;
  }
}

async function autoLogin(context) {
  const email = process.env.CHATGPT_EMAIL;
  const password = process.env.CHATGPT_PASSWORD;
  const totpSecret = process.env.CHATGPT_TOTP_SECRET;

  if (!email || !password) {
    throw new Error('CHATGPT_EMAIL and CHATGPT_PASSWORD env vars are required for auto-login');
  }

  console.log('[auto-login] Starting headless login...');
  // Clear cookies so ChatGPT starts with a clean slate (no "Welcome back" modal)
  await clearSession();
  const page = await context.newPage();

  await maybeHideWebdriverOnPage(page);

  try {
    // Step 1: Navigate to ChatGPT
    // Deliberately ONE attempt here: this navigation only warms the origin, and the very
    // next step goes to /auth/login with the real retry budget. Two independent retry
    // sequences would double the time a login can spend before it either works or reports
    // (Codex review) without adding a chance the second one does not already give us.
    await step(page, 'goto-chatgpt', async () => {
      const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', {
        attempts: 1, label: 'auto-login',
      });
      console.log(`[auto-login] Loaded chatgpt.com${r.blocked ? ' (challenged — the login navigation will retry)' : ''}`);
    });

    // Step 2: Navigate directly to login URL.
    // С 2026-05+ ChatGPT может либо сразу отдать форму email (auth0 redirect), либо
    // показать промежуточную страницу с кнопкой "Log in". Поддерживаем оба варианта.
    await step(page, 'goto-login', async () => {
      console.log('[auto-login] Navigating to login page...');
      const nav = await gotoWithChallengeRetry(page, 'https://chatgpt.com/auth/login', {
        attempts: LOGIN_NAV_ATTEMPTS, label: 'auto-login',
      });
      // Fail HERE if the retries were spent on an interstitial. Continuing would surface the
      // same block later as "waited 15 s for the email field", which the classifier reads as
      // `login_form_changed` — a wrong diagnosis that sent a previous investigation looking
      // for a UI redesign (Codex review, round 2). Failing at this step keeps the blocker
      // labelled `cloudflare_challenge`, on the step that actually hit it.
      if (nav.blocked) {
        const e = new Error(`Cloudflare challenge did not clear after ${nav.attempts} navigation(s)`);
        // The interstitial often has no title yet, so the DOM classifier would fall back to
        // `login_form_changed`. We know better — say so.
        e.loginBlockerHint = 'cloudflare_challenge';
        throw e;
      }
      await page.waitForTimeout(3000);
      // Sanitized: auth redirects carry `code`/`state` in the query string.
      console.log('[auto-login] Auth URL after goto:', sanitizeUrl(page.url()));
    });

    // Step 3: Fill email — Auth0 uses name="username" or id="username".
    // Если email-инпут уже виден (новый flow с прямым редиректом) — пропускаем поиск Log in кнопки.
    const emailInput = page.locator(
      'input[name="username"], input[id="username"], input[type="email"], input[name="email"], input[id="email"]'
    ).first();
    await step(page, 'email-field', async () => {
      // A THREE-way race: the email field (new flow), the intermediate "Log in" button (old
      // flow), or a challenge standing in front of both. Waiting on the button alone was the
      // remaining hole — a challenge that landed before it burned the full wait without ever
      // attempting a click, which is the same failure the password step used to have.
      const loginBtn = page.locator('a:has-text("Log in"), button:has-text("Log in")').first();
      const hit = await waitForAnyThroughChallenge(page, [emailInput, loginBtn], {
        timeout: FIELD_TIMEOUT_MS, label: 'auto-login',
      });
      if (hit < 0) {
        throw new Error(
          `neither the email field nor a Log in button appeared within ` +
            `${Math.round(FIELD_TIMEOUT_MS / 1000)}s`,
        );
      }
      if (hit === 0) {
        console.log('[auto-login] Email field visible directly — skipping Log in button');
        return;
      }
      console.log('[auto-login] No email field yet — clicking intermediate Log in button');
      await loginBtn.click();
      await page.waitForLoadState('domcontentloaded');
      console.log('[auto-login] Auth URL after click:', sanitizeUrl(page.url()));
      // The click can land on a challenge just as easily as the redirect after it.
      if (!await waitForThroughChallenge(page, emailInput, {
        timeout: FIELD_TIMEOUT_MS, label: 'auto-login',
      })) {
        throw new Error(
          `email field did not appear within ${Math.round(FIELD_TIMEOUT_MS / 1000)}s`,
        );
      }
    });

    await step(page, 'submit-email', async () => {
      await emailInput.fill(email);
      console.log('[auto-login] Filled email');
      // Click Continue / Submit after email — use only type="submit" to avoid matching "Continue with Google"
      const emailSubmit = page.locator('button[type="submit"]').first();
      await emailSubmit.waitFor({ state: 'visible', timeout: 10000 });
      await emailSubmit.click();
      console.log('[auto-login] Submitted email');
    });

    // Step 4: Fill password.
    //
    // The wait races the field against a Cloudflare checkbox instead of only watching for the
    // field. This is the exact spot the 2026-07-27 outage died on: the challenge arrives on
    // the redirect that follows the email submit, so nothing in the navigation path ever sees
    // it, and a bare `waitFor` just expires in front of the widget.
    await step(page, 'password-field', async () => {
      const passwordInput = page.locator('input[type="password"]').first();
      const shown = await waitForThroughChallenge(page, passwordInput, {
        timeout: FIELD_TIMEOUT_MS,
        label: 'auto-login',
      });
      if (!shown) {
        // Let the page diagnosis in `step()` name the blocker: if the widget is still up it
        // reads `cloudflare_challenge`, and if the form genuinely changed it says so.
        throw new Error(
          `password field did not appear within ${Math.round(FIELD_TIMEOUT_MS / 1000)}s`,
        );
      }
      await passwordInput.fill(password);
      console.log('[auto-login] Filled password');

      const passwordSubmit = page.locator('button[type="submit"]').first();
      await passwordSubmit.waitFor({ state: 'visible', timeout: 10000 });
      await passwordSubmit.click();
      console.log('[auto-login] Submitted password');
    });

    // Step 5: TOTP (if prompted)
    if (totpSecret) {
      await step(page, 'totp', async () => {
        const otpInput = page.locator(
          'input[name="code"], input[autocomplete="one-time-code"], input[type="text"][maxlength="6"]'
        ).first();
        const totpRequired = await otpInput.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        if (totpRequired) {
          const token = generateTOTP(totpSecret);
          console.log('[auto-login] Entering TOTP code...');
          await otpInput.fill(token);
          const totpSubmit = page.locator('button[type="submit"]').first();
          await totpSubmit.waitFor({ state: 'visible', timeout: 10000 });
          await totpSubmit.click();
          console.log('[auto-login] Submitted TOTP');
        } else {
          console.log('[auto-login] TOTP prompt not found — skipping');
        }
      });
    }

    // Step 6: Wait for ChatGPT to be ready (prompt-textarea visible).
    // NB: a visible composer is NOT proof of a session (ChatGPT renders it for anonymous
    // visitors too) — ensureLoggedIn() re-verifies against /api/auth/session afterwards.
    await step(page, 'chat-ready', async () => {
      console.log('[auto-login] Waiting for chat interface...');
      const composer = page.locator('#prompt-textarea, textarea').first();
      // The same race as the email and password steps, and for the same reason — measured on
      // production 2026-07-27: Cloudflare challenges the post-password navigation as well.
      // The `400 Invalid content type` that the "Try again" below recovers from is that
      // challenge answering an XHR with HTML; take the retry and it resolves into a plain
      // "Just a moment" interstitial, in front of which a bare wait simply expires.
      const visible = () => waitForThroughChallenge(page, composer, {
        timeout: CHAT_READY_TIMEOUT_MS, label: 'auto-login',
      });
      if (await visible()) {
        console.log('[auto-login] Login flow finished — chat interface rendered');
        return;
      }
      // Retry once through OpenAI's own error page before giving up — see the helper.
      if (!await recoverAuthRouteError(page) || !await visible()) {
        throw new Error(
          `chat interface did not render within ${Math.round(CHAT_READY_TIMEOUT_MS / 1000)}s`,
        );
      }
      console.log('[auto-login] Login flow finished — chat interface rendered after retry');
    });

    // Step 7: Save session
    await saveSession();
    console.log('[auto-login] Session saved');
  } finally {
    await page.close();
  }
}

// Standalone test runner
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    const context = await getContext();
    try {
      await autoLogin(context);
      console.log('[auto-login] Done. Session saved to auth/session.json');
    } finally {
      await closeBrowser();
    }
    process.exit(0);
  })().catch((err) => {
    console.error('[auto-login] FAILED:', redactSecrets(err.message));
    process.exit(1);
  });
}

module.exports = { autoLogin, generateTOTP };
