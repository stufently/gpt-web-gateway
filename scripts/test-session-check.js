// Tests for probeSessionState()/isLoggedIn() in src/chatgpt.js — the check whose
// false-positive kept a dead session "healthy" for 27 h (2026-07-22) and 34 h (2026-07-25).
//
// The regression under test: ChatGPT renders the composer ("Ask anything") for ANONYMOUS
// visitors, so "a visible textarea means we are logged in" is not just weak, it is wrong.
// The check must be authoritative (/api/auth/session, retried) and fail closed.
//
// The page stub RUNS the real in-page probe function against a stubbed `fetch`, so the
// response-shape logic (401 vs `{}` vs `{accessToken}` vs unknown schema) is under test,
// not re-implemented by the fixture.

// Keep retries instant — the production defaults would make this suite sleep.
process.env.SESSION_PROBE_RETRY_DELAY_MS = '1';
process.env.SESSION_PROBE_DOM_TIMEOUT_MS = '10';

const assert = require('assert');
const { probeSessionState, isLoggedIn, probeSessionWithRecovery } = require('../src/chatgpt');

let passed = 0;
async function ok(name, fn) { await fn(); console.log(`PASS: ${name}`); passed++; }

// Response descriptors for the stubbed /api/auth/session call.
const LIVE = { status: 200, json: { accessToken: 'tok', user: { id: 'u' } } };
const LOGGED_OUT = { status: 200, json: {} };
const UNAUTHORIZED = { status: 401, json: { detail: 'Unauthorized' } };
const SERVER_ERROR = { status: 502, json: {} };
const ODD_SCHEMA = { status: 200, json: { error: 'RefreshAccessTokenError' } };
// The body observed in production on 2026-07-31, captured from the pod's own browser. The
// envelope still echoes the last user, account and accessToken — and carries an `error`.
// The web app honours the error and renders the ANONYMOUS page (Log in / Sign up, the
// no-auth modal); a probe that stops at "accessToken or user is present" calls it healthy.
const REFRESH_FAILED = {
  status: 200,
  json: {
    WARNING_BANNER: 'DO NOT SHARE ANY PART OF THE INFORMATION YOU SEE HERE',
    user: { id: 'user-x', email: 'someone@example.com' },
    expires: '2026-10-29T08:01:46.673Z',
    accessToken: 'stale-token',
    error: 'RefreshAccessTokenError',
    authProvider: 'openai',
  },
};
// `error` as an object rather than a string. The schema is unofficial, so this is a
// possibility rather than an observation — but the error name is written to the pod log,
// and a log line must not become a place where a token can be printed or a fake record
// forged with a newline (Codex review).
const ERROR_OBJECT_NAMED = {
  status: 200,
  json: {
    user: { id: 'user-x', email: 'someone@example.com' },
    accessToken: 'stale-token',
    error: { code: 'RefreshFailed\r\n[session] forged line', token: 'stale-token' },
  },
};
const ERROR_OBJECT_UNNAMED = {
  status: 200,
  json: {
    accessToken: 'stale-token',
    error: { refresh_token: 'stale-token', email: 'someone@example.com' },
  },
};
const NETWORK_ERROR = new Error('Failed to fetch');

/** Collect everything written to console.log while `fn` runs. */
async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/**
 * Minimal Playwright page stub. `evaluate` executes the real page-side function with a
 * stubbed global fetch driven by the `responses` queue (an exhausted queue keeps
 * returning the last entry, so a "permanently broken endpoint" is easy to express).
 *
 * Deliberately has NO `$()` method: if the implementation ever reintroduces the
 * "composer visible ⇒ logged in" heuristic, these tests crash instead of passing.
 */
