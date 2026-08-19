// Router-level tests for the reactive cooldown and the queue-full estimate.
//
// pacer.js has its own 16 tests, and they all passed while the cooldown could
// extend itself indefinitely: the defect lived in how the router USES the pacer,
// not in the pacer. These tests reach into src/routes/images.js's module state
// through its _internals surface for that reason.

const assert = require('assert');
const { _internals } = require('../src/routes/images');

const {
  assertNotRateLimited, handleRateLimitError, queueFullRetryAfterSec,
  getRateLimitedUntil, setRateLimitedUntil,
} = _internals;

const tests = [];
const add = (name, fn) => tests.push({ name, fn });

add('no cooldown armed: a turn is allowed through', () => {
  setRateLimitedUntil(0);
  assert.doesNotThrow(() => assertNotRateLimited());
});

add('an armed cooldown refuses the turn as rate_limit', () => {
  setRateLimitedUntil(Date.now() + 60_000);
  let caught = null;
  try { assertNotRateLimited(); } catch (err) { caught = err; }
  assert.ok(caught, 'the turn must be refused');
  assert.strictEqual(caught.code, 'rate_limit', 'rate_limit is NOT an infra failure — see progress.js');
  assert.match(caught.message, /not sending/);
});

add('an expired cooldown lets turns through again', () => {
  setRateLimitedUntil(Date.now() - 1);
  assert.doesNotThrow(() => assertNotRateLimited());
});

add('OUR refusal does not re-arm the cooldown', () => {
  // The whole point: this error's message contains "rate limit", which is what
  // handleRateLimitError matches on. Arming for it would move the deadline to
  // now + a full cooldown, so a client polling every minute would hold its own
  // service shut forever, and each refusal would log a limit ChatGPT never sent.
  const deadline = Date.now() + 5_000;
  setRateLimitedUntil(deadline);
  let caught = null;
  try { assertNotRateLimited(); } catch (err) { caught = err; }
  handleRateLimitError(caught);
  assert.strictEqual(getRateLimitedUntil(), deadline, 'the deadline must not move');
});

add("ChatGPT's own rate limit DOES arm the cooldown", () => {
  setRateLimitedUntil(0);
  const before = Date.now();
  handleRateLimitError(new Error('You have hit the rate limit for image generation'));
  assert.ok(getRateLimitedUntil() > before, 'a real limit must arm a cooldown');
});

add('a reset time named by ChatGPT is honoured over the default', () => {
  setRateLimitedUntil(0);
  const before = Date.now();
  handleRateLimitError(new Error('rate limit reached, try again in 2 hours'));
  const armedFor = getRateLimitedUntil() - before;
  assert.ok(armedFor > 100 * 60 * 1000, `expected ~2h, got ${Math.round(armedFor / 60000)}min`);
});

add('an unrelated failure arms nothing', () => {
  setRateLimitedUntil(0);
  handleRateLimitError(new Error('Timeout 240000ms exceeded'));
  assert.strictEqual(getRateLimitedUntil(), 0);
});

add('the queue-full estimate counts a gap per queued job', () => {
  const empty = queueFullRetryAfterSec(0);
  const five = queueFullRetryAfterSec(5);
  assert.ok(five > empty, 'a longer queue must quote a longer wait');
  assert.strictEqual(five - empty, 5 * 60, 'five jobs at the default 60s gap');
});

add('the queue-full estimate is always whole seconds', () => {
  // Retry-After carries no fraction, and a gap of 2.5s is a legal setting.
  for (const queued of [0, 1, 3, 5]) {
    const sec = queueFullRetryAfterSec(queued);
    assert.strictEqual(sec, Math.trunc(sec), `${queued} queued gave ${sec}`);
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n      ${err.message}`);
  }
}
setRateLimitedUntil(0);
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
