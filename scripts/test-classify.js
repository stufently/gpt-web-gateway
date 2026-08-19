// Regression test for src/metrics.js classifyError + observeDuration histogram.
// Run with: docker run --rm -v $PWD:/app -w /app node:20-slim node scripts/test-classify.js
const assert = require('node:assert');
const {
  classifyError,
  shouldRetryKind,
  observeDuration,
  _internal,
} = require('../src/metrics');

const cases = [
  // [input message, expected kind, note]
  ['ChatGPT refused: content policy violation (copyright/guardrails)', 'policy_violation'],
  ['ChatGPT refused to generate this image',                           'refused'],
  ['page.waitForFunction: Timeout 180000ms exceeded',                  'timeout'],
  ['Timeout 240000ms exceeded — chat did not return',                  'timeout'],
  ['ChatGPT did not return an image within 240s (adaptive retry exhausted)', 'timeout'],
  ['ChatGPT did not return a text response in time',                   'timeout'],
  ['ChatGPT content failed to load',                                   'page_load_failed'],
  ['ChatGPT rate limit reached, try again later',                      'rate_limit'],
  ['Достигнут лимит на сегодня',                                       'rate_limit'],
  ['Not logged in. Set CHATGPT_EMAIL and CHATGPT_PASSWORD for auto-login.', 'login_failed'],
  ['session expired during request',                                   'login_failed'],
  ['unexpected server error',                                          'server_error'],
];

let failed = 0;
for (const [msg, expected] of cases) {
  const actual = classifyError(msg);
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: classifyError(${JSON.stringify(msg.slice(0, 60))}) → ${actual} (want ${expected})`);
}

// err.code path takes precedence over substring matching
const codeCases = [
  ['some unrelated message', 'refused',          'refused'],
  ['some unrelated message', 'policy_violation', 'policy_violation'],
  ['some unrelated message', 'timeout',          'timeout'],
  ['some unrelated message', 'rate_limit',       'rate_limit'],
  ['some unrelated message', 'upload_failed',    'upload_failed'],
  ['some unrelated message', 'page_load_failed', 'page_load_failed'],
];
for (const [msg, code, expected] of codeCases) {
  const actual = classifyError(msg, code);
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: classifyError(_, code=${code}) → ${actual} (want ${expected})`);
}

// shouldRetryKind: refused/policy_violation/rate_limit → false; rest → true
const retryCases = [
  ['refused',          false],
  ['policy_violation', false],
  ['rate_limit',       false],
  ['server_error',     true],
  ['timeout',          true],
  ['login_failed',     true],
  ['queue_full',       true],
  ['upload_failed',    true],
  ['page_load_failed', true],
];
for (const [kind, expected] of retryCases) {
  const actual = shouldRetryKind(kind);
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: shouldRetryKind(${kind}) → ${actual} (want ${expected})`);
}

// observeDuration: bucket placement + sum/count
observeDuration('success', 7);     // bucket le=10
observeDuration('success', 25);    // bucket le=30
observeDuration('success', 250);   // bucket le=300
observeDuration('success', 1000);  // +Inf
const s = _internal.histograms.duration_seconds.success;
assert.strictEqual(s.count, 4, 'histogram count');
assert.strictEqual(s.sum, 7 + 25 + 250 + 1000, 'histogram sum');
// per-bucket increments (non-cumulative storage)
const idx = (v) => _internal.DURATION_BUCKETS.indexOf(v);
assert.strictEqual(s.buckets[idx(10)],  1, 'bucket le=10 must capture 7s');
assert.strictEqual(s.buckets[idx(30)],  1, 'bucket le=30 must capture 25s');
assert.strictEqual(s.buckets[idx(300)], 1, 'bucket le=300 must capture 250s');
assert.strictEqual(s.inf, 1, '+Inf must capture 1000s');
console.log('PASS: observeDuration bucket placement + sum/count');

// Unknown labels collapse to server_error to avoid silent metric drift
observeDuration('unknown_label', 12);
assert.strictEqual(_internal.histograms.duration_seconds.server_error.count >= 1, true, 'unknown label collapses to server_error');
console.log('PASS: observeDuration falls back to server_error for unknown labels');

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tests passed.');
