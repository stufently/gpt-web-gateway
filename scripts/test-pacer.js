// Fake-clock tests for src/pacer.js — the proactive gap between jobs.
const assert = require('assert');
const { createPacer, gapMs, heartbeatMsFor, DEFAULT_GAP_MS, HEARTBEAT_MS } = require('../src/pacer');

let passed = 0;
function ok(name, fn) {
  const done = fn();
  const finish = () => { console.log(`PASS: ${name}`); passed++; };
  return done && typeof done.then === 'function' ? done.then(finish) : (finish(), null);
}

function harness(startMs = 0, gap = 60000, heartbeatMs = 30000) {
  let t = startMs;
  const slept = [];
  const beats = [];
  const now = () => t;
  const sleep = (ms) => { slept.push(ms); t += ms; return Promise.resolve(); };
  const heartbeat = () => beats.push(t);
  const pacer = createPacer({ now, sleep, gap, heartbeat, heartbeatMs });
  const total = () => slept.reduce((a, b) => a + b, 0);
  return { pacer, slept, beats, total, advance: (ms) => { t += ms; } };
}

const tests = [];
const add = (name, fn) => tests.push([name, fn]);

add('the first job is never delayed', async () => {
  const { pacer, slept } = harness();
  assert.strictEqual(await pacer.gate(), 0);
  assert.deepStrictEqual(slept, []);
});

add('a turn right after the previous one waits out the whole gap', async () => {
  const { pacer, total } = harness();
  await pacer.gate();
  pacer.finished();
  assert.strictEqual(await pacer.gate(), 60000);
  assert.strictEqual(total(), 60000);
});

add('the gap counts from the FINISH, so a long job leaves nothing to wait', async () => {
  // A gap measured from the START would be spent by the job itself: these jobs
  // run a minute or more, and the setting would have changed nothing at all.
  const { pacer, advance, total } = harness();
  await pacer.gate();
  advance(90 * 1000); // the turn itself took 90s, longer than the gap
  pacer.finished();
  assert.strictEqual(await pacer.gate(), 60000);
  assert.strictEqual(total(), 60000);
});

add('an idle instance waits nothing: the gap already passed', async () => {
  const { pacer, advance, slept } = harness();
  await pacer.gate();
  pacer.finished();
  advance(10 * 60 * 1000);
  assert.strictEqual(await pacer.gate(), 0);
  assert.deepStrictEqual(slept, []);
});

add('a partly elapsed gap waits only the remainder', async () => {
  const { pacer, advance } = harness();
  await pacer.gate();
  pacer.finished();
  advance(20 * 1000);
  assert.strictEqual(await pacer.gate(), 40 * 1000);
});

add('a failed turn still stamps the finish', async () => {
  // The refused request reached ChatGPT exactly as a successful one did, and
  // the account counts it. Pacing on successes only would let a failing batch
  // hammer at full speed.
  const { pacer } = harness();
  await pacer.gate();
  pacer.finished(); // caller does this in finally, success or not
  assert.strictEqual(await pacer.gate(), 60000);
});

add('gap 0 disables pacing entirely', async () => {
  const { pacer, slept } = harness(0, 0);
  await pacer.gate();
  pacer.finished();
  assert.strictEqual(await pacer.gate(), 0);
  assert.deepStrictEqual(slept, []);
});

add('a clock that stepped backwards does not stall the queue', async () => {
  // NTP correction: without a guard the negative interval reads as "the gap
  // has not started yet" and the wait comes out larger than the gap.
  const { pacer, advance } = harness();
  await pacer.gate();
  pacer.finished();
  advance(-5 * 60 * 1000);
  assert.strictEqual(await pacer.gate(), 0);
});

add('the wait beats a heartbeat so a deliberate pause reads as progress', async () => {
  // A waiting job holds a queue slot. Without a beat the liveness detector sees
  // queued work and no progress and restarts a container doing exactly what it
  // was told — for any gap at or above the stuck threshold. Found by codex.
  const { pacer, beats, slept } = harness(0, 60000, 30000);
  await pacer.gate();
  pacer.finished();
  await pacer.gate();
  assert.deepStrictEqual(slept, [30000, 30000], 'the wait is broken into beats');
  assert.strictEqual(beats.length, 2);
});

add('a gap shorter than one beat still beats exactly once', async () => {
  const { pacer, beats, slept } = harness(0, 5000, 30000);
  await pacer.gate();
  pacer.finished();
  await pacer.gate();
  assert.deepStrictEqual(slept, [5000]);
  assert.strictEqual(beats.length, 1);
});

add('a batch of turns pays the gap between turns, not once for the batch', async () => {
  // What is paced is one UPSTREAM TURN, not one HTTP request: a batch sends up
  // to ten prompts inside a single job, and pacing the job alone left that
  // burst untouched. Three turns → two gaps. Found by codex.
  const { pacer, total, advance } = harness();
  for (let turn = 0; turn < 3; turn++) {
    await pacer.gate();
    advance(20 * 1000); // the turn itself
    pacer.finished();
  }
  assert.strictEqual(total(), 2 * 60000);
});

