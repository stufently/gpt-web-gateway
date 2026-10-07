// Behaviour tests for src/totp-step.js against a FAKE page.
//
// No browser and no wall clock: `waitForTimeout` advances a virtual clock and `now`
// reads it, the same way scripts/test-cf-navigate.js drives a navigation budget.
// Each test names the production change that would make it fail.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { fillTotpStep } = require('../src/totp-step');

delete process.env.TOTP_PROMPT_TIMEOUT_SEC;

const CODE = '123456';
const generateTOTP = () => CODE;

let failures = 0;
function check(name, fn) {
  return fn().then(
    () => console.log(`PASS: ${name}`),
    (e) => {
      failures++;
      const kind = (e && e.name) || 'Error';
      const message = (e && e.message ? e.message : String(e)).split('\n')[0];
      console.log(`FAIL: ${name} — ${kind}: ${message}`);
    },
  );
}

/**
 * Inputs and buttons are plain attribute bags. `visible` may be a clock predicate.
 * `page.waitForTimeout` only moves the clock; nothing sleeps.
 */
function fakePage(opts = {}) {
  const state = {
    clock: 0,
    url: opts.url || 'https://chatgpt.com/',
    fills: [],
    presses: [],
    pressFields: [],
    clicks: [],
    logs: [],
  };
  const inputs = opts.inputs || [];
  const buttons = opts.buttons || [];

  function isVisible(el) {
    if (typeof el.visible === 'function') return !!el.visible(state.clock);
    if (el.visible === undefined) return true;
    return !!el.visible;
  }

  function matches(el, selector) {
    const tag = selector.startsWith('button') ? 'button' : 'input';
    if ((el.tag || 'input') !== tag) return false;
    const attrs = [...selector.matchAll(/\[([^\]=]+)="([^"]*)"\]/g)];
    return attrs.every((part) => String(el[part[1]] == null ? '' : el[part[1]]) === part[2]);
  }

  function listed(selector) {
    if (selector === 'body') return [{ tag: 'body', text: opts.bodyText || '' }];
    const pool = selector.startsWith('button') ? buttons : inputs;
    return pool.filter((el) => matches({ tag: selector.startsWith('button') ? 'button' : 'input', ...el }, selector));
  }

  function handle(el) {
    return {
      async isVisible() { return el ? isVisible(el) : false; },
      async getAttribute(name) {
        if (!el || el[name] == null || el[name] === '') return null;
        return String(el[name]);
      },
      async fill(value) {
        state.fills.push({
          value: String(value),
          name: el.name || null,
          type: el.type || null,
          maxlength: el.maxlength || null,
        });
      },
      async press(key) {
        state.presses.push(key);
        state.pressFields.push(el && el.id != null ? el.id : null);
      },
      async click() {
        state.clicks.push(el.id || el.type || 'button');
        if (typeof opts.urlAfterSubmit === 'string') state.url = opts.urlAfterSubmit;
      },
      async innerText() { return (el && el.text) || ''; },
    };
  }

  function locator(selector) {
    return {
      async count() { return listed(selector).length; },
      nth(i) { return handle(listed(selector)[i]); },
      first() { return this.nth(0); },
      async innerText() {
        if (selector === 'body') return opts.bodyText || '';
        const el = listed(selector)[0];
        return (el && el.text) || '';
      },
    };
  }

  return {
    state,
    now: () => state.clock,
    log: (line) => state.logs.push(String(line)),
    page: {
      url: () => state.url,
      locator,
      async waitForTimeout(ms) {
        state.clock += ms;
        if (typeof opts.errorAfterMs === 'number' && state.clock >= opts.errorAfterMs) {
          state.url = opts.urlWithError;
        }
      },
    },
  };
}

function withField(input, extra) {
  return fakePage({
    url: 'https://auth.openai.com/login',
    inputs: [input],
    buttons: [{ type: 'submit', visible: true }],
    bodyText: '',
    ...extra,
  });
}

async function fill(env, opts) {
  await fillTotpStep(env.page, 'SECRET', {
    now: env.now,
    log: env.log,
    generateTOTP,
    ...opts,
  });
  return env.state;
}

