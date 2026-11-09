// Recycle by memory: cgroup reading, the soft/hard decision and its wiring into the pool.
// No browser and no real cgroup: the reader takes a fake fs, the route test stubs chatgpt.
const assert = require('assert');
const http = require('http');
const Module = require('module');
const express = require('express');

const { createMemoryGuard, readCgroupMemory, configFromEnv } = require('../src/memory-guard');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const tests = [];
const add = (name, fn) => tests.push([name, fn]);
const quiet = () => {};

function fakeFs(files) {
  return {
    readFileSync(file) {
      if (Object.prototype.hasOwnProperty.call(files, file)) return files[file];
      const err = new Error(`ENOENT: ${file}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---- readCgroupMemory -------------------------------------------------------------

add('cgroup v2: usage is current minus inactive_file, limit from memory.max', () => {
  const fsImpl = fakeFs({
    '/cg/memory.current': '6000000000\n',
    '/cg/memory.stat': 'anon 5000000000\nfile 900000000\ninactive_file 1000000000\nactive_file 5\n',
    '/cg/memory.max': '8589934592\n',
  });
  assert.deepStrictEqual(readCgroupMemory({ fsImpl, root: '/cg' }), { usage: 5000000000, limit: 8589934592 });
});

add('cgroup v2: "max" means no limit; a missing stat counts no inactive cache', () => {
  const fsImpl = fakeFs({ '/cg/memory.current': '123\n', '/cg/memory.max': 'max\n' });
  assert.deepStrictEqual(readCgroupMemory({ fsImpl, root: '/cg' }), { usage: 123, limit: null });
});

add('cgroup v1: total_inactive_file is subtracted, the 2^63 sentinel is no limit', () => {
  const fsImpl = fakeFs({
    '/cg/memory/memory.usage_in_bytes': '3000\n',
    '/cg/memory/memory.stat': 'cache 10\ninactive_file 7\ntotal_inactive_file 1000\n',
    '/cg/memory/memory.limit_in_bytes': '9223372036854771712\n',
  });
  assert.deepStrictEqual(readCgroupMemory({ fsImpl, root: '/cg' }), { usage: 2000, limit: null });
  const limited = fakeFs({
    '/cg/memory/memory.usage_in_bytes': '3000\n',
    '/cg/memory/memory.limit_in_bytes': '4096\n',
  });
  assert.deepStrictEqual(readCgroupMemory({ fsImpl: limited, root: '/cg' }), { usage: 3000, limit: 4096 });
});

add('no cgroup memory controller → null', () => {
  assert.strictEqual(readCgroupMemory({ fsImpl: fakeFs({}), root: '/cg' }), null);
});

// ---- configFromEnv ----------------------------------------------------------------

add('configFromEnv: defaults 70/80, 120 s cooldown, 10 s timer; bad values fall back', () => {
  assert.deepStrictEqual(configFromEnv({}), {
    softPct: 70, hardPct: 80, limitOverride: null, hardCooldownMs: 120000, checkIntervalMs: 10000,
  });
  const real = console.warn;
  const warned = [];
  console.warn = (msg) => warned.push(String(msg));
  try {
    const c = configFromEnv({
      MEMORY_RECYCLE_SOFT_PCT: '65', MEMORY_RECYCLE_HARD_PCT: '150', MEMORY_LIMIT_MB: '2048',
      MEMORY_RECYCLE_COOLDOWN_SEC: '0', MEMORY_CHECK_INTERVAL_SEC: '0',
    });
    assert.deepStrictEqual(c, {
      softPct: 65, hardPct: 80, limitOverride: 2048 * MIB, hardCooldownMs: 0, checkIntervalMs: 0,
    });
  } finally {
    console.warn = real;
  }
  assert.strictEqual(warned.length, 1);
});

// ---- createMemoryGuard ------------------------------------------------------------

function makeGuard(over = {}) {
  const state = { usage: 1 * GIB, limit: 8 * GIB, t: 0 };
  const calls = { soft: [], hard: [] };
  const guard = createMemoryGuard({
    readUsage: () => ({ usage: state.usage, limit: state.limit }),
    softPct: 70,
    hardPct: 80,
    hardCooldownMs: 120000,
    onSoft: (info) => calls.soft.push(info),
    onHard: (info) => calls.hard.push(info),
    now: () => state.t,
    log: quiet,
    ...over,
  });
  return { guard, state, calls };
}

add('below soft: nothing happens', () => {
  const { guard, state, calls } = makeGuard();
  state.usage = 5.5 * GIB; // 68.75 %
  assert.strictEqual(guard.check('before-job'), 'ok');
  assert.deepStrictEqual(calls, { soft: [], hard: [] });
});

add('soft: fires once on crossing, not again while it stays, again after dropping back', () => {
  const { guard, state, calls } = makeGuard();
  state.usage = 5.7 * GIB; // 71.25 %
  assert.strictEqual(guard.check('after-job'), 'soft');
  assert.strictEqual(calls.soft.length, 1);
  assert.strictEqual(calls.soft[0].reason, 'after-job');
  assert.strictEqual(calls.soft[0].limit, 8 * GIB);
  guard.check('timer');
  guard.check('after-job');
  assert.strictEqual(calls.soft.length, 1);
  state.usage = 3 * GIB;
  assert.strictEqual(guard.check('timer'), 'ok');
  state.usage = 5.7 * GIB;
  guard.check('timer');
  assert.strictEqual(calls.soft.length, 2);
  assert.strictEqual(calls.hard.length, 0);
});

add('exactly at the soft and hard percentages counts as crossing', () => {
  const { guard, state, calls } = makeGuard();
  state.usage = 0.7 * 8 * GIB;
  assert.strictEqual(guard.check('timer'), 'soft');
  state.usage = 0.8 * 8 * GIB;
  assert.strictEqual(guard.check('timer'), 'hard');
  assert.strictEqual(calls.soft.length, 1);
  assert.strictEqual(calls.hard.length, 1);
});

add('hard: one restart while it is in flight; cooldown counts from its end', async () => {
  let finish;
  const { guard, state, calls } = makeGuard({
    onHard: (info) => {
      calls.hard.push(info);
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  state.usage = 7 * GIB; // 87.5 %
  assert.strictEqual(guard.check('after-job'), 'hard');
  assert.strictEqual(calls.hard.length, 1);
  // Draining takes long: no second restart, whatever the clock says.
  state.t = 600000;
  guard.check('timer');
  guard.check('before-job');
  assert.strictEqual(calls.hard.length, 1);
  finish();
  await flush();
  // Still above hard right after the restart: wait out the cooldown, do not loop.
  state.t = 600000 + 119000;
  guard.check('timer');
  assert.strictEqual(calls.hard.length, 1);
  state.t = 600000 + 120000;
  guard.check('timer');
  assert.strictEqual(calls.hard.length, 2);
});

add('hard: a failed restart also ends the in-flight state', async () => {
  let fail;
  const { guard, state, calls } = makeGuard({
    hardCooldownMs: 0,
    onHard: (info) => {
      calls.hard.push(info);
      return new Promise((_, reject) => { fail = reject; });
    },
  });
  state.usage = 7 * GIB;
  guard.check('timer');
  fail(new Error('boom'));
  await flush();
  guard.check('timer');
  assert.strictEqual(calls.hard.length, 2);
});

add('hard skips soft: the soft action is not run on the way up through hard', () => {
  const { guard, state, calls } = makeGuard();
  state.usage = 7.5 * GIB;
  assert.strictEqual(guard.check('timer'), 'hard');
  assert.strictEqual(calls.soft.length, 0);
  assert.strictEqual(calls.hard.length, 1);
});

add('off without a limit; MEMORY_LIMIT_MB override turns it on', () => {
  const { guard, state, calls } = makeGuard();
  state.limit = null;
  state.usage = 100 * GIB;
  assert.strictEqual(guard.check('timer'), 'off');
  const over = makeGuard({ limitOverride: 2 * GIB });
  over.state.limit = null;
  over.state.usage = 1.8 * GIB; // 90 % of the override
  assert.strictEqual(over.guard.check('timer'), 'hard');
  assert.strictEqual(over.calls.hard.length, 1);
  assert.strictEqual(calls.hard.length, 0);
});

add('a level of 0 is off; hard below soft is lifted to soft', () => {
  const noHard = makeGuard({ hardPct: 0 });
  noHard.state.usage = 7.9 * GIB;
  assert.strictEqual(noHard.guard.check('timer'), 'soft');
  assert.strictEqual(noHard.calls.hard.length, 0);
  const inverted = makeGuard({ softPct: 70, hardPct: 50 });
  inverted.state.usage = 4.5 * GIB; // 56 %: above 50, below 70
  assert.strictEqual(inverted.guard.check('timer'), 'ok');
  assert.deepStrictEqual(inverted.guard.config().hard, 70);
});

add('a throwing reader or action never escapes check()', () => {
  const broken = makeGuard({ readUsage: () => { throw new Error('EACCES'); } });
  assert.strictEqual(broken.guard.check('timer'), 'off');
  const { guard, state } = makeGuard({ onHard: () => { throw new Error('no hooks'); } });
  state.usage = 7.9 * GIB;
  assert.strictEqual(guard.check('timer'), 'hard');
});

// ---- chatgpt.markAllSlotsForRecycle -------------------------------------------------

add('markAllSlotsForRecycle marks slots with a page and never downgrades a pending reset', () => {
  const chatgpt = require('../src/chatgpt');
  const a = chatgpt.getSlot(11);
  const b = chatgpt.getSlot(12);
  const c = chatgpt.getSlot(13);
  a.page = {};
  b.page = {};
  b.pendingReset = 'hard';
  c.page = null;
  const real = console.log;
  console.log = quiet;
  let marked;
  try {
    marked = chatgpt.markAllSlotsForRecycle('memory 71%');
  } finally {
    console.log = real;
  }
  assert.strictEqual(a.pendingReset, 'recycle');
  assert.strictEqual(b.pendingReset, 'hard');
  assert.strictEqual(c.pendingReset, null);
  assert.ok(marked >= 1);
  a.page = null; a.pendingReset = null;
  b.page = null; b.pendingReset = null;
});

// ---- route wiring: the pool holds new jobs, never the running one ---------------------

function loadRouterWithStubs(memState, events) {
  const chatgptPath = require.resolve('../src/chatgpt');
  const guardPath = require.resolve('../src/memory-guard');
  const imagesPath = require.resolve('../src/routes/images');
  const saved = {
    chatgpt: require.cache[chatgptPath],
    guard: require.cache[guardPath],
    env: { MAX_CONCURRENT_JOBS: process.env.MAX_CONCURRENT_JOBS, MIN_TURN_STAGGER_SEC: process.env.MIN_TURN_STAGGER_SEC,
      MIN_JOB_GAP_SEC: process.env.MIN_JOB_GAP_SEC, MEMORY_CHECK_INTERVAL_SEC: process.env.MEMORY_CHECK_INTERVAL_SEC },
  };
  const bridge = { gates: [] };
  const stub = {
    READ_VIA_BACKEND_API: true,
    setPoolHooks(hooks) { bridge.poolHooks = hooks; },
    getPoolHooks() { return bridge.poolHooks; },
    completeText: async (prompt, options) => {
      if (options && typeof options.beforeSubmit === 'function') await options.beforeSubmit();
      events.push(`start ${prompt}`);
      await new Promise((resolve) => bridge.gates.push({ prompt, resolve }));
      events.push(`end ${prompt}`);
      return { text: `ok ${prompt}`, conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
    },
    generateImage: async () => ({}),
    editImage: async () => ({}),
    probeCapabilities: async () => ({}),
    recordSlotJobFinished() {},
    markAllSlotsForRecycle(reason) { events.push(`soft ${reason}`); return 1; },
    hardResetBrowser: async () => {
      events.push('restart begin');
      await new Promise((resolve) => { bridge.finishRestart = resolve; });
      events.push('restart end');
    },
    resetPage() {},
    resetAllSlotPages() {},
  };
  const realGuard = require('../src/memory-guard');
  const fakeGuardModule = {
    ...realGuard,
    readCgroupMemory: () => ({ usage: memState.usage, limit: 8 * GIB }),
  };
  for (const [p, exp] of [[chatgptPath, stub], [guardPath, fakeGuardModule]]) {
    const m = new Module(p);
    m.filename = p;
    m.loaded = true;
    m.exports = exp;
    require.cache[p] = m;
  }
  process.env.MAX_CONCURRENT_JOBS = '1';
  process.env.MIN_TURN_STAGGER_SEC = '0';
  process.env.MIN_JOB_GAP_SEC = '0';
  process.env.MEMORY_CHECK_INTERVAL_SEC = '0';
  delete require.cache[imagesPath];
  const router = require('../src/routes/images');
  return {
    router,
    bridge,
    restore() {
      delete require.cache[imagesPath];
      if (saved.chatgpt) require.cache[chatgptPath] = saved.chatgpt; else delete require.cache[chatgptPath];
      if (saved.guard) require.cache[guardPath] = saved.guard; else delete require.cache[guardPath];
      for (const [k, v] of Object.entries(saved.env)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    },
  };
}

function post(port, prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ input: prompt });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function waitFor(pred, label, ms = 3000) {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

add('route: hard level after a job holds the queue until the restart, running job completes', async () => {
  const mem = { usage: 2 * GIB };
  const events = [];
  const env = loadRouterWithStubs(mem, events);
  const realLog = console.log;
  console.log = quiet;
  const app = express();
  app.use(express.json());
  app.use(env.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const first = post(port, 'A');
    await waitFor(() => events.includes('start A'), 'A running');
    const second = post(port, 'B');
    await waitFor(() => env.bridge.poolHooks.status().waiting === 1, 'B queued');
    // Memory crosses hard while A runs: A is not touched.
    mem.usage = 7 * GIB;
    env.bridge.gates.shift().resolve();
    const a = await first;
    assert.strictEqual(a.status, 200);
    await waitFor(() => events.includes('restart begin'), 'restart started');
    assert.ok(!events.includes('start B'), 'B must not start before the restart is done');
    mem.usage = 1.5 * GIB;
    env.bridge.finishRestart();
    await waitFor(() => events.includes('start B'), 'B started after restart');
    env.bridge.gates.shift().resolve();
    const b = await second;
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(events, ['start A', 'end A', 'restart begin', 'restart end', 'start B', 'end B']);
  } finally {
    console.log = realLog;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    env.restore();
  }
});

add('route: hard level at submit queues the new job behind the restart', async () => {
  const mem = { usage: 7.2 * GIB };
  const events = [];
  const env = loadRouterWithStubs(mem, events);
  const realLog = console.log;
  console.log = quiet;
  const app = express();
  app.use(express.json());
  app.use(env.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const first = post(port, 'A');
    await waitFor(() => events.includes('restart begin'), 'restart before A');
    assert.ok(!events.includes('start A'));
    mem.usage = 1 * GIB;
    env.bridge.finishRestart();
    await waitFor(() => events.includes('start A'), 'A after restart');
    env.bridge.gates.shift().resolve();
    assert.strictEqual((await first).status, 200);
  } finally {
    console.log = realLog;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    env.restore();
  }
});

add('route: soft level marks pages for recycle and keeps admitting jobs', async () => {
  const mem = { usage: 5.8 * GIB }; // 72.5 %
  const events = [];
  const env = loadRouterWithStubs(mem, events);
  const realLog = console.log;
  console.log = quiet;
  const app = express();
  app.use(express.json());
  app.use(env.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const first = post(port, 'A');
    await waitFor(() => events.includes('start A'), 'A running');
    env.bridge.gates.shift().resolve();
    assert.strictEqual((await first).status, 200);
    assert.strictEqual(events.filter((e) => e.startsWith('soft ')).length, 1);
    assert.ok(!events.includes('restart begin'));
  } finally {
    console.log = realLog;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    env.restore();
  }
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  }
  console.log(`\n${passed}/${tests.length} memory-guard tests passed`);
  process.exit(0);
})();
