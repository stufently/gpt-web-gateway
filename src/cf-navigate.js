// `goto` that survives a Cloudflare challenge by navigating again.
//
// Same measured basis as src/cloudflare.js: the challenge verdict is decided per navigation,
// so a fresh `goto` after a pause is what clears it. This module is the reusable form for
// plain navigations — the ChatGPT app shell has its own richer settle loop in chatgpt.js,
// because "ready" there means a composer or an auth surface, not merely "not challenged".
//
// The page is passed in and only four of its methods are used (`goto`, `title`,
// `waitForTimeout`, `url`), so the whole retry sequence is testable against a fake page —
// see scripts/test-cf-navigate.js. `now` is injectable for the same reason.
const {
  looksLikeCloudflareChallenge, titleSettled, safeHeaders, retryGapMs, effectiveGapMs,
  challengeGraceExpired,
} = require('./cloudflare');
const { solveTurnstile } = require('./turnstile');

const DEFAULTS = {
  attempts: 2,
  baseGapMs: 45000,
  graceMs: 15000,
  budgetMs: 90000,
  timeout: 30000,
  pollMs: 2000,
  solveMs: 20000,
};

// Below this there is no point starting (or continuing) a navigation — it would only produce
// an instant, meaningless timeout.
const MIN_ATTEMPT_MS = 5000;
// What the next attempt needs reserved before the gap may consume the rest of the budget.
const RETRY_ATTEMPT_RESERVE_MS = 20000;
// A solve needs room to click and then watch the widget for a few seconds. Below this the
// attempt would be cut off mid-settle and report a false negative, so we skip it and let the
// caller fall through to the retry it already has.
const MIN_SOLVE_MS = 8000;

/**
 * Navigate to `url`, retrying while Cloudflare challenges us.
 *
 * Never throws on a challenge — it returns `{ blocked: true }` and lets the caller decide.
 * A `goto` that throws (navigation timeout, closed page) propagates: that is a different
 * failure, and swallowing it here would hide it from the caller's own error handling.
 *
 * `attempts` is what really happened, not what was configured — a caller that logs it (or a
 * test that asserts on it) must not be told about navigations that a spent budget prevented.
 *
 * @returns {Promise<{response: any, attempts: number, blocked: boolean}>}
 */
async function gotoWithChallengeRetry(page, url, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = cfg.now || Date.now;
  const log = cfg.log || console.log;
  const label = cfg.label || 'goto';
  const started = now();
  const deadline = started + cfg.budgetMs;
  const remaining = () => deadline - now();
  let response = null;
  let made = 0;

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    if (attempt > 1 && remaining() <= MIN_ATTEMPT_MS) break;
    // The navigation itself counts against the budget, so its timeout is what is left of it.
    const timeout = Math.min(cfg.timeout, Math.max(MIN_ATTEMPT_MS, remaining()));
    made = attempt;
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const headers = safeHeaders(response);

    // A challenge that clears on its own does so in seconds — give it that, then stop.
    //
    // Clearing is judged by the title becoming a real one, NOT merely by "no longer looks like
    // a challenge": right after `domcontentloaded` the title is often empty, and an empty
    // title would otherwise cancel a verdict the response headers already gave us. (Caught by
    // scripts/test-cf-navigate.js, which is the point of testing the loop and not just the
    // predicate.) The headers themselves are only consulted once, for this navigation — the
    // interstitial hands over to the real document in place, without a new response.
    let blocked = looksLikeCloudflareChallenge(await title(page), headers);
    if (blocked) {
      const graceStart = now();
      // The grace shares the same deadline: waiting one out with no time left to re-navigate
      // is the failure this module exists to remove, in miniature.
      while (!challengeGraceExpired(now() - graceStart, cfg.graceMs) && remaining() > 0) {
        await page.waitForTimeout(cfg.pollMs);
        if (titleSettled(await title(page))) {
          blocked = false;
          break;
        }
      }

      // The grace, and the re-navigation that follows it, only ever help the PASSIVE
      // interstitial. Still being here means the page may be the interactive checkbox variant
      // instead — the one that stopped this login for good on 2026-07-27 — and no amount of
      // waiting or re-navigating clears that: a new `goto` just draws a new unticked box.
      // Clicking it is the only move, so it goes BEFORE the retry rather than after it.
      const solveBudget = Math.min(cfg.solveMs, remaining() - MIN_ATTEMPT_MS);
      if (blocked && cfg.solve !== false && solveBudget >= MIN_SOLVE_MS) {
        const solve = cfg.solveTurnstile || solveTurnstile;
        const solved = await solve(page, {
          log,
          label,
          // The WHOLE solve has to fit here, not each of its attempts — this budget is carved
          // out of the caller's navigation deadline.
          budgetMs: solveBudget,
        });
        if (solved) blocked = false;
      }
    }
    if (!blocked) return { response, attempts: made, blocked: false };

    // Shrink the pause to what the budget can still afford rather than dropping the retry.
    const gap = effectiveGapMs(retryGapMs(attempt, cfg.baseGapMs), remaining(), RETRY_ATTEMPT_RESERVE_MS);
    if (attempt >= cfg.attempts || !gap) break;
    log(
      `[${label}][cloudflare] challenged on attempt ${attempt}/${cfg.attempts} — ` +
        `re-navigating in ${Math.round(gap / 1000)}s`,
    );
    await page.waitForTimeout(gap);
  }
  return { response, attempts: made, blocked: true };
}

/** A page whose title() rejects is not a reason to abandon the retry. */
async function title(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

module.exports = { gotoWithChallengeRetry, DEFAULTS };