(async () => {
  const singleCases = [
    ['input[name="code"]', { name: 'code' }],
    ['input[autocomplete="one-time-code"]', { autocomplete: 'one-time-code' }],
    ['input[inputmode="numeric"]', { inputmode: 'numeric', type: 'text' }],
    ['input[type="tel"]', { type: 'tel' }],
    ['input[maxlength="6"]', { maxlength: '6', type: 'text' }],
  ];
  for (const [selector, input] of singleCases) {
    await check(`single field ${selector} is filled with the whole code`, async () => {
      const state = await fill(withField({ ...input, visible: true }));
      assert.deepStrictEqual(state.fills.map((f) => f.value), [CODE], selector);
      assert.deepStrictEqual(state.clicks, ['submit']);
      assert.deepStrictEqual(state.presses, []);
    });
  }

  await check('maxlength=6 accepts type=number and an input with no type', async () => {
    for (const input of [{ maxlength: '6', type: 'number' }, { maxlength: '6' }]) {
      const state = await fill(withField({ ...input, visible: true }));
      assert.deepStrictEqual(state.fills.map((f) => f.value), [CODE]);
    }
  });

  await check('maxlength=6 on a password input is not the TOTP field', async () => {
    // A password box that happens to cap at 6 characters must not swallow the code.
    const state = await fill(withField({ maxlength: '6', type: 'password', visible: true }));
    assert.deepStrictEqual(state.fills, []);
    assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
  });

  await check('six visible maxlength=1 inputs receive one digit each', async () => {
    const env = fakePage({
      url: 'https://chatgpt.com/',
      inputs: Array.from({ length: 6 }, () => ({ maxlength: '1', visible: true })),
      buttons: [{ type: 'submit', visible: true }],
    });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills.map((f) => f.value), CODE.split(''), 'one digit per box');
    assert.deepStrictEqual(state.clicks, ['submit']);
  });

  await check('six one-digit boxes with numeric inputmode are not one field', async () => {
    // Segment boxes are type=tel / inputmode=numeric and the first one carries
    // autocomplete=one-time-code. Those selectors must not swallow the whole code.
    const inputs = [
      {
        maxlength: '1', inputmode: 'numeric', autocomplete: 'one-time-code', type: 'tel', visible: true,
      },
      ...Array.from({ length: 5 }, () => ({
        maxlength: '1', inputmode: 'numeric', type: 'tel', visible: true,
      })),
    ];
    const state = await fill(fakePage({
      url: 'https://auth.openai.com/mfa-challenge',
      inputs,
      buttons: [{ type: 'submit', visible: true }],
    }));
    assert.deepStrictEqual(state.fills.map((f) => f.value), CODE.split(''), 'one digit per box');
  });

  await check('a hidden box does not break a run of six one-digit inputs', async () => {
    const inputs = [
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: false },
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
    ];
    const state = await fill(fakePage({
      url: 'https://auth.openai.com/mfa',
      inputs,
      buttons: [{ type: 'submit', visible: true }],
    }));
    assert.deepStrictEqual(state.fills.map((f) => f.value), CODE.split(''));
  });

  await check('one-digit inputs split by another visible field are not a code', async () => {
    const inputs = [
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
      { type: 'text', visible: true },
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
      { maxlength: '1', visible: true },
    ];
    const state = await fill(fakePage({
      url: 'https://chatgpt.com/',
      inputs,
      bodyText: 'How can I help you?',
    }));
    assert.deepStrictEqual(state.fills, []);
    assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
  });

  await check('a code field that appears at 20s virtual time is filled', async () => {
    // The old step gave the field 10s. Twenty seconds of virtual time must still be in budget.
    const env = withField({
      name: 'code',
      visible: (clock) => clock >= 20000,
    }, { urlAfterSubmit: 'https://chatgpt.com/' });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills.map((f) => f.value), [CODE]);
    assert.ok(state.clock >= 20000, `gave up at ${state.clock}ms, before the field existed`);
    assert.ok(state.clock < 30000, `waited ${state.clock}ms even though the field was already there`);
  });

  await check('a late field on an MFA url is filled rather than failed', async () => {
    const env = fakePage({
      url: 'https://auth.openai.com/mfa-challenge',
      inputs: [{ name: 'code', visible: (clock) => clock >= 20000 }],
      buttons: [{ type: 'submit', visible: true }],
    });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills.map((f) => f.value), [CODE]);
  });

  await check('an MFA page with no code field throws login_form_changed', async () => {
    const cases = [
      { url: 'https://auth.openai.com/mfa-challenge', bodyText: '' },
      { url: 'https://auth.openai.com/mfa', bodyText: '' },
      {
        url: 'https://auth.openai.com/login',
        bodyText: 'Enter the code from your authenticator app',
      },
    ];
    for (const pageOpts of cases) {
      const env = fakePage({ ...pageOpts, inputs: [], buttons: [] });
      await assert.rejects(
        () => fill(env),
        (err) => {
          assert.strictEqual(err.loginBlockerHint, 'login_form_changed');
          return true;
        },
      );
      assert.ok(env.state.clock >= 30000, `${pageOpts.url} failed at ${env.state.clock}ms`);
      assert.deepStrictEqual(env.state.fills, []);
    }
  });

  await check('error=totp that arrives after the click still throws mfa_required', async () => {
    const env = fakePage({
      url: 'https://auth.openai.com/mfa-challenge',
      errorAfterMs: 2000,
      urlWithError: 'https://auth.openai.com/mfa-challenge?error=totp',
      inputs: [{ name: 'code', visible: true }],
      buttons: [{ type: 'submit', visible: true }],
    });
    await assert.rejects(
      () => fill(env),
      (err) => {
        assert.strictEqual(err.loginBlockerHint, 'mfa_required');
        return true;
      },
    );
    assert.ok(env.state.clock >= 2000, `stopped watching at ${env.state.clock}ms`);
    assert.deepStrictEqual(env.state.fills.map((f) => f.value), [CODE]);
  });

  await check('error=totp that lands on the last watch beat still throws', async () => {
    // The rejection redirect is not on the MFA path at click time. It has to be
    // noticed even when it arrives on the final pause of the post-submit watch.
    const env = fakePage({
      url: 'https://auth.openai.com/login',
      errorAfterMs: 10000,
      urlWithError: 'https://auth.openai.com/mfa-challenge?error=totp',
      inputs: [{ name: 'code', visible: true }],
      buttons: [{ type: 'submit', visible: true }],
    });
    await assert.rejects(
      () => fill(env),
      (err) => {
        assert.strictEqual(err.loginBlockerHint, 'mfa_required');
        return true;
      },
    );
    assert.ok(env.state.clock >= 10000, `stopped watching at ${env.state.clock}ms`);
  });

  await check('error=totp after submit throws mfa_required', async () => {
    const env = fakePage({
      url: 'https://auth.openai.com/mfa-challenge',
      urlAfterSubmit: 'https://auth.openai.com/mfa-challenge?error=totp',
      inputs: [{ autocomplete: 'one-time-code', visible: true }],
      buttons: [{ type: 'submit', visible: true }],
    });
    await assert.rejects(
      () => fill(env),
      (err) => {
        assert.strictEqual(err.loginBlockerHint, 'mfa_required');
        return true;
      },
    );
    assert.deepStrictEqual(env.state.fills.map((f) => f.value), [CODE], 'the code was not entered');
    assert.deepStrictEqual(env.state.clicks, ['submit']);
  });

  await check('neither an MFA URL nor a code field skips without an error', async () => {
    const env = fakePage({
      url: 'https://auth.openai.com/login',
      bodyText: 'How can I help you?',
      inputs: [],
    });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills, []);
    assert.deepStrictEqual(state.clicks, []);
    assert.ok(
      state.logs.some((line) => line.includes('[auto-login] TOTP prompt not found — skipping')),
      `logs were ${JSON.stringify(state.logs)}`,
    );
    assert.strictEqual(state.clock, 30000);
  });

  await check('a hidden code field is not filled, and the step skips', async () => {
    const state = await fill(withField({ name: 'code', visible: false }));
    assert.deepStrictEqual(state.fills, []);
    assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
  });

  await check('a chat url that merely contains /mfa is not an MFA page', async () => {
    const env = fakePage({
      url: 'https://chatgpt.com/?q=/mfa',
      bodyText: 'How can I help you?',
      inputs: [],
    });
    const state = await fill(env);
    assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    assert.ok(state.clock < 1000, `waited ${state.clock}ms on the chat app`);
  });

  await check('a hung field probe still ends when the budget ends', async () => {
    process.env.TOTP_PROMPT_TIMEOUT_SEC = '1';
    const delays = [];
    const origSetTimeout = global.setTimeout;
    // The probe timer is a real setTimeout. Record the delay it asks for so a
    // doubled timer fails even when the wall clock is late.
    global.setTimeout = (fn, ms, ...args) => {
      delays.push(Number(ms));
      return origSetTimeout(fn, ms, ...args);
    };
    try {
      const env = fakePage({ url: 'https://auth.openai.com/login', bodyText: 'hello' });
      const orig = env.page.locator.bind(env.page);
      env.page.locator = (selector) => {
        const loc = orig(selector);
        if (selector.startsWith('input')) {
          return {
            async count() { return new Promise(() => {}); },
            nth() {
              return { async isVisible() { return false; }, async getAttribute() { return null; } };
            },
            first() { return this.nth(0); },
          };
        }
        return loc;
      };
      const started = Date.now();
      await fillTotpStep(env.page, 'SECRET', { generateTOTP, log: env.log });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 900, `returned in ${elapsed}ms`);
      assert.ok(elapsed < 8000, `hung for ${elapsed}ms`);
      const probeDelay = Math.max(...delays);
      assert.ok(probeDelay >= 900 && probeDelay < 1500, `probe timer ${probeDelay}ms`);
      assert.ok(env.state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    } finally {
      global.setTimeout = origSetTimeout;
      delete process.env.TOTP_PROMPT_TIMEOUT_SEC;
    }
  });

  await check('a chat page that mentions an authenticator is not an MFA prompt', async () => {
    const env = fakePage({
      url: 'https://chatgpt.com/',
      bodyText: 'The user asked how to reset an authenticator app',
      inputs: [],
    });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills, []);
    assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    assert.ok(state.clock < 1000, `waited ${state.clock}ms on a page that is already the app`);
  });

  await check('a next=/mfa-settings query is not an MFA page', async () => {
    const env = fakePage({
      url: 'https://auth.openai.com/login?next=/mfa-settings',
      bodyText: 'Choose how to sign in',
      inputs: [],
    });
    const state = await fill(env);
    assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    assert.strictEqual(state.clock, 30000);
  });

  await check('the first visible submit button is clicked, not a hidden one', async () => {
    const env = fakePage({
      inputs: [{ name: 'code', visible: true }],
      buttons: [
        { type: 'submit', id: 'hidden', visible: false },
        { type: 'submit', id: 'go', visible: true },
      ],
    });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills.map((f) => f.value), [CODE]);
    assert.deepStrictEqual(state.clicks, ['go']);
    assert.deepStrictEqual(state.presses, []);
  });

  await check('Enter submits when the submit button is missing or hidden', async () => {
    for (const buttons of [[], [{ type: 'submit', visible: false }]]) {
      const env = fakePage({
        inputs: Array.from({ length: 6 }, () => ({ maxlength: '1', visible: true })),
        buttons,
      });
      const state = await fill(env);
      assert.deepStrictEqual(state.fills.map((f) => f.value), CODE.split(''));
      assert.deepStrictEqual(state.clicks, []);
      assert.deepStrictEqual(state.presses, ['Enter']);
    }
  });

  await check('TOTP_PROMPT_TIMEOUT_SEC replaces the default budget', async () => {
    process.env.TOTP_PROMPT_TIMEOUT_SEC = '2';
    try {
      const env = fakePage({ url: 'https://auth.openai.com/login', bodyText: 'hello' });
      const state = await fill(env);
      assert.strictEqual(state.clock, 2000);
      assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    } finally {
      delete process.env.TOTP_PROMPT_TIMEOUT_SEC;
    }
  });

  await check('a non-finite TOTP_PROMPT_TIMEOUT_SEC keeps the default budget', async () => {
    for (const raw of ['0', '-5', 'Infinity', 'nope', '']) {
      process.env.TOTP_PROMPT_TIMEOUT_SEC = raw;
      try {
        const env = fakePage({ url: 'https://auth.openai.com/login', bodyText: 'hello' });
        const state = await fill(env);
        assert.strictEqual(state.clock, 30000, `env ${raw} waited ${state.clock}ms`);
      } finally {
        delete process.env.TOTP_PROMPT_TIMEOUT_SEC;
      }
    }
  });

  await check('without a generator the step uses generateTOTP from auto-login', async () => {
    const { generateTOTP: real } = require('../src/auto-login');
    const secret = 'JBSWY3DPEHPK3PXP';
    const expected = real(secret);
    const env = withField({ name: 'code', visible: true });
    await fillTotpStep(env.page, secret, { now: env.now, log: env.log });
    assert.match(expected, /^\d{6}$/);
    assert.deepStrictEqual(env.state.fills.map((f) => f.value), [expected]);
  });

  await check('an auth0.com MFA url with no code field throws login_form_changed', async () => {
    // auth0.com is an auth host. A challenge there with no field is a broken step.
    const env = fakePage({
      url: 'https://tenant.auth0.com/mfa-challenge',
      bodyText: '',
      inputs: [],
      buttons: [],
    });
    await assert.rejects(
      () => fill(env),
      (err) => {
        assert.strictEqual(err.loginBlockerHint, 'login_form_changed');
        return true;
      },
    );
    assert.deepStrictEqual(env.state.fills, []);
    assert.ok(env.state.clock >= 30000, `failed at ${env.state.clock}ms`);
  });

  await check('chat.openai.com is already the app and the step skips', async () => {
    const env = fakePage({
      url: 'https://chat.openai.com/',
      bodyText: 'How can I help you?',
      inputs: [],
    });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills, []);
    assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    assert.ok(state.clock < 1000, `waited ${state.clock}ms on chat.openai.com`);
  });

  await check('Enter is pressed on the last segment when submit is missing', async () => {
    const env = fakePage({
      url: 'https://auth.openai.com/mfa-challenge',
      inputs: Array.from({ length: 6 }, (_, i) => ({ maxlength: '1', visible: true, id: i })),
      buttons: [],
    });
    const state = await fill(env);
    assert.deepStrictEqual(state.fills.map((f) => f.value), CODE.split(''));
    assert.deepStrictEqual(state.clicks, []);
    assert.deepStrictEqual(state.presses, ['Enter']);
    assert.deepStrictEqual(state.pressFields, [5]);
  });

  await check('a generator result that is not six digits is rejected', async () => {
    for (const bad of ['12345', '1234567', 'abcdef', null, undefined]) {
      const env = withField({ name: 'code', visible: true });
      await assert.rejects(
        () => fill(env, { generateTOTP: () => bad }),
        (err) => {
          assert.strictEqual(err.message, 'TOTP generator did not return a 6-digit code');
          return true;
        },
      );
      assert.deepStrictEqual(env.state.fills, [], `filled ${JSON.stringify(bad)}`);
      assert.deepStrictEqual(env.state.clicks, []);
      assert.deepStrictEqual(env.state.presses, []);
    }
  });

  await check('a numeric generator result is filled as six digit characters', async () => {
    // Six boxes call charAt. A number must be turned into a string before that.
    const env = fakePage({
      url: 'https://auth.openai.com/mfa-challenge',
      inputs: Array.from({ length: 6 }, () => ({ maxlength: '1', visible: true })),
      buttons: [{ type: 'submit', visible: true }],
    });
    let error = null;
    try {
      await fill(env, { generateTOTP: () => 123456 });
    } catch (e) {
      error = e;
    }
    assert.strictEqual(error, null);
    assert.deepStrictEqual(env.state.fills.map((f) => f.value), ['1', '2', '3', '4', '5', '6']);
  });

  await check('a code with a leading zero is entered unchanged', async () => {
    const env = withField({ name: 'code', visible: true });
    let error = null;
    try {
      await fill(env, { generateTOTP: () => '012345' });
    } catch (e) {
      error = e;
    }
    assert.strictEqual(error, null);
    assert.deepStrictEqual(env.state.fills.map((f) => f.value), ['012345']);
    assert.deepStrictEqual(env.state.clicks, ['submit']);
  });

  await check('a field that becomes visible exactly at the deadline is not filled', async () => {
    // The wait is `now < deadline`. A field that appears on the boundary is too late.
    process.env.TOTP_PROMPT_TIMEOUT_SEC = '2';
    try {
      const env = fakePage({
        url: 'https://auth.openai.com/login',
        bodyText: 'hello',
        inputs: [{ name: 'code', visible: (clock) => clock >= 2000 }],
        buttons: [{ type: 'submit', visible: true }],
      });
      const state = await fill(env);
      assert.deepStrictEqual(state.fills, []);
      assert.strictEqual(state.clock, 2000);
      assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    } finally {
      delete process.env.TOTP_PROMPT_TIMEOUT_SEC;
    }
  });

  await check('the last pause stops at the budget instead of a full poll', async () => {
    // 750ms is not a multiple of the 500ms poll. The tail wait is the remainder.
    process.env.TOTP_PROMPT_TIMEOUT_SEC = '0.75';
    try {
      const env = fakePage({
        url: 'https://auth.openai.com/login',
        bodyText: 'hello',
        inputs: [],
      });
      const state = await fill(env);
      assert.deepStrictEqual(state.fills, []);
      assert.strictEqual(state.clock, 750, `waited ${state.clock}ms`);
      assert.ok(state.logs.some((line) => line.includes('TOTP prompt not found — skipping')));
    } finally {
      delete process.env.TOTP_PROMPT_TIMEOUT_SEC;
    }
  });

  await check('auto-login delegates the TOTP step to fillTotpStep', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'auto-login.js'), 'utf8');
    assert.match(src, /fillTotpStep\(\s*page,\s*totpSecret/);
    assert.doesNotMatch(src, /input\[autocomplete="one-time-code"\]/);
  });

  if (failures) {
    console.log(`\n${failures} totp-step test(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll totp-step tests passed.');
})();
