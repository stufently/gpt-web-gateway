// Unit tests for the Cloudflare interstitial policy (src/cloudflare.js).
//
// The behaviour under test is the one that was missing during the 2026-07-26 outage: a
// challenge must lead to a FRESH NAVIGATION after a pause, not to more waiting on the
// interstitial. The measurements behind each expectation are in src/cloudflare.js.
const assert = require('assert');
const {
  looksLikeCloudflareChallenge, titleSettled, safeHeaders, nextLoadAction, retryGapMs,
  challengeGraceExpired, worstCaseSequenceMs, effectiveGapMs,
} = require('../src/cloudflare');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL: ${name} — ${e.message}`);
  }
}

check("Cloudflare's own header is authoritative, whatever the title says", () => {
  assert.strictEqual(looksLikeCloudflareChallenge('', { 'cf-mitigated': 'challenge' }), true);
  assert.strictEqual(looksLikeCloudflareChallenge('ChatGPT', { 'cf-mitigated': 'challenge' }), true);
});

check('the interstitial title is recognised when headers are gone', () => {
  assert.strictEqual(looksLikeCloudflareChallenge('Just a moment...', null), true);
  assert.strictEqual(looksLikeCloudflareChallenge('Attention Required! | Cloudflare', null), true);
  assert.strictEqual(looksLikeCloudflareChallenge('Checking your browser', undefined), true);
});

check('a healthy page is not mistaken for a challenge', () => {
  assert.strictEqual(looksLikeCloudflareChallenge('ChatGPT: Chat, Work, Create & Code with AI', {}), false);
  assert.strictEqual(looksLikeCloudflareChallenge('', {}), false);
});

check('an empty title settles nothing — it cannot cancel a header verdict', () => {
  assert.strictEqual(titleSettled(''), false);
  assert.strictEqual(titleSettled('   '), false);
  assert.strictEqual(titleSettled(null), false);
  assert.strictEqual(titleSettled('Just a moment...'), false);
  assert.strictEqual(titleSettled('ChatGPT'), true);
});

check('safeHeaders survives a discarded response instead of throwing', () => {
  assert.deepStrictEqual(safeHeaders({ headers: () => ({ 'cf-ray': 'abc' }) }), { 'cf-ray': 'abc' });
  assert.strictEqual(safeHeaders(null), null);
  assert.strictEqual(safeHeaders(undefined), null);
  assert.strictEqual(safeHeaders({ headers: () => { throw new Error('discarded'); } }), null);
  assert.strictEqual(safeHeaders({ headers: () => null }), null);
});

check('a ready page wins even if it passed through an interstitial', () => {
  assert.strictEqual(nextLoadAction({ ready: true, blocked: true, attempt: 1, attempts: 4 }), 'ready');
});

check('a challenge with attempts left is retried — THE regression this release fixes', () => {
  assert.strictEqual(nextLoadAction({ ready: false, blocked: true, attempt: 1, attempts: 4 }), 'retry');
  assert.strictEqual(nextLoadAction({ ready: false, blocked: true, attempt: 3, attempts: 4 }), 'retry');
});

check('the last attempt fails instead of looping forever', () => {
  assert.strictEqual(nextLoadAction({ ready: false, blocked: true, attempt: 4, attempts: 4 }), 'fail');
});

check('a single-attempt budget never retries', () => {
  assert.strictEqual(nextLoadAction({ ready: false, blocked: true, attempt: 1, attempts: 1 }), 'fail');
});

check('a broken SPA is NOT retried — that failure has its own recovery path', () => {
  assert.strictEqual(nextLoadAction({ ready: false, blocked: false, attempt: 1, attempts: 4 }), 'fail');
});

check('missing arguments degrade to a failure, never to an infinite retry', () => {
  assert.strictEqual(nextLoadAction(), 'fail');
  assert.strictEqual(nextLoadAction({ blocked: true }), 'fail');
});

check('the gap grows linearly and stays inside a caller timeout', () => {
  assert.strictEqual(retryGapMs(1, 45000), 45000);
  assert.strictEqual(retryGapMs(2, 45000), 67500);
  assert.strictEqual(retryGapMs(3, 45000), 90000);
  // Three retries must not blow past a 10-minute request budget on their own.
  const total = retryGapMs(1, 45000) + retryGapMs(2, 45000) + retryGapMs(3, 45000);
  assert.ok(total < 5 * 60 * 1000, `total backoff ${total}ms is too long`);
});

check('a garbage base falls back to the default instead of hammering', () => {
  assert.strictEqual(retryGapMs(1, 0), 45000);
  assert.strictEqual(retryGapMs(1, -5), 45000);
  assert.strictEqual(retryGapMs(1, undefined), 45000);
  assert.strictEqual(retryGapMs(0, 45000), 45000);
});

check('the interstitial grace expires so the retry can happen', () => {
  assert.strictEqual(challengeGraceExpired(14999, 15000), false);
  assert.strictEqual(challengeGraceExpired(15000, 15000), true);
  assert.strictEqual(challengeGraceExpired(60000, 15000), true);
});

check('a zero grace re-navigates immediately; garbage falls back to the default', () => {
  assert.strictEqual(challengeGraceExpired(0, 0), true);
  assert.strictEqual(challengeGraceExpired(1000, undefined), false);
  assert.strictEqual(challengeGraceExpired(20000, undefined), true);
});

check('a tight budget shortens the pause instead of cancelling the retry', () => {
  // The failure this removes (Codex review, round 4): a 30s navigation plus the grace leaves
  // 44s, which does not fit the 45s gap — so the second attempt the configuration promises
  // silently never happened. Now the wait shrinks and the retry still occurs.
  assert.strictEqual(effectiveGapMs(45000, 44000, 20000), 24000);
  // Plenty of budget: the policy gap is used as-is.
  assert.strictEqual(effectiveGapMs(45000, 90000, 20000), 45000);
  // Not enough left even for the attempt itself: no retry, and no pointless wait.
  assert.strictEqual(effectiveGapMs(45000, 15000, 20000), 0);
  assert.strictEqual(effectiveGapMs(45000, 0, 20000), 0);
  assert.strictEqual(effectiveGapMs(0, 90000, 20000), 0);
});

check('the shipped defaults let EVERY configured attempt happen', () => {
  // The regression this locks down (Codex review of the first cut): 4 attempts against a
  // 240 s budget needed 262.5 s of grace + gaps, so the fourth attempt could never start —
  // a retry that reads as configured and silently never runs. Counting only the gaps hid it.
  const SHIPPED = { attempts: 2, baseGapMs: 45000, graceMs: 15000 };
  const BUDGET_MS = 90000; // CF_LOAD_BUDGET_SEC
  const worst = worstCaseSequenceMs(SHIPPED);
  assert.strictEqual(worst, 2 * 15000 + 45000);
  assert.ok(worst < BUDGET_MS, `worst case ${worst}ms does not fit the ${BUDGET_MS}ms budget`);
  // And the guard has teeth: one more attempt would NOT fit, which is why it is not shipped.
  assert.ok(worstCaseSequenceMs({ ...SHIPPED, attempts: 3 }) > BUDGET_MS);
});

check('ONE page load fits beside the answer wait — the request as a whole is NOT bounded here', () => {
  // What this asserts, precisely: a SINGLE page-load sequence (90 s) plus the answer wait
  // (CHAT_COMPLETION_TIMEOUT_SEC 360) and its extension (120) fit the ~600 s clients allow.
  //
  // What it does NOT assert, and must not be read as (Codex review, round 3): a bound on the
  // whole request. `CHATGPT_TEXT_RETRY_ATTEMPTS` can re-enter the page load up to four times
  // pre-submit, and an auto-login adds navigation budgets of its own. Bounding a request end
  // to end needs a deadline threaded through the queue, login and retries — a real change,
  // deliberately not smuggled into this release. Until then the honest claim is this one.
  const CLIENT_BUDGET_MS = 600000;
  const onePageLoadPlusAnswer = 90000 + 360000 + 120000;
  assert.ok(
    onePageLoadPlusAnswer <= CLIENT_BUDGET_MS,
    `one page load + answer wait is ${onePageLoadPlusAnswer}ms, past the client's ${CLIENT_BUDGET_MS}ms`,
  );
});

check('worstCaseSequenceMs counts the grace of every attempt, not just the gaps', () => {
  assert.strictEqual(worstCaseSequenceMs({ attempts: 1, baseGapMs: 45000, graceMs: 15000 }), 15000);
  assert.strictEqual(worstCaseSequenceMs({ attempts: 2, baseGapMs: 45000, graceMs: 15000 }), 75000);
  // Garbage in: still a usable number, never NaN — a NaN would silently disable the check.
  assert.ok(Number.isFinite(worstCaseSequenceMs()));
});

if (failures) {
  console.log(`\n${failures} cloudflare test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll cloudflare tests passed.');
