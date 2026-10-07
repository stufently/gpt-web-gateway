// TOTP step of auto-login. Tests drive it with a fake page and a virtual clock.
//
// 2026-10-07 the 10s wait missed the new MFA screen and the step skipped. A miss
// on `/mfa-challenge` must fail the step so `step()` saves a diagnostic snapshot.

const DEFAULT_TOTP_PROMPT_TIMEOUT_SEC = 30;
const POLL_MS = 500;

// `Number.isFinite` rejects `Infinity`, which would otherwise turn the wait into a hang.
function promptTimeoutMs() {
  const raw = Number(process.env.TOTP_PROMPT_TIMEOUT_SEC);
  const sec = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOTP_PROMPT_TIMEOUT_SEC;
  return sec * 1000;
}

const SINGLE_SELECTORS = [
  'input[name="code"]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[type="tel"]',
  'input[maxlength="6"]',
];

const MFA_COPY_RE = /code from (?:your |the )?(?:app|authenticator)|authenticator app|authentication app|код из приложения/i;
const POST_SUBMIT_POLLS = 20;

function emit(opts, message) {
  const log = opts && typeof opts.log === 'function' ? opts.log : console.log;
  log(message);
}

function isMfaUrl(url) {
  const value = String(url || '');
  // Only the auth host. `chatgpt.com/?q=/mfa` is a chat, not the challenge.
  // The path must be the segment `/mfa` or `/mfa-challenge`, not `/mfa-settings`.
  if (!onAuthHost(value)) return false;
  return /\/mfa-challenge(?:[/?#]|$)|\/mfa(?:[/?#]|$)/.test(value);
}

function onAuthHost(url) {
  return /auth\.openai\.com|auth0\.com/i.test(String(url || ''));
}

// Password submit already returned to the app, so this login is not waiting on a code.
function reachedApp(url) {
  const value = String(url || '');
  if (!value || isMfaUrl(value) || onAuthHost(value)) return false;
  return /chatgpt\.com|chat\.openai\.com/i.test(value);
}

function pageUrl(page) {
  return typeof page.url === 'function' ? page.url() : '';
}

function sleepMs(page, ms, opts) {
  // Tests advance a virtual clock through the fake page. Production sleeps in
  // Node so a frozen renderer cannot hold the budget open.
  if (opts && typeof opts.now === 'function' && page && typeof page.waitForTimeout === 'function') {
    return page.waitForTimeout(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `locator.count()` has no timeout. Race it against the time still in the budget
// so a dead renderer ends the step and `step()` can take its snapshot.
async function probeField(page, remainingMs) {
  let timer;
  const probe = findCodeField(page).then(
    (value) => ({ kind: 'value', value }),
    (error) => ({ kind: 'error', error }),
  );
  try {
    const result = await Promise.race([
      probe,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(1, remainingMs));
      }),
    ]);
    if (result.kind === 'error') throw result.error;
    return result.kind === 'value' ? result.value : null;
  } finally {
    clearTimeout(timer);
  }
}

function mintCode(secret, opts) {
  const generate = opts && typeof opts.generateTOTP === 'function'
    ? opts.generateTOTP
    : require('./auto-login').generateTOTP;
  const code = String(generate(secret) ?? '');
  if (!/^\d{6}$/.test(code)) {
    throw new Error('TOTP generator did not return a 6-digit code');
  }
  return code;
}

async function findSingleField(page) {
  for (const selector of SINGLE_SELECTORS) {
    const loc = page.locator(selector);
    const n = await loc.count();
    for (let i = 0; i < n; i += 1) {
      const item = loc.nth(i);
      if (!(await item.isVisible())) continue;
      // A one-character box is a segment of the code, not the whole field,
      // even when it is type=tel or autocomplete=one-time-code.
      if ((await item.getAttribute('maxlength')) === '1') continue;
      if (selector === 'input[maxlength="6"]') {
        // `maxlength` alone also matches a short password box. The code field is
        // a text, tel, number, or untyped input.
        const type = ((await item.getAttribute('type')) || '').toLowerCase();
        if (type !== '' && type !== 'text' && type !== 'tel' && type !== 'number') continue;
      }
      return { mode: 'single', fields: [item] };
    }
  }
  return null;
}

// Six visible one-character boxes in a row. A hidden input does not split the
// run; any other visible input does.
async function visibleSegmentRun(page) {
  const all = page.locator('input');
  const n = await all.count();
  const run = [];
  for (let i = 0; i < n; i += 1) {
    const item = all.nth(i);
    if (!(await item.isVisible())) continue;
    if ((await item.getAttribute('maxlength')) !== '1') {
      run.length = 0;
      continue;
    }
    run.push(item);
    if (run.length === 6) return run;
  }
  return null;
}

async function findCodeField(page) {
  const single = await findSingleField(page);
  if (single) return single;
  const segments = await visibleSegmentRun(page);
  if (segments) return { mode: 'segments', fields: segments };
  return null;
}

async function fillSixSegmentCode(fields, code) {
  for (let i = 0; i < 6; i += 1) {
    await fields[i].fill(code.charAt(i));
  }
}

async function submitCode(page, lastField) {
  const buttons = page.locator('button[type="submit"]');
  const count = await buttons.count();
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (!(await button.isVisible())) continue;
    await button.click();
    return;
  }
  await lastField.press('Enter');
}

function throwIfTotpError(url) {
  if (String(url).includes('error=totp')) {
    const err = new Error('TOTP code rejected (error=totp)');
    err.loginBlockerHint = 'mfa_required';
    throw err;
  }
}

async function rejectIfTotpError(page, opts) {
  // The click returns before a rejection redirect. Keep reading the URL until
  // the app itself is on screen, and read once more after the last pause.
  if (typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('domcontentloaded', { timeout: POLL_MS }).catch(() => {});
  }
  for (let attempt = 0; attempt <= POST_SUBMIT_POLLS; attempt += 1) {
    const url = String(pageUrl(page));
    throwIfTotpError(url);
    if (reachedApp(url)) return;
    if (attempt === POST_SUBMIT_POLLS) return;
    await sleepMs(page, POLL_MS, opts);
  }
}

async function enterCode(page, found, code, opts) {
  emit(opts, '[auto-login] Entering TOTP code...');
  if (found.mode === 'segments') {
    await fillSixSegmentCode(found.fields, code);
  } else {
    await found.fields[0].fill(code);
  }
  await submitCode(page, found.fields[found.fields.length - 1]);
  emit(opts, '[auto-login] Submitted TOTP');
  await rejectIfTotpError(page, opts);
}

async function pageCopy(page) {
  try {
    const body = page.locator('body');
    if (body && typeof body.innerText === 'function') {
      return String(await body.innerText({ timeout: 2000 }) || '');
    }
  } catch (e) {
    return '';
  }
  return '';
}

async function onMfa(page) {
  const url = pageUrl(page);
  if (isMfaUrl(url)) return true;
  // Copy is only a signal on the auth host. The word can appear in a chat transcript.
  if (!onAuthHost(url)) return false;
  return MFA_COPY_RE.test(await pageCopy(page));
}

// Resolves on a skip or a filled code. Rejects with `loginBlockerHint` when the
// MFA screen has no field, or the host rejects the code. `opts.now` shares a clock
// with `page.waitForTimeout`. `opts.generateTOTP` overrides the generator.
async function fillTotpStep(page, secret, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const deadline = now() + promptTimeoutMs();

  while (now() < deadline) {
    const found = await probeField(page, deadline - now());
    if (found) {
      await enterCode(page, found, mintCode(secret, opts), opts);
      return;
    }
    if (reachedApp(pageUrl(page))) break;
    if (now() >= deadline) break;
    const slice = Math.min(POLL_MS, deadline - now());
    if (slice <= 0) break;
    await sleepMs(page, slice, opts);
  }

  // The budget is spent. An MFA screen we never learned how to fill is a broken
  // step; a login that never showed one simply has no TOTP prompt.
  if (await onMfa(page)) {
    const err = new Error('TOTP prompt is on screen but the code field was not found');
    err.loginBlockerHint = 'login_form_changed';
    throw err;
  }
  emit(opts, '[auto-login] TOTP prompt not found — skipping');
}

module.exports = { fillTotpStep };
