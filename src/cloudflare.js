// Cloudflare interstitial policy — the pure half of the page-load path.
//
// Measured 2026-07-26 (see docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md and its
// correction section), against the chatgpt.com zone from three different egress addresses:
//
//   * The verdict is decided PER NAVIGATION, not per address. The same IP that is answered
//     `403 cf-mitigated: challenge` on one `goto` is answered `200` on the next one about a
//     minute later — including the production pod's own address, which had been written off
//     as permanently distrusted.
//   * Once a navigation gets through, the access HOLDS: three immediate follow-up navigations
//     in the same context were all served 200.
//   * Sitting on the interstitial does not help. The challenge page does not solve itself for
//     this browser — the previous code waited on it for ~2 minutes, 60 × 2 s, and then gave
//     up without ever re-navigating. A fresh navigation is what clears it.
//
// So the correct response to a challenge is: stop waiting early, navigate again after a pause,
// and only report a hard failure once the retries are spent.
//
// Everything here is pure (no Playwright, no timers) so the policy is unit-testable.

/** Cloudflare's own verdict header is authoritative; the page title is the fallback. */
function looksLikeCloudflareChallenge(title, headers) {
  const mitigated = headers && (headers['cf-mitigated'] || headers['CF-Mitigated']);
  if (mitigated) return true;
  return /just a moment|attention required|checking your browser/i.test(String(title || ''));
}

/**
 * What to do after one navigation attempt has settled.
 *
 * `ready` wins over everything: a page that reached the composer or the auth surface is
 * usable even if it passed through an interstitial on the way.
 *
 * A retry is offered ONLY for a Cloudflare challenge. A blank/broken SPA is a different
 * failure with its own recovery (`recoverContentFailed`), and re-navigating it just burns
 * the caller's time budget.
 *
 * @returns {'ready'|'retry'|'fail'}
 */
function nextLoadAction({ ready, blocked, attempt, attempts } = {}) {
  if (ready) return 'ready';
  if (!blocked) return 'fail';
  return attempt < attempts ? 'retry' : 'fail';
}

/**
 * How long to wait before the next navigation.
 *
 * Linear, not exponential: the measured recovery window is roughly a minute, and an
 * exponential curve would blow past a caller's timeout on attempt three while adding nothing.
 * The first gap is the base value, then +50% per attempt (45 s → 67 s → 90 s by default).
 */
function retryGapMs(attempt, baseMs) {
  const base = Number(baseMs) > 0 ? Number(baseMs) : 45000;
  const n = Number(attempt) > 0 ? Number(attempt) : 1;
  return Math.round(base * (1 + (n - 1) * 0.5));
}

/**
 * Should we stop waiting on the interstitial and re-navigate?
 *
 * A short grace remains because a challenge that IS going to clear itself does so in seconds;
 * beyond that, waiting is the behaviour that produced a 34-hour outage.
 */
function challengeGraceExpired(elapsedMs, graceMs) {
  const grace = Number(graceMs) >= 0 ? Number(graceMs) : 15000;
  return Number(elapsedMs) >= grace;
}

/**
 * Has the page settled on a REAL document?
 *
 * "Not challenged any more" is not the same as "cleared": right after `domcontentloaded` the
 * title is often empty, and an empty title must not be allowed to cancel a verdict the
 * response headers already gave us. Only a present, non-interstitial title counts.
 */
function titleSettled(pageTitle) {
  const t = String(pageTitle || '').trim();
  return t !== '' && !looksLikeCloudflareChallenge(t, null);
}

/** Response headers, or null — Playwright's `headers()` throws on a discarded response. */
function safeHeaders(response) {
  try {
    return response ? response.headers() || null : null;
  } catch {
    return null;
  }
}

/**
 * Worst-case wall clock for a full challenge sequence: every attempt spends its grace on the
 * interstitial, and every gap between attempts is waited out.
 *
 * Exists to keep the defaults honest. A budget that cannot fit the configured number of
 * attempts silently turns the last ones into dead code — which is exactly what a first cut of
 * this release did (4 attempts, 240 s budget, 262 s of work; Codex review caught it). The
 * navigations themselves are not included: they are bounded separately by the per-goto timeout.
 */
function worstCaseSequenceMs({ attempts, baseGapMs, graceMs } = {}) {
  const n = Number(attempts) > 0 ? Number(attempts) : 1;
  const grace = Number(graceMs) >= 0 ? Number(graceMs) : 15000;
  let total = n * grace;
  for (let attempt = 1; attempt < n; attempt++) total += retryGapMs(attempt, baseGapMs);
  return total;
}

/**
 * The gap actually taken before the next attempt: the policy gap, shrunk to whatever the
 * budget can still afford.
 *
 * Without the shrink, a slow first navigation silently costs the retry entirely — 30 s of
 * `goto` plus the grace leaves 44 s, which does not fit a 45 s gap, so the second attempt the
 * configuration promises never happens (Codex review, round 4). A shorter wait is a far better
 * answer than no second navigation: the whole point is to ask again.
 *
 * @returns {number} milliseconds to wait, or 0 when no retry can fit at all.
 */
function effectiveGapMs(gapMs, remainingMs, attemptReserveMs) {
  const gap = Number(gapMs) > 0 ? Number(gapMs) : 0;
  const remaining = Number(remainingMs) > 0 ? Number(remainingMs) : 0;
  const reserve = Number(attemptReserveMs) > 0 ? Number(attemptReserveMs) : 0;
  const affordable = remaining - reserve;
  if (affordable <= 0) return 0;
  return Math.min(gap, affordable);
}

module.exports = {
  looksLikeCloudflareChallenge,
  titleSettled,
  safeHeaders,
  effectiveGapMs,
  nextLoadAction,
  retryGapMs,
  challengeGraceExpired,
  worstCaseSequenceMs,
};
