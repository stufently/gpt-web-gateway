// Tests for src/turnstile.js — the geometry, the retry policy, and the two loops that use
// them, driven against a FAKE page (no browser, no network, no wall-clock waiting).
//
// The loops are tested and not just the predicates on purpose: the outage this module exists
// to fix was a correct challenge DETECTOR wired into a loop that never clicked anything, and a
// pure-function suite would have passed all the way through it.
const assert = require('assert');
const {
  isTurnstileFrameUrl,
  checkboxPointIn,
  humanizePoint,
  nextSolveAction,
  findWidgetBox,
  probeWidget,
  waitForAnyThroughChallenge,
  solveTurnstile,
  waitForThroughChallenge,
} = require('../src/turnstile');

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`PASS: ${name}`),
      (e) => { failures++; console.log(`FAIL: ${name} — ${e.message}`); },
    );
}

const quietLog = () => {};
const TURNSTILE_URL = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2';

/**
 * A page whose widget is present until `clearsAfterClicks` clicks have landed.
 *
 * `via` selects which discovery path can see it, so the fallback order is actually exercised
 * instead of assumed: 'frame' publishes it through the frame graph, 'shadow' only through the
 * in-page walk, 'none' not at all.
 */
function fakePage(opts = {}) {
  const cfg = { via: 'frame', box: { x: 192, y: 306, width: 300, height: 61 }, clearsAfterClicks: 1, ...opts };
  const state = { clicks: [], moves: [], waits: [], clock: 0, evaluates: 0 };
  const present = () => cfg.via !== 'none' && state.clicks.length < cfg.clearsAfterClicks;

  const frameElement = {
    async boundingBox() { return present() ? cfg.box : null; },
    async dispose() {},
  };
  const widgetFrame = {
    url: () => TURNSTILE_URL,
    async frameElement() { return frameElement; },
  };
  const mainFrame = { url: () => 'https://auth.openai.com/', async frameElement() { return null; } };

  const page = {
    mainFrame: () => mainFrame,
    frames() {
      return cfg.via === 'frame' && present() ? [mainFrame, widgetFrame] : [mainFrame];
    },
    async evaluate() {
      state.evaluates++;
      return cfg.via === 'shadow' && present() ? cfg.box : null;
    },
    mouse: {
      async move(x, y, o) { state.moves.push({ x, y, steps: o && o.steps }); },
      async click(x, y) { state.clicks.push({ x, y }); },
    },
    async waitForTimeout(ms) { state.waits.push(ms); state.clock += ms; },
    url: () => 'https://auth.openai.com/',
  };
  return { page, state, now: () => state.clock };
}

/** A locator that reports invisible until the widget has been cleared by a click. */
function fakeLocator(pageCtx, { visibleAfterClicks = 1, alwaysVisible = false } = {}) {
  return {
    async isVisible() {
      if (alwaysVisible) return true;
      return pageCtx.state.clicks.length >= visibleAfterClicks;
    },
  };
}

