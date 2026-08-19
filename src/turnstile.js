// Clicking the INTERACTIVE Cloudflare Turnstile checkbox.
//
// The premise 2.6.1 shipped on — "a challenge is cleared by navigating again" — is true only
// for the passive interstitial. The 2026-07-27 login outage was a different screen. The
// diagnostic capture taken at the moment of failure (auth.openai.com,
// docs/2026-07-27-turnstile-checkbox.md) shows the widget rendered with a
// "Verify you are human" CHECKBOX. Cloudflare no longer ticks that box automatically for a
// trusted fingerprint — it wants the pointer event itself, so it can sample how the click
// arrives.
//
// A checkbox challenge cannot be cleared by re-navigating: every fresh navigation just
// renders a fresh, unticked checkbox. That is why 2.6.1's retry loop could never recover this
// login, and why three consecutive fixes aimed at navigation timing changed nothing. The
// missing behaviour was never a shorter wait or another `goto` — it was the click.
//
// Locating the checkbox is the part that misled the previous diagnosis. Turnstile renders
// inside a cross-origin iframe which itself sits under a shadow root, so
// `document.querySelectorAll('iframe')` — what login-diagnostics.js used — returns `[]` on a
// page that visibly has the widget, and the failure was filed as "no iframes, form must have
// changed". Playwright's frame graph is built from CDP target information rather than DOM
// queries, so it sees that frame straight through the shadow boundary. That is the primary
// strategy below; the DOM walks exist for the day Cloudflare renames something.
//
// Everything above `solveTurnstile` is pure so the geometry and the retry policy are
// unit-testable without a browser (scripts/test-turnstile.js), matching how src/cloudflare.js
// splits from src/cf-navigate.js.

// Cloudflare serves the widget from this host in every variant seen so far (the managed
// interstitial and the site-embedded widget alike).
const TURNSTILE_HOST_RE = /(^|\.)challenges\.cloudflare\.com$/i;

// Selectors for the widget's container in the parent document, used only when the frame graph
// comes up empty. `cf-chl-widget-*` is the id Cloudflare gives the iframe itself; the others
// are the wrappers the managed challenge page draws around it.
const WIDGET_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  '[id^="cf-chl-widget"]',
  '.cf-turnstile',
  '#challenge-stage',
  '#turnstile-wrapper',
].join(', ');

// How far in from the widget's left edge the checkbox sits. Measured off the failing capture:
// the widget box starts at x=192 and the checkbox centre is at x=213, so ~21 px; 30 px is the
// value the widget keeps across its light and dark layouts and is what the community
// implementations use. Always clamped into the box, so a narrower widget cannot push the
// click past its own middle and onto the label text.
const CHECKBOX_INSET_PX = 30;

// How many consecutive "no widget" readings count as solved. One is not enough: a frame caught
// between navigations reads as absent for a moment, and claiming the solve on that single
// reading is how a transient detach becomes a false success.
const ABSENT_CONFIRMATIONS = 2;

/**
 * Is this frame the Turnstile widget?
 *
 * Matched on the parsed hostname rather than anywhere in the URL string: a path or query that
 * merely mentions the host (`?return=https://challenges.cloudflare.com/…`), or a lookalike
 * like `challenges.cloudflare.com.example.test`, must not be mistaken for the widget.
 */
function isTurnstileFrameUrl(url) {
  try {
    return TURNSTILE_HOST_RE.test(new URL(String(url || '')).hostname);
  } catch {
    return false;
  }
}

/**
 * Where to click, given the widget's bounding box.
 *
 * The checkbox is at the left of the widget, vertically centred. Returns null for a box that
 * cannot be clicked — a zero-sized or off-screen box means the widget is still rendering, and
 * clicking (0,0) would land on the page behind it.
 */
function checkboxPointIn(box, inset = CHECKBOX_INSET_PX) {
  if (!box) return null;
  const { x, y, width, height } = box;
  if (!(width > 0) || !(height > 0)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0) return null;
  return { x: x + Math.min(inset, width / 2), y: y + height / 2 };
}

