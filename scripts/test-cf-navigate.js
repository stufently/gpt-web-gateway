// Orchestration tests for src/cf-navigate.js against a FAKE page.
//
// The pure policy in src/cloudflare.js can be right while the loop that uses it is wrong —
// that is exactly how the 34-hour outage happened (a correct challenge detector, wired into a
// loop that never re-navigated). These tests drive the real retry sequence with a scripted
// page: no browser, no network, no wall-clock waiting (`now` and `waitForTimeout` are fakes).
const assert = require('assert');
const { gotoWithChallengeRetry } = require('../src/cf-navigate');

let failures = 0;
function check(name, fn) {
  return fn().then(
    () => console.log(`PASS: ${name}`),
    (e) => { failures++; console.log(`FAIL: ${name} — ${e.message}`); },
  );
}

/**
 * A page whose every navigation returns the next scripted outcome.
 * Each outcome: { title, headers } — `headers` becomes the navigation response's headers.
 * Time is virtual: waitForTimeout advances the fake clock instead of sleeping.
 */
function fakePage(outcomes, opts = {}) {
  const state = { clock: 0, gotos: [], waits: [], titles: 0 };
  let current = { title: '', headers: null };
  const page = {
    async goto(url, options) {
      state.gotos.push({ url, options, at: state.clock });
      current = outcomes[Math.min(state.gotos.length - 1, outcomes.length - 1)];
      // A navigation costs time. Without this the budget tests would prove nothing — the
      // sequence would look free, which is exactly how a "wall-clock ceiling" that only
      // counted the waits got past the first review.
      state.clock += Math.min(current.gotoMs === undefined ? opts.gotoMs || 1000 : current.gotoMs,
        options && options.timeout ? options.timeout : Infinity);
      if (current.throws) throw new Error(current.throws);
      return current.headers === undefined ? null : { headers: () => current.headers };
    },
    async title() {
      state.titles++;
      if (opts.titleThrows) throw new Error('title boom');
      // A challenge may clear DURING the grace: the outcome can carry a later title.
      if (current.clearsAfterMs !== undefined && state.clock >= (current.clearsAt || Infinity)) {
        return current.clearedTitle || 'ChatGPT';
      }
      return current.title;
    },
    async waitForTimeout(ms) {
      state.waits.push(ms);
      state.clock += ms;
      if (current.clearsAfterMs !== undefined && current.clearsAt === undefined) {
        current.clearsAt = state.clock + current.clearsAfterMs - ms;
      }
    },
    url: () => 'https://chatgpt.com/',
  };
  return { page, state, now: () => state.clock };
}

const quiet = () => {};
const CHALLENGE = { title: 'Just a moment...', headers: { 'cf-mitigated': 'challenge' } };
const OK = { title: 'ChatGPT: Chat, Work, Create & Code with AI', headers: {} };

