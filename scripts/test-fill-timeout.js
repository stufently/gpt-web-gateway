// fillTimeoutMs — the composer fill() budget scales with prompt length (2.14.2).
const assert = require('assert');
const { _test: { fillTimeoutMs, typeAndSubmit } } = require('../src/chatgpt');

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
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