/**
 * Scatter the click a little inside the checkbox.
 *
 * Cloudflare scores the pointer, and the same exact coordinate on every attempt is itself a
 * signal. `rand` is injected so the test can assert the spread deterministically.
 */
function humanizePoint(point, rand = Math.random, spread = 2) {
  if (!point) return null;
  return {
    x: point.x + (rand() - 0.5) * 2 * spread,
    y: point.y + (rand() - 0.5) * 2 * spread,
  };
}

/**
 * What to do after one click attempt has been judged.
 *
 * @returns {'done'|'retry'|'fail'}
 */
function nextSolveAction({ cleared, attempt, attempts } = {}) {
  if (cleared) return 'done';
  return Number(attempt) < Number(attempts) ? 'retry' : 'fail';
}

/**
 * Never let a probe of a navigating page turn into a thrown error.
 *
 * Takes a THUNK, not a promise: `quiet(page.evaluate(...))` would evaluate the call before the
 * try block ever runs, so a synchronous throw — a closed page, a detached frame, a page object
 * that simply does not implement the method — escapes past the guard. That is not theoretical;
 * it is what the first cut of this module did, and it broke every caller that passed a page
 * mid-navigation.
 */
async function quiet(thunk, fallback = null) {
  try {
    return await thunk();
  } catch {
    return fallback;
  }
}

// A probe of a hung renderer never rejects — it simply never settles, and `quiet` cannot catch
// a promise that does not resolve. Without a Node-side race the solve loop would stall past
// every budget it has. Same technique the diagnostics collector already uses.
const PROBE_TIMEOUT_MS = 5000;