(async () => {
  // ---------------------------------------------------------------- pure
  await check('isTurnstileFrameUrl matches the Cloudflare challenge host', () => {
    assert.strictEqual(isTurnstileFrameUrl(TURNSTILE_URL), true);
    assert.strictEqual(isTurnstileFrameUrl('https://sentinel.openai.com/x'), false);
    assert.strictEqual(isTurnstileFrameUrl(''), false);
    assert.strictEqual(isTurnstileFrameUrl(null), false);
  });

  await check('checkboxPointIn puts the click on the checkbox, not the widget centre', () => {
    // The captured widget: x=192 w=300 → checkbox ~30px in, vertically centred.
    const p = checkboxPointIn({ x: 192, y: 306, width: 300, height: 61 });
    assert.strictEqual(p.x, 222);
    assert.strictEqual(p.y, 336.5);
  });

  await check('checkboxPointIn clamps the inset so a narrow widget is not overshot', () => {
    const p = checkboxPointIn({ x: 0, y: 0, width: 20, height: 20 });
    assert.strictEqual(p.x, 10, 'inset must never pass the middle of the box');
  });

  await check('checkboxPointIn refuses a box that cannot be clicked', () => {
    assert.strictEqual(checkboxPointIn(null), null);
    assert.strictEqual(checkboxPointIn({ x: 0, y: 0, width: 0, height: 10 }), null);
    assert.strictEqual(checkboxPointIn({ x: -5, y: 10, width: 10, height: 10 }), null);
    assert.strictEqual(checkboxPointIn({ x: NaN, y: 1, width: 10, height: 10 }), null);
  });

  await check('humanizePoint scatters around the point, bounded by the spread', () => {
    assert.deepStrictEqual(humanizePoint({ x: 10, y: 20 }, () => 0.5, 2), { x: 10, y: 20 });
    assert.deepStrictEqual(humanizePoint({ x: 10, y: 20 }, () => 1, 2), { x: 12, y: 22 });
    assert.deepStrictEqual(humanizePoint({ x: 10, y: 20 }, () => 0, 2), { x: 8, y: 18 });
    assert.strictEqual(humanizePoint(null, () => 0.5), null);
  });

  await check('nextSolveAction stops on success and after the last attempt', () => {
    assert.strictEqual(nextSolveAction({ cleared: true, attempt: 1, attempts: 3 }), 'done');
    assert.strictEqual(nextSolveAction({ cleared: false, attempt: 1, attempts: 3 }), 'retry');
    assert.strictEqual(nextSolveAction({ cleared: false, attempt: 3, attempts: 3 }), 'fail');
  });

  // ------------------------------------------------------- widget discovery
  await check('findWidgetBox sees the widget through the frame graph', async () => {
    const ctx = fakePage({ via: 'frame' });
    const found = await findWidgetBox(ctx.page);
    assert.ok(found, 'widget should be found');
    assert.strictEqual(found.via, 'frame-graph');
    assert.strictEqual(ctx.state.evaluates, 0, 'the DOM walk must not run when the graph answers');
  });

  await check('findWidgetBox falls back to the shadow walk when no frame is published', async () => {
    const ctx = fakePage({ via: 'shadow' });
    const found = await findWidgetBox(ctx.page);
    assert.ok(found, 'widget should be found by the fallback');
    assert.strictEqual(found.via, 'shadow-walk');
  });

  await check('findWidgetBox returns null on a page with no widget', async () => {
    const ctx = fakePage({ via: 'none' });
    assert.strictEqual(await findWidgetBox(ctx.page), null);
  });

  // ------------------------------------------------------------- solve loop
  await check('solveTurnstile clicks the checkbox and reports the challenge cleared', async () => {
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 1 });
    const solved = await solveTurnstile(ctx.page, { log: quietLog, rand: () => 0.5 });
    assert.strictEqual(solved, true);
    assert.strictEqual(ctx.state.clicks.length, 1, 'exactly one click should have been needed');
    assert.deepStrictEqual(ctx.state.clicks[0], { x: 222, y: 336.5 });
    assert.ok(ctx.state.moves.length >= 1, 'the pointer must be moved before the click');
    assert.ok(ctx.state.moves[0].steps > 1, 'the move must be stepped, not teleported');
  });

  await check('solveTurnstile retries a click that did not take', async () => {
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 2 });
    const solved = await solveTurnstile(ctx.page, { log: quietLog, rand: () => 0.5, attempts: 3 });
    assert.strictEqual(solved, true);
    assert.strictEqual(ctx.state.clicks.length, 2);
  });

  await check('solveTurnstile gives up after the configured attempts', async () => {
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 99 });
    const solved = await solveTurnstile(ctx.page, { log: quietLog, rand: () => 0.5, attempts: 2 });
    assert.strictEqual(solved, false);
    assert.strictEqual(ctx.state.clicks.length, 2, 'must not keep clicking past the budget');
  });

  await check('solveTurnstile keeps the WHOLE solve inside budgetMs, not each attempt', async () => {
    // The bug this pins: settleMs is per attempt, so three attempts of it is three times the
    // wait the caller authorised — a navigation deadline blown from the inside.
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 99 });
    const solved = await solveTurnstile(ctx.page, {
      log: quietLog, rand: () => 0.5, attempts: 3, settleMs: 12000, pollMs: 1000, budgetMs: 5000,
    });
    assert.strictEqual(solved, false);
    const waited = ctx.state.waits.reduce((a, b) => a + b, 0);
    assert.ok(waited <= 5000, `waited ${waited}ms, budget was 5000ms`);
  });

  await check('solveTurnstile without budgetMs keeps its per-attempt behaviour', async () => {
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 99 });
    await solveTurnstile(ctx.page, {
      log: quietLog, rand: () => 0.5, attempts: 2, settleMs: 3000, pollMs: 1000,
    });
    const waited = ctx.state.waits.reduce((a, b) => a + b, 0);
    assert.strictEqual(waited, 6000, 'default budget is attempts × settleMs');
  });

  await check('solveTurnstile reports false on a passive interstitial it cannot click', async () => {
    const ctx = fakePage({ via: 'none' });
    const solved = await solveTurnstile(ctx.page, { log: quietLog });
    assert.strictEqual(solved, false, 'nothing to click is not a solve');
    assert.strictEqual(ctx.state.clicks.length, 0);
  });

  await check('solveTurnstile never throws when the page falls apart mid-solve', async () => {
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 99 });
    ctx.page.mouse.click = async () => { throw new Error('page navigated'); };
    ctx.page.evaluate = async () => { throw new Error('execution context destroyed'); };
    const solved = await solveTurnstile(ctx.page, { log: quietLog, attempts: 1 });
    assert.strictEqual(solved, false);
  });

  // ------------------------------------------------- the post-submit race
  await check('waitForThroughChallenge returns at once when the field is already there', async () => {
    const ctx = fakePage({ via: 'none' });
    const locator = fakeLocator(ctx, { alwaysVisible: true });
    const ok = await waitForThroughChallenge(ctx.page, locator, {
      log: quietLog, now: ctx.now, timeout: 60000,
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(ctx.state.clicks.length, 0, 'no challenge, so nothing to click');
  });

  await check('waitForThroughChallenge solves a checkbox standing in front of the field', async () => {
    // This is the 2026-07-27 outage in miniature: the field is hidden behind the widget, and
    // only a click reveals it. The old code waited 15 s and reported a timeout.
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 1 });
    const locator = fakeLocator(ctx, { visibleAfterClicks: 1 });
    const ok = await waitForThroughChallenge(ctx.page, locator, {
      log: quietLog, now: ctx.now, timeout: 60000, rand: () => 0.5,
    });
    assert.strictEqual(ok, true, 'the field must be found once the challenge is cleared');
    assert.strictEqual(ctx.state.clicks.length, 1);
  });

  await check('waitForThroughChallenge times out when the field never arrives', async () => {
    const ctx = fakePage({ via: 'none' });
    const locator = fakeLocator(ctx, { visibleAfterClicks: 99 });
    const ok = await waitForThroughChallenge(ctx.page, locator, {
      log: quietLog, now: ctx.now, timeout: 5000,
    });
    assert.strictEqual(ok, false);
  });

  await check('waitForThroughChallenge does not solve with no time left to settle', async () => {
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 99 });
    const locator = fakeLocator(ctx, { visibleAfterClicks: 99 });
    const ok = await waitForThroughChallenge(ctx.page, locator, {
      log: quietLog, now: ctx.now, timeout: 6000,
    });
    assert.strictEqual(ok, false);
    assert.strictEqual(ctx.state.clicks.length, 0, 'a solve that cannot finish must not start');
  });

  // ------------------------------------------- a failed probe is not a solve
  await check('isTurnstileFrameUrl matches the HOSTNAME, not the URL string', () => {
    // A lookalike host and a mention in the query string must both be rejected.
    assert.strictEqual(isTurnstileFrameUrl('https://challenges.cloudflare.com.evil.test/x'), false);
    assert.strictEqual(
      isTurnstileFrameUrl('https://auth.openai.com/?next=https://challenges.cloudflare.com/a'),
      false,
    );
    assert.strictEqual(isTurnstileFrameUrl('https://sub.challenges.cloudflare.com/x'), true);
    assert.strictEqual(isTurnstileFrameUrl('not a url'), false);
  });

  await check('probeWidget reports error (not absent) when the page will not answer', async () => {
    const page = {
      mainFrame: () => null,
      frames() { throw new Error('page closed'); },
      async evaluate() { throw new Error('execution context destroyed'); },
      mouse: { async move() {}, async click() {} },
      async waitForTimeout() {},
    };
    assert.strictEqual((await probeWidget(page)).state, 'error');
  });

  await check('a transient probe failure is NOT reported as a solved challenge', async () => {
    // The bug this pins: `findWidgetBox` returned null both for "no widget" and for "could not
    // look", so one detached frame during navigation made solveTurnstile claim success — and
    // the caller then skipped the re-navigation that was its actual way out.
    let calls = 0;
    const box = { x: 192, y: 306, width: 300, height: 61 };
    const frame = {
      url: () => TURNSTILE_URL,
      async frameElement() { return { async boundingBox() { return box; }, async dispose() {} }; },
    };
    const page = {
      mainFrame: () => null,
      frames() {
        calls++;
        // Present, then one transient failure, then present again — the widget never left.
        if (calls === 2) throw new Error('frame detached');
        return [frame];
      },
      async evaluate() { throw new Error('execution context destroyed'); },
      mouse: { async move() {}, async click() {} },
      async waitForTimeout() {},
    };
    const solved = await solveTurnstile(page, {
      log: quietLog, rand: () => 0.5, attempts: 1, settleMs: 3000, pollMs: 1000,
    });
    assert.strictEqual(solved, false, 'a probe that failed must never count as "widget gone"');
  });

  await check('a single absent reading is not enough — absence must be stable', async () => {
    let calls = 0;
    const box = { x: 192, y: 306, width: 300, height: 61 };
    const frame = {
      url: () => TURNSTILE_URL,
      async frameElement() { return { async boundingBox() { return box; }, async dispose() {} }; },
    };
    const page = {
      mainFrame: () => null,
      // Absent exactly once (a frame caught between navigations), then present again.
      frames() { calls++; return calls === 3 ? [] : [frame]; },
      async evaluate() { return null; },
      mouse: { async move() {}, async click() {} },
      async waitForTimeout() {},
    };
    const solved = await solveTurnstile(page, {
      log: quietLog, rand: () => 0.5, attempts: 1, settleMs: 4000, pollMs: 1000,
    });
    assert.strictEqual(solved, false, 'one flicker of absence is not a solve');
  });

  await check('budgetMs is never overshot by a partial final poll', async () => {
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 99 });
    await solveTurnstile(ctx.page, {
      log: quietLog, rand: () => 0.5, attempts: 3, settleMs: 12000, pollMs: 1000, budgetMs: 5500,
    });
    const waited = ctx.state.waits.reduce((a, b) => a + b, 0);
    assert.strictEqual(waited, 5500, 'the last sleep must be clamped to what is left');
  });

  await check('waitForAnyThroughChallenge reports WHICH target appeared', async () => {
    const ctx = fakePage({ via: 'none' });
    const email = { async isVisible() { return false; } };
    const button = { async isVisible() { return true; } };
    const hit = await waitForAnyThroughChallenge(ctx.page, [email, button], {
      log: quietLog, now: ctx.now, timeout: 60000,
    });
    assert.strictEqual(hit, 1, 'the Log in button is index 1');
  });

  await check('waitForAnyThroughChallenge solves a challenge hiding BOTH targets', async () => {
    // The hole Codex found: waiting on the Log in button alone burned the whole budget without
    // ever attempting a click when a challenge landed before it.
    const ctx = fakePage({ via: 'frame', clearsAfterClicks: 1 });
    const email = { async isVisible() { return ctx.state.clicks.length >= 1; } };
    const button = { async isVisible() { return false; } };
    const hit = await waitForAnyThroughChallenge(ctx.page, [email, button], {
      log: quietLog, now: ctx.now, timeout: 60000, rand: () => 0.5,
    });
    assert.strictEqual(hit, 0);
    assert.strictEqual(ctx.state.clicks.length, 1, 'the checkbox must have been clicked');
  });

  console.log(failures ? `\n${failures} test(s) failed` : '\nAll turnstile tests passed');
  process.exit(failures ? 1 : 0);
})();