(async () => {
  await check('a clean first navigation returns immediately, with no waiting', async () => {
    const { page, state, now } = fakePage([OK]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(state.gotos.length, 1);
    assert.deepStrictEqual(state.waits, []);
  });

  await check('THE fix: a challenge is answered with a SECOND navigation, and it passes', async () => {
    const { page, state, now } = fakePage([CHALLENGE, OK]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(r.blocked, false, 'the retry should have cleared the challenge');
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(state.gotos.length, 2, 'it must navigate again, not just wait');
    assert.ok(state.waits.includes(45000), `expected a 45s gap, got ${state.waits}`);
  });

  await check('a challenge known only from cf-mitigated, with no title yet, is retried', async () => {
    // The realistic shape right after domcontentloaded: the header carries the verdict and
    // the title is still empty. An empty title must NOT be read as "the challenge cleared" —
    // that mistake was in the first cut of this module and this test is what found it.
    const { page, state, now } = fakePage([{ title: '', headers: { 'cf-mitigated': 'challenge' } }, OK]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(state.gotos.length, 2, 'an empty title cancelled a header verdict');
  });

  await check('a real title outweighs a stale cf-mitigated header — we are through', async () => {
    // The interstitial hands over to the real document in place, so a genuine page title is
    // the stronger signal. Deliberate, and asserted so it stays a decision rather than a bug.
    const { page, state, now } = fakePage([{ title: 'ChatGPT', headers: { 'cf-mitigated': 'challenge' } }]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(state.gotos.length, 1);
  });

  await check('an alternate interstitial wording is retried too', async () => {
    const { page, state, now } = fakePage([{ title: 'Attention Required! | Cloudflare', headers: {} }, OK]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(state.gotos.length, 2);
  });

  await check('a challenge that clears itself during the grace needs no second navigation', async () => {
    const { page, state, now } = fakePage([{ ...CHALLENGE, clearsAfterMs: 4000 }]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(state.gotos.length, 1, 'no re-navigation was needed');
  });

  await check('every attempt is spent before reporting blocked', async () => {
    const { page, state, now } = fakePage([CHALLENGE]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', {
      attempts: 3, budgetMs: 300000, now, log: quiet,
    });
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(state.gotos.length, 3);
    assert.strictEqual(r.attempts, 3);
  });

  await check('the budget stops the sequence early instead of running past the caller', async () => {
    const { page, state, now } = fakePage([CHALLENGE]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', {
      attempts: 5, budgetMs: 60000, now, log: quiet,
    });
    assert.strictEqual(r.blocked, true);
    assert.ok(state.gotos.length < 5, `budget should cut the attempts short, made ${state.gotos.length}`);
    assert.ok(now() <= 120000, `sequence ran ${now()}ms, well past its 60s budget`);
  });

  await check('the reported attempt count is what happened, not what was configured', async () => {
    // A caller that logs `attempts` (auto-login does) must not be told about navigations a
    // spent budget prevented — that is a fabricated diagnostic (Codex review, round 2).
    const { page, state, now } = fakePage([CHALLENGE]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', {
      attempts: 5, budgetMs: 30000, now, log: quiet,
    });
    assert.strictEqual(r.attempts, state.gotos.length, 'reported attempts must match real ones');
    assert.ok(r.attempts < 5);
  });

  await check('SLOW navigations cannot outrun the budget either', async () => {
    // The hole the first fix left: the budget counted grace and gaps but not the navigations,
    // so three 30 s `goto`s spent 250 s against a 240 s ceiling (Codex review, round 2).
    const { page, state, now } = fakePage([{ ...CHALLENGE, gotoMs: 30000 }]);
    await gotoWithChallengeRetry(page, 'https://chatgpt.com', {
      attempts: 5, budgetMs: 150000, timeout: 30000, now, log: quiet,
    });
    assert.ok(now() <= 150000, `sequence ran ${now()}ms against a 150s budget`);
    // …while still leaving room for a real retry: a ceiling that only ever allows one
    // navigation would "fit the budget" by doing nothing, which is the bug, not the fix.
    assert.ok(state.gotos.length >= 2, `expected a retry, made ${state.gotos.length} navigation(s)`);
  });

  await check('a SLOW first navigation still gets its retry, on a shortened pause', async () => {
    // Codex round 4: with a 30s goto the second attempt used to be dropped because the full
    // 45s gap no longer fit. The retry is the product here — the wait is not.
    const { page, state, now } = fakePage([{ ...CHALLENGE, gotoMs: 30000 }, OK]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(state.gotos.length, 2, 'the slow first navigation cost us the retry');
    assert.strictEqual(r.blocked, false);
    assert.ok(now() <= 90000, `sequence ran ${now()}ms against the default 90s budget`);
  });

  await check('the default sequence can actually use all its attempts', async () => {
    // The regression this guards: defaults where the budget makes the last attempt
    // unreachable, so a configured retry silently never happens.
    const { page, state, now } = fakePage([CHALLENGE]);
    await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(state.gotos.length, 2, `defaults allowed only ${state.gotos.length} attempts`);
  });

  await check('a page whose title() throws is retried on the header alone, then settles', async () => {
    // An unreadable title cannot clear a challenge (it never "settles"), so the header verdict
    // stands and the navigation is retried; the second response carries no challenge header,
    // so the sequence ends without throwing and without looping.
    const { page, state, now } = fakePage([CHALLENGE, OK], { titleThrows: true });
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { attempts: 2, now, log: quiet });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(state.gotos.length, 2);
  });

  await check('a goto that throws propagates — it is not a challenge', async () => {
    const { page, now } = fakePage([{ throws: 'net::ERR_ABORTED' }]);
    await assert.rejects(
      () => gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet }),
      /ERR_ABORTED/,
    );
  });

  await check('a null navigation response does not crash the retry', async () => {
    const { page, state, now } = fakePage([{ title: 'Just a moment...', headers: undefined }, OK]);
    const r = await gotoWithChallengeRetry(page, 'https://chatgpt.com', { now, log: quiet });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(state.gotos.length, 2);
  });

  if (failures) {
    console.log(`\n${failures} cf-navigate test(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll cf-navigate tests passed.');
})();