async function withTimeout(thunk, ms, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(thunk),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Is the widget on the page right now?
 *
 * Three states, not two, and the distinction is load-bearing. A probe that FAILS — a frame
 * detached mid-navigation, an execution context destroyed, a renderer that stopped answering —
 * looks exactly like "no widget" if you only have a box-or-null answer. Treating that as
 * "cleared" makes `solveTurnstile` report success for a challenge it never touched, and the
 * caller then skips the re-navigation that was its actual way out. Reported by review, and
 * reproducible with a transient frame loss.
 *
 * @returns {Promise<{state: 'present'|'absent'|'error', box?: object, via?: string}>}
 */
async function probeWidget(page) {
  let errored = false;
  const track = async (thunk, fallback = null) => {
    try {
      return await withTimeout(thunk, PROBE_TIMEOUT_MS, Symbol.for('probe.timeout'));
    } catch {
      errored = true;
      return fallback;
    }
  };
  const unwrap = (v, fallback = null) => {
    if (v === Symbol.for('probe.timeout')) { errored = true; return fallback; }
    return v;
  };

  const frames = unwrap(await track(() => (typeof page.frames === 'function' ? page.frames() : [])), []) || [];
  for (const frame of frames) {
    let url = '';
    try {
      url = typeof frame.url === 'function' ? frame.url() : '';
    } catch {
      errored = true;
      continue;
    }
    if (!isTurnstileFrameUrl(url)) continue;
    const element = unwrap(await track(() => frame.frameElement()));
    if (!element) continue;
    const box = unwrap(await track(() => element.boundingBox()));
    await quiet(() => element.dispose && element.dispose());
    if (box && box.width > 0 && box.height > 0) return { state: 'present', box, via: 'frame-graph' };
  }

  const box = unwrap(await track(() => page.evaluate(WIDGET_WALK, WIDGET_SELECTORS)));
  if (box && box.width > 0 && box.height > 0) return { state: 'present', box, via: 'shadow-walk' };
  return { state: errored ? 'error' : 'absent' };
}

// The in-page walk, hoisted so both the probe and its documentation have one home.
const WIDGET_WALK = (selectors) => {
  // Only OPEN shadow roots are walkable; a closed one is exactly the case the frame graph
  // already covers, so this fallback does not need to defeat it.
  const seen = new Set();
  const walk = (root, depth) => {
    if (!root || depth > 12 || seen.has(root)) return null;
    seen.add(root);
    const direct = root.querySelector ? root.querySelector(selectors) : null;
    if (direct) return direct;
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.shadowRoot) {
        const found = walk(el.shadowRoot, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  const el = walk(document, 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

/**
 * Find the widget's bounding box in page coordinates.
 *
 * Strategy 1 — the frame graph. Works through the shadow root, which is the whole point.
 * Strategy 2 — a shadow-piercing walk of the parent document, for a widget whose frame has
 *              not registered yet (or is same-origin, where no separate frame exists).
 *
 * Returns null when the widget is not on the page at all, which is the normal answer for a
 * passive interstitial and must NOT be treated as an error.
 */
async function findWidgetBox(page) {
  const r = await probeWidget(page);
  return r.state === 'present' ? { box: r.box, via: r.via } : null;
}

/**
 * Click the Turnstile checkbox until the widget goes away.
 *
 * Contract: this NEVER throws and NEVER navigates. It returns `true` only when the widget is
 * confirmed gone. A `false` leaves the caller exactly where it was, free to fall back to the
 * re-navigation path that handles the passive interstitial — the two are complementary, not
 * alternatives, because a page can serve either one.
 *
 * @returns {Promise<boolean>} whether the challenge cleared
 */
async function solveTurnstile(page, opts = {}) {
  const cfg = {
    attempts: 3,
    settleMs: 12000,
    pollMs: 1000,
    moveSteps: 14,
    clickDelayMs: 60,
    rand: Math.random,
    log: console.log,
    label: 'turnstile',
    ...opts,
  };
  const log = cfg.log;
  // `settleMs` is PER ATTEMPT, so it is not a ceiling on the call: three attempts of it is
  // three times the wait a caller thought it was authorising, which is exactly how a
  // navigation budget gets blown from the inside. `budgetMs` bounds the whole thing. Its
  // default reproduces the per-attempt behaviour, so a standalone call is unchanged; callers
  // working inside a deadline pass their own remaining time instead.
  const budgetMs = Number(cfg.budgetMs) > 0 ? Number(cfg.budgetMs) : cfg.attempts * cfg.settleMs;
  let spent = 0;

  // A sleep may never take the budget past its end — the last poll of a budget that is not a
  // whole number of polls used to overshoot by up to one full interval.
  const nap = async () => {
    const ms = Math.min(cfg.pollMs, budgetMs - spent);
    if (ms <= 0) return false;
    await quiet(() => page.waitForTimeout(ms));
    spent += ms;
    return true;
  };

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    if (spent >= budgetMs) {
      log(`[${cfg.label}] solve budget spent after ${attempt - 1} attempt(s)`);
      break;
    }
    const probe = await probeWidget(page);
    if (probe.state === 'absent') {
      // Nothing to click. On attempt 1 this means the interstitial is the passive kind; on a
      // later attempt it means the previous click worked.
      return attempt > 1;
    }
    if (probe.state === 'error') {
      // The page did not answer. That is NOT "the challenge is gone" — reporting success here
      // makes the caller skip the re-navigation that is its real way out.
      log(`[${cfg.label}] could not probe the page for the widget — not claiming a solve`);
      if (!await nap()) break;
      continue;
    }
    const point = humanizePoint(checkboxPointIn(probe.box), cfg.rand);
    if (!point) {
      log(`[${cfg.label}] widget found via ${probe.via} but its box is not clickable yet`);
      if (!await nap()) break;
      continue;
    }
    const found = probe;

    log(
      `[${cfg.label}] checkbox challenge — clicking at ` +
        `(${Math.round(point.x)}, ${Math.round(point.y)}) via ${found.via}, ` +
        `attempt ${attempt}/${cfg.attempts}`,
    );
    // Move first, then click: Cloudflare samples the pointer's approach, and a click with no
    // preceding movement is the cheapest bot signal there is.
    await quiet(() => page.mouse.move(point.x, point.y, { steps: cfg.moveSteps }));
    await quiet(() => page.mouse.click(point.x, point.y, { delay: cfg.clickDelayMs }));

    // This attempt may only settle for as long as the shared budget can still afford.
    const settle = Math.min(cfg.settleMs, budgetMs - spent);
    let waited = 0;
    // A solve is claimed only on a STABLE absence. One reading can be a frame that is merely
    // between navigations, and a single-probe success is how a transient detach turns into a
    // false "cleared".
    let absentStreak = 0;
    while (waited < settle) {
      const before = spent;
      if (!await nap()) break;
      waited += spent - before;
      const state = (await probeWidget(page)).state;
      absentStreak = state === 'absent' ? absentStreak + 1 : 0;
      if (absentStreak >= ABSENT_CONFIRMATIONS) {
        log(`[${cfg.label}] challenge cleared after ${Math.round(waited / 1000)}s`);
        return true;
      }
    }
    log(`[${cfg.label}] still challenged ${Math.round(settle / 1000)}s after the click`);
  }
  return false;
}

/**
 * Wait for `locator` to become visible, clearing a Turnstile checkbox that appears while we
 * wait.
 *
 * THIS is where the 2026-07-27 outage actually needed the click, and getting that wrong is
 * easy: the challenge does not appear on a `goto`, so wrapping navigation does nothing for it.
 * It appears on the redirect that FOLLOWS the email submit — at which point the login was
 * simply waiting 15 s for a password field that a checkbox was standing in front of, then
 * reporting the timeout. Racing "field appears" against "challenge appears" is the fix, and
 * the wait has to be long enough for a solve to finish inside it.
 *
 * Returns true when the field showed up. A false is a plain timeout — the caller raises its
 * own diagnosed error, exactly as before.
 */
async function waitForAnyThroughChallenge(page, locators, opts = {}) {
  const cfg = {
    timeout: 60000,
    pollMs: 1000,
    label: 'auth',
    log: console.log,
    solve: solveTurnstile,
    now: Date.now,
    ...opts,
  };
  const list = Array.isArray(locators) ? locators : [locators];
  const deadline = cfg.now() + cfg.timeout;
  const remaining = () => deadline - cfg.now();
  let solveAttempted = false;

  const firstVisible = async () => {
    for (let i = 0; i < list.length; i++) {
      if (await quiet(() => list[i].isVisible(), false)) return i;
    }
    return -1;
  };

  while (remaining() > 0) {
    const hit = await firstVisible();
    if (hit >= 0) return hit;

    // Only look for the widget when nothing we want is on screen. Checking the other way round
    // would spend a solve on a page that has already moved on.
    const widget = await findWidgetBox(page);
    if (widget && remaining() > 10000) {
      solveAttempted = true;
      cfg.log(`[${cfg.label}] challenge is standing in front of the form — solving it`);
      await cfg.solve(page, {
        log: cfg.log,
        label: cfg.label,
        // Bounded by what is left of the wait, minus a slice to re-check afterwards — a solve
        // that consumes the entire budget proves nothing.
        budgetMs: Math.min(20000, Math.max(0, remaining() - 5000)),
      });
      // Fall through rather than returning: a cleared widget is not by itself a visible field.
      const after = await firstVisible();
      if (after >= 0) return after;
    }
    await quiet(() => page.waitForTimeout(cfg.pollMs));
  }

  const last = await firstVisible();
  if (last < 0 && solveAttempted) {
    cfg.log(`[${cfg.label}] nothing appeared, and the challenge did not clear`);
  }
  return last;
}

/** The single-target form: true when the locator became visible. */
async function waitForThroughChallenge(page, locator, opts = {}) {
  return (await waitForAnyThroughChallenge(page, [locator], opts)) === 0;
}

module.exports = {
  isTurnstileFrameUrl,
  checkboxPointIn,
  humanizePoint,
  nextSolveAction,
  findWidgetBox,
  probeWidget,
  solveTurnstile,
  waitForThroughChallenge,
  waitForAnyThroughChallenge,
  CHECKBOX_INSET_PX,
  WIDGET_SELECTORS,
};