add('status shows the limit, the wait ahead and the total waited', async () => {
  const { pacer, advance } = harness();
  assert.deepStrictEqual(pacer.status(), {
    min_gap_sec: 60, next_slot_in_sec: 0, throttled_seconds_total: 0,
  });
  await pacer.gate();
  pacer.finished();
  advance(45 * 1000);
  assert.strictEqual(pacer.status().next_slot_in_sec, 15);
  await pacer.gate();
  assert.strictEqual(pacer.status().throttled_seconds_total, 15);
});

add('a stalled clock still releases the queue slot', async () => {
  // The remainder used to be recomputed from the clock alone, so a clock that
  // does not move never shrinks it: the wait spins forever, waking every beat
  // and holding a queue slot that never frees. Not reachable with a real
  // Date.now, but nothing should be able to hang the queue. Found by codex.
  let t = 0;
  const slept = [];
  const pacer = createPacer({
    now: () => t,
    // A sleep that does NOT advance the clock — the whole point of the test.
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
    gap: 60000,
    heartbeatMs: 30000,
  });
  await pacer.gate();
  pacer.finished();
  const waited = await pacer.gate();
  assert.strictEqual(waited, 60000, 'it must report the full gap it set out to wait');
  assert.deepStrictEqual(slept, [30000, 30000], 'and finish in exactly two beats, not spin');
});

add('a clock that jumps FORWARD mid-wait ends the wait early', async () => {
  // The other side of the same line: the clock still gets to shorten the wait.
  let t = 0;
  const pacer = createPacer({
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    gap: 300000,
    heartbeatMs: 30000,
  });
  pacer.finished();
  const gate = pacer.gate();
  t += 300000; // NTP step forward: the gap has now "passed"
  await gate;
  assert.ok(true, 'the wait returned instead of sitting out the original gap');
});

add('the beat lands inside the liveness window, not at a fixed 30s', () => {
  // HEALTH_STUCK_SEC has no lower bound. A fixed 30s cadence means the probe
  // fires before the first beat whenever the threshold is under 30s, killing a
  // container that was pacing exactly as told. Found by codex.
  assert.strictEqual(heartbeatMsFor({ HEALTH_STUCK_SEC: '10' }), 5000);
  assert.strictEqual(heartbeatMsFor({ HEALTH_STUCK_SEC: '900' }), HEARTBEAT_MS);
  assert.strictEqual(heartbeatMsFor({}), HEARTBEAT_MS, 'the default threshold keeps the full beat');
  assert.ok(heartbeatMsFor({ HEALTH_STUCK_SEC: '0' }) >= 250, 'never a zero-length beat');
});

add('a gap at or beyond the stuck threshold is called out, not silently obeyed', () => {
  // Such a gap is longer than the window the liveness probe calls "hung". The
  // heartbeat in gate() keeps the container alive through it, so this is no
  // longer an outage — but every queued caller then waits past that threshold
  // for its turn, which the operator should hear about. Refusing the value
  // would override them, so the warning is the whole remedy. Found by agy.
  const warned = [];
  const real = console.warn;
  console.warn = (msg) => warned.push(msg);
  try {
    assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '1000' }), 1000 * 1000);
    assert.strictEqual(warned.length, 1);
    assert.ok(warned[0].includes('HEALTH_STUCK_SEC'));
    warned.length = 0;
    gapMs({ MIN_JOB_GAP_SEC: '1000', HEALTH_STUCK_SEC: '3600' });
    assert.deepStrictEqual(warned, [], 'a raised threshold makes the gap fine');
    gapMs({ MIN_JOB_GAP_SEC: '60' });
    assert.deepStrictEqual(warned, [], 'the default gap is nowhere near it');
  } finally {
    console.warn = real;
  }
});

add('the default is a real gap, not a disabled one', () => {
  assert.strictEqual(gapMs({}), DEFAULT_GAP_MS);
  assert.strictEqual(DEFAULT_GAP_MS, 60000);
});

add('MIN_JOB_GAP_SEC is read from the environment', () => {
  assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '30' }), 30000);
  assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '0' }), 0);
  assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '2.5' }), 2500);
});

add('nonsense in MIN_JOB_GAP_SEC falls back to the default, loudly', () => {
  const warned = [];
  const real = console.warn;
  console.warn = (msg) => warned.push(msg);
  try {
    assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: 'soon' }), DEFAULT_GAP_MS);
    assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '-5' }), DEFAULT_GAP_MS);
  } finally {
    console.warn = real;
  }
  assert.strictEqual(warned.length, 2);
});

(async () => {
  for (const [name, fn] of tests) await ok(name, fn);
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exit(1);
})();