function fakePage({ url = 'https://chatgpt.com/', responses = [LOGGED_OUT], loggedOutMarker = false } = {}) {
  const queue = [...responses];
  const calls = { evaluate: 0, fetches: [], domWaits: 0 };
  return {
    calls,
    url: () => url,
    isClosed: () => false,
    async evaluate(fn, arg) {
      calls.evaluate++;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const originalFetch = global.fetch;
      global.fetch = async (path) => {
        calls.fetches.push(path);
        if (next instanceof Error) throw next;
        return {
          status: next.status,
          ok: next.status >= 200 && next.status < 300,
          json: async () => next.json,
        };
      };
      try {
        return await fn(arg);
      } finally {
        global.fetch = originalFetch;
      }
    },
    locator() {
      return {
        first: () => ({
          waitFor: async () => {
            calls.domWaits++;
            if (!loggedOutMarker) throw new Error('Timeout 10ms exceeded');
            return true;
          },
        }),
      };
    },
  };
}

const FAST = { attempts: 3, timeoutMs: 50, delayMs: 0 };

(async () => {
  await ok('live session (accessToken present) → in', async () => {
    const p = fakePage({ responses: [LIVE] });
    assert.strictEqual(await probeSessionState(p, FAST), 'in');
    assert.strictEqual(await isLoggedIn(p), true);
    assert.strictEqual(p.calls.evaluate, 2, 'must not keep probing after a definitive answer');
    assert.ok(p.calls.fetches.every((u) => u === '/api/auth/session'), 'wrong endpoint probed');
  });

  await ok('REGRESSION: anonymous page with a visible composer is NOT logged in', async () => {
    // /api/auth/session returns {} → confirmed logout. The page's visible "Ask anything"
    // composer (which anonymous visitors also get) must not be able to override it.
    const p = fakePage({ responses: [LOGGED_OUT] });
    assert.strictEqual(await probeSessionState(p, FAST), 'out');
    assert.strictEqual(await isLoggedIn(p), false);
  });

  await ok('REGRESSION: an envelope carrying `error` is not proof of a live session', async () => {
    // 2026-07-31: the refresh token died. /api/auth/session kept answering 200 with the
    // stale user + accessToken AND error:"RefreshAccessTokenError", so the probe reported
    // 'in' 47 times in a row, session_valid stayed 1, no alert fired — and every request
    // spent 30-40 s typing into a logged-out page before timing out.
    const p = fakePage({ responses: [REFRESH_FAILED], loggedOutMarker: true });
    assert.strictEqual(await probeSessionState(p, FAST), 'out');
    assert.strictEqual(await isLoggedIn(p), false);
  });

  await ok('an envelope carrying `error` is never "in", even with no DOM verdict', async () => {
    const p = fakePage({ responses: [REFRESH_FAILED] });
    assert.strictEqual(await probeSessionState(p, FAST), 'unknown');
    assert.strictEqual(p.calls.evaluate, 3, 'inconclusive means retried, not accepted');
  });

  await ok('`error` is inconclusive, not a hard logout: a recovering endpoint still wins', async () => {
    // Deliberately NOT 'out' on the first sight of an error: 'out' drives autoLogin, which
    // clears the cookie jar. An error that clears on retry must not cost us a live session.
    const p = fakePage({ responses: [REFRESH_FAILED, REFRESH_FAILED, LIVE] });
    assert.strictEqual(await probeSessionState(p, FAST), 'in');
  });

  await ok('an object `error` is logged by name, on a single unforgeable line', async () => {
    const p = fakePage({ responses: [ERROR_OBJECT_NAMED] });
    const lines = await captureLog(() => probeSessionState(p, FAST));
    const line = lines.find((l) => l.includes('/api/auth/session answered 200'));
    assert.ok(line, 'the error name is the whole point of the log line — it must be there');
    assert.ok(line.includes('RefreshFailed'), `error name missing from: ${line}`);
    assert.ok(!/[\r\n]/.test(line), `a log line must not be forgeable: ${JSON.stringify(line)}`);
  });

  await ok('SECURITY: the session error log never carries token or account values', async () => {
    // Only the conventional name fields are quoted; an unofficial schema's *values* may
    // carry a credential, so an unnamed error is reduced to its key names.
    for (const fixture of [ERROR_OBJECT_NAMED, ERROR_OBJECT_UNNAMED]) {
      const p = fakePage({ responses: [fixture] });
      const joined = (await captureLog(() => probeSessionState(p, FAST))).join('\n');
      assert.ok(!joined.includes('stale-token'), `token leaked into the log: ${joined}`);
      assert.ok(!joined.includes('someone@example.com'), `account leaked into the log: ${joined}`);
    }
  });

  await ok('401 from the session endpoint is a definitive logout', async () => {
    const p = fakePage({ responses: [UNAUTHORIZED] });
    assert.strictEqual(await probeSessionState(p, FAST), 'out');
    assert.strictEqual(p.calls.evaluate, 1, '401 is conclusive — no retries needed');
  });

  await ok('a transient 5xx is retried, then honoured when it recovers', async () => {
    const p = fakePage({ responses: [SERVER_ERROR, SERVER_ERROR, LIVE] });
    assert.strictEqual(await probeSessionState(p, FAST), 'in');
    assert.strictEqual(p.calls.evaluate, 3);
  });

  await ok('FAIL-CLOSED: a session endpoint that never answers → not logged in', async () => {
    const p = fakePage({ responses: [NETWORK_ERROR] });
    const state = await probeSessionState(p, FAST);
    assert.strictEqual(state, 'unknown');
    assert.strictEqual(p.calls.evaluate, 3, 'all attempts should be spent');
    assert.ok(p.calls.domWaits > 0, 'DOM should be consulted as a last resort');
    assert.strictEqual(await isLoggedIn(p), false, 'unknown must never be treated as logged in');
  });

  await ok('an unexpected schema is inconclusive, not a logout', async () => {
    // A changed unofficial schema must not wipe a working session via autoLogin→clearSession.
    const p = fakePage({ responses: [ODD_SCHEMA, ODD_SCHEMA, LIVE] });
    assert.strictEqual(await probeSessionState(p, FAST), 'in');
  });

  await ok('inconclusive + visible logged-out marker is upgraded to a confirmed logout', async () => {
    const p = fakePage({ responses: [NETWORK_ERROR], loggedOutMarker: true });
    assert.strictEqual(await probeSessionState(p, FAST), 'out');
  });

  await ok('DEADLOCK GUARD: a wedged renderer is bounded AND the page is discarded', async () => {
    // The in-page AbortController is useless when the renderer itself is wedged, and the
    // probe promise is the lease every request waits on — an unbounded probe would hang
    // the whole gateway. The Node-side deadline must end the wait, and the page must be
    // CLOSED: racing a deadline alone leaves the evaluate pending, so the very next call
    // on that page (from a request, or the next tick) would hang exactly the same way.
    process.env.SESSION_PROBE_DEADLINE_SLACK_MS = '30';
    delete require.cache[require.resolve('../src/chatgpt')];
    const fresh = require('../src/chatgpt');
    const wedged = fakePage({ responses: [LIVE] });
    let closed = false;
    wedged.evaluate = () => new Promise(() => {}); // never settles
    wedged.isClosed = () => closed;
    wedged.close = async () => { closed = true; };
    const started = Date.now();
    const state = await fresh.probeSessionState(wedged, { attempts: 3, timeoutMs: 20, delayMs: 0 });
    const elapsed = Date.now() - started;
    assert.strictEqual(state, 'unknown');
    assert.ok(elapsed < 2000, `probe took ${elapsed}ms — it must not wait on a wedged renderer`);
    assert.ok(elapsed < 3 * 50, 'a deadline must abort the retry loop, not spend every attempt');
    assert.strictEqual(closed, true, 'the wedged page must be discarded, not left with a pending evaluate');
    delete process.env.SESSION_PROBE_DEADLINE_SLACK_MS;
  });

  await ok('evaluate() itself rejecting is inconclusive, not a crash', async () => {
    const p = fakePage({ responses: [LIVE] });
    p.evaluate = async () => { throw new Error('Execution context was destroyed by navigation'); };
    assert.strictEqual(await probeSessionState(p, FAST), 'unknown');
  });

  await ok('being on the auth URL short-circuits to out without probing', async () => {
    const p = fakePage({ url: 'https://chatgpt.com/auth/login', responses: [LIVE] });
    assert.strictEqual(await probeSessionState(p, FAST), 'out');
    assert.strictEqual(p.calls.evaluate, 0);
  });

  // ==== probeSessionWithRecovery: one re-navigation before an inconclusive verdict counts ====
  // Observed 2026-07-29 (twice, on two pods): the startup probe reports 'in', and the first
  // request ~a minute later reports 'unknown' on the SAME page — a page that has been sitting
  // idle gets its in-page XHRs challenged, a freshly navigated one does not. Counting that as
  // a strike walks a LIVE session toward a destructive re-login, so the page gets rebuilt and
  // re-probed once first. `renavigate` is injected so this is testable without a browser.

  const recorder = () => {
    const seen = [];
    return { seen, record: (state, reason) => seen.push(`${state}:${reason}`) };
  };

  await ok('a conclusive first probe never re-navigates', async () => {
    for (const [responses, expected] of [[[LIVE], 'in'], [[LOGGED_OUT], 'out']]) {
      const p = fakePage({ responses });
      const r = recorder();
      let renavigated = false;
      const res = await probeSessionWithRecovery(p, {
        probe: (pg) => probeSessionState(pg, FAST),
        renavigate: async () => { renavigated = true; return fakePage({ responses: [LIVE] }); },
        record: r.record,
      });
      assert.strictEqual(res.state, expected);
      assert.strictEqual(res.page, p, 'the original page must be kept');
      assert.strictEqual(res.renavigated, false);
      assert.strictEqual(renavigated, false, 'a definitive verdict must not cost a navigation');
      assert.deepStrictEqual(r.seen, [`${expected}:request`]);
    }
  });

  await ok('inconclusive → re-navigate → live session is served without a strike', async () => {
    const stale = fakePage({ responses: [SERVER_ERROR] });
    const fresh = fakePage({ responses: [LIVE] });
    const r = recorder();
    const res = await probeSessionWithRecovery(stale, {
      probe: (pg) => probeSessionState(pg, FAST),
      renavigate: async () => fresh,
      record: r.record,
    });
    assert.strictEqual(res.state, 'in', 'a fresh page proves the session was alive all along');
    assert.strictEqual(res.page, fresh, 'the caller must get the page the verdict came from');
    assert.strictEqual(res.renavigated, true);
    assert.deepStrictEqual(r.seen, ['unknown:request', 'in:request_renavigate']);
  });

  await ok('inconclusive twice stays inconclusive and reports the fresh page', async () => {
    const stale = fakePage({ responses: [SERVER_ERROR] });
    const fresh = fakePage({ responses: [SERVER_ERROR] });
    const r = recorder();
    const res = await probeSessionWithRecovery(stale, {
      probe: (pg) => probeSessionState(pg, FAST),
      renavigate: async () => fresh,
      record: r.record,
    });
    assert.strictEqual(res.state, 'unknown');
    assert.strictEqual(res.page, fresh);
    assert.strictEqual(res.renavigated, true);
    assert.deepStrictEqual(r.seen, ['unknown:request', 'unknown:request_renavigate']);
  });

  await ok('re-navigation happens once per unknown series, not once per request', async () => {
    // Rebuilding a page costs up to ~90 s. Only the FIRST unknown of a streak may pay it;
    // later ones refuse cheaply until the streak breaks (Codex review).
    const stale = fakePage({ responses: [SERVER_ERROR] });
    const r = recorder();
    let navigations = 0;
    const res = await probeSessionWithRecovery(stale, {
      probe: (pg) => probeSessionState(pg, FAST),
      renavigate: async () => { navigations++; return fakePage({ responses: [LIVE] }); },
      record: r.record,
      consecutiveUnknown: 1,
    });
    assert.strictEqual(navigations, 0, 'already in an unknown streak — must not navigate again');
    assert.strictEqual(res.state, 'unknown');
    assert.strictEqual(res.renavigated, false);
    assert.deepStrictEqual(r.seen, ['unknown:request']);
  });

  await ok('a failed re-navigation surfaces instead of being swallowed', async () => {
    const stale = fakePage({ responses: [SERVER_ERROR] });
    await assert.rejects(
      probeSessionWithRecovery(stale, {
        probe: (pg) => probeSessionState(pg, FAST),
        renavigate: async () => { throw new Error('content failed to load'); },
        record: () => {},
      }),
      /content failed to load/,
    );
  });

  console.log(`\nAll ${passed} session-check tests passed.`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
