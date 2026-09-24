// fillTimeoutMs — the composer fill() budget scales with prompt length (2.14.2).
const assert = require('assert');
const {
  _test: { fillTimeoutMs, typeFallbackTimeoutMs, responseBaseBudgetMs, CHAT_COMPLETION_TIMEOUT_MS, typeAndSubmit, waitAndExtractText },
} = require('../src/chatgpt');

let passed = 0;
function ok(name, fn) { fn(); console.log(`PASS: ${name}`); passed++; }

ok('short and empty prompts keep the 30 s default', () => {
  assert.strictEqual(fillTimeoutMs(''), 30000);
  assert.strictEqual(fillTimeoutMs(null), 30000);
  assert.strictEqual(fillTimeoutMs('hi'), 30004);
});

ok('a 30k-char prompt gets well over the 27 s measured fill', () => {
  assert.strictEqual(fillTimeoutMs('x'.repeat(30000)), 90000);
});

ok('the budget is capped at 120 s', () => {
  assert.strictEqual(fillTimeoutMs('x'.repeat(45000)), 120000);
  assert.strictEqual(fillTimeoutMs('x'.repeat(200000)), 120000);
});

ok('per-key fallback budget is 30 s + 10 ms/char while it fits under 120 s', () => {
  assert.strictEqual(typeFallbackTimeoutMs('x'.repeat(100)), 31000);
  assert.strictEqual(typeFallbackTimeoutMs('x'.repeat(9000)), 120000);
});

ok('per-key fallback is refused for text it cannot type in 120 s', () => {
  assert.strictEqual(typeFallbackTimeoutMs('x'.repeat(9001)), null);
  assert.strictEqual(typeFallbackTimeoutMs('x'.repeat(30000)), null);
});

ok('input up to the old 30 s leaves the response window untouched', () => {
  assert.strictEqual(responseBaseBudgetMs(undefined), CHAT_COMPLETION_TIMEOUT_MS);
  assert.strictEqual(responseBaseBudgetMs(30000), CHAT_COMPLETION_TIMEOUT_MS);
});

ok('input beyond 30 s comes out of the response window', () => {
  assert.strictEqual(responseBaseBudgetMs(31000), CHAT_COMPLETION_TIMEOUT_MS - 1000);
  assert.strictEqual(responseBaseBudgetMs(120000), CHAT_COMPLETION_TIMEOUT_MS - 90000);
  assert.strictEqual(responseBaseBudgetMs(CHAT_COMPLETION_TIMEOUT_MS * 10), 0);
});

// A page double for typeAndSubmit. `landed` decides whether fill() puts the text into the
// composer; `pressSeq` records the per-key fallback; user turns grow on click so the submit
// is confirmed and the whole function runs to its return.
function pageDouble({ landed, fillDelayMs = 0 }) {
  const calls = { pressSeq: null };
  let content = '';
  let turns = 0;
  const locator = {
    first: () => locator,
    waitFor: async () => {},
    count: async () => 0,
    fill: async (t) => { await new Promise((r) => setTimeout(r, fillDelayMs)); if (landed) content = t; },
    textContent: async () => content,
    click: async () => { turns++; },
    pressSequentially: async (t, opts) => { calls.pressSeq = opts; content = t; },
  };
  const page = {
    evaluate: async (fn) => (String(fn).includes('data-message-author-role') ? turns : undefined),
    locator: () => locator,
    $: async () => null,
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
  };
  return { page, calls };
}

// The call site, not just the formula: typeAndSubmit must hand the scaled budget to fill().
// The page double records the fill options and stops the flow right after it.
async function fillOptionsFor(text) {
  let seen = null;
  const STOP = new Error('stop after fill');
  const locator = {
    first: () => locator,
    waitFor: async () => {},
    count: async () => 0,
    fill: async (_t, opts) => { seen = opts; throw STOP; },
  };
  const page = { evaluate: async () => {}, locator: () => locator };
  await assert.rejects(typeAndSubmit(page, text), (e) => e === STOP);
  return seen;
}

(async () => {
  const long = 'x'.repeat(30000);
  const opts = await fillOptionsFor(long);
  assert.ok(opts, 'fill() was called without options — default 30 s timeout');
  assert.strictEqual(opts.timeout, fillTimeoutMs(long));
  console.log('PASS: typeAndSubmit passes the scaled timeout to fill()'); passed++;

  {
    const { page, calls } = pageDouble({ landed: false });
    await assert.rejects(typeAndSubmit(page, 'y'.repeat(20000)), (e) => e.code === 'page_load_failed'
      && /too long for per-key typing/.test(e.message));
    assert.strictEqual(calls.pressSeq, null, 'long text must not be typed key by key');
    console.log('PASS: long text that did not land fails fast as page_load_failed'); passed++;
  }
  {
    const text = 'short prompt';
    const { page, calls } = pageDouble({ landed: false });
    await typeAndSubmit(page, text);
    assert.deepStrictEqual(calls.pressSeq, { delay: 10, timeout: typeFallbackTimeoutMs(text) });
    console.log('PASS: short text falls back to per-key typing with its own budget'); passed++;
  }
  {
    const { page } = pageDouble({ landed: true, fillDelayMs: 50 });
    const res = await typeAndSubmit(page, 'landed prompt');
    assert.ok(res && res.inputMs >= 50 && res.inputMs < 5000, `inputMs=${res && res.inputMs}`);
    console.log('PASS: typeAndSubmit reports the time spent on input'); passed++;
  }
  {
    // Input that ate the whole response window: the wait must give up on its first pass
    // instead of sitting out the full CHAT_COMPLETION_TIMEOUT_MS on an empty page.
    const { page } = pageDouble({ landed: true });
    const t0 = Date.now();
    await assert.rejects(
      waitAndExtractText(page, undefined, { thinkingMode: 'instant', inputMs: CHAT_COMPLETION_TIMEOUT_MS * 10 }),
      (e) => e.code === 'timeout',
    );
    assert.ok(Date.now() - t0 < 10000, `waited ${Date.now() - t0}ms`);
    console.log('PASS: the response wait honours the input time it is given'); passed++;
  }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
