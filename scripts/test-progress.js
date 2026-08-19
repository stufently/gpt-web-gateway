// Fake-clock tests for src/progress.js — the /health/live stuck detectors.
const assert = require('assert');
const { createProgress } = require('../src/progress');

let passed = 0;
function ok(name, fn) { fn(); console.log(`PASS: ${name}`); passed++; }

function fakeClock(startMs = 0) {
  let t = startMs;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

ok('idle process stays alive forever', () => {
  const clock = fakeClock();
  const p = createProgress(clock);
  clock.advance(3 * 3600 * 1000);
  assert.strictEqual(p.liveness().alive, true);
});

ok('queued work with no progress past threshold → not alive', () => {
  const clock = fakeClock();
  const p = createProgress(clock);
  p.jobStarted();
  clock.advance(901 * 1000);
  assert.strictEqual(p.liveness().alive, false);
});

ok('polling touches keep long legitimate jobs alive (batch n=10)', () => {
  const clock = fakeClock();
  const p = createProgress(clock);
  p.jobStarted();
  for (let i = 0; i < 120; i++) { clock.advance(30 * 1000); p.touch(); } // 60 min of active polling
  assert.strictEqual(p.liveness().alive, true);
  p.jobFinished(null);
  assert.strictEqual(p.liveness().alive, true);
});

ok('3 consecutive infra failures → not alive; success resets', () => {
  const clock = fakeClock();
  const p = createProgress(clock);
  for (const kind of ['timeout', 'page_load_failed']) { p.jobStarted(); p.jobFinished(kind); }
  assert.strictEqual(p.liveness().alive, true);
  p.jobStarted(); p.jobFinished('timeout');
  assert.strictEqual(p.liveness().alive, false);
  p.jobStarted(); p.jobFinished(null);
  assert.strictEqual(p.liveness().alive, true);
});

ok('healthy failures (refused / rate_limit) reset the streak', () => {
  const clock = fakeClock();
  const p = createProgress(clock);
  p.jobStarted(); p.jobFinished('timeout');
  p.jobStarted(); p.jobFinished('timeout');
  p.jobStarted(); p.jobFinished('refused');
  p.jobStarted(); p.jobFinished('timeout');
  assert.strictEqual(p.liveness().alive, true); // streak restarted from refused
});

ok('repeated partial-batch infra tails accumulate despite job successes', () => {
  const clock = fakeClock();
  const p = createProgress(clock);
  for (let i = 0; i < 3; i++) {
    p.jobStarted(); p.jobFinished(null);   // partial batch resolves as success
    p.recordInfraFailure('timeout');       // ...but its tail turn timed out
  }
  assert.strictEqual(p.liveness().alive, false);
  p.recordInfraFailure('refused');         // non-infra kind is ignored
  assert.strictEqual(p.liveness().alive, false);
  p.clearPartialInfra();                   // a FULL success clears the partial streak
  assert.strictEqual(p.liveness().alive, true);
});

console.log(`\nAll ${passed} progress tests passed.`);
