// Fake-clock tests for src/session-health.js — the state behind
// gpt_web_gateway_session_valid and the auto-login cooldown.
const assert = require('assert');
const {
  createSessionHealth, createLoginThrottle, decideSessionAction, shouldRebuildContext,
} = require('../src/session-health');

let passed = 0;
function ok(name, fn) { fn(); console.log(`PASS: ${name}`); passed++; }

function fakeClock(startMs = 0) {
  let t = startMs;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

ok('fresh process reports session_valid=0 until something is confirmed', () => {
  const h = createSessionHealth({ now: fakeClock() });
  const s = h.snapshot();
  assert.strictEqual(s.session_valid, 0);
  assert.strictEqual(s.confirmed, false);
});

ok('a confirmed login flips the gauge to 1', () => {
  const h = createSessionHealth({ now: fakeClock() });
  h.recordProbe('in', 'startup');
  assert.strictEqual(h.snapshot().session_valid, 1);
  assert.strictEqual(h.snapshot().confirmed, true);
});

ok('one negative probe does not flip the gauge; two do', () => {
  const h = createSessionHealth({ now: fakeClock(), failureThreshold: 2 });
  h.recordProbe('in');
  h.recordProbe('out');
  assert.strictEqual(h.snapshot().session_valid, 1, 'single negative must not flap the alert');
  h.recordProbe('out');
  assert.strictEqual(h.snapshot().session_valid, 0);
});

ok('a positive probe clears the failure streak', () => {
  const h = createSessionHealth({ now: fakeClock(), failureThreshold: 2 });
  h.recordProbe('in');
  h.recordProbe('out');
  h.recordProbe('in');
  h.recordProbe('out');
  assert.strictEqual(h.snapshot().session_valid, 1);
  assert.strictEqual(h.snapshot().consecutive_failures, 1);
});

ok('inconclusive probes never flip the gauge, only age the check', () => {
  const clock = fakeClock();
  const h = createSessionHealth({ now: clock });
  h.recordProbe('in');
  clock.advance(60_000);
  h.recordProbe('unknown', 'no_page');
  h.recordProbe('unknown', 'no_page');
  h.recordProbe('unknown', 'no_page');
  const s = h.snapshot();
  assert.strictEqual(s.session_valid, 1, 'unreachable endpoint is not proof of a logout');
  assert.strictEqual(s.check_age_ms, 60_000, 'age must count from the last CONCLUSIVE check');
  assert.strictEqual(s.probes.unknown, 3);
});

ok('isFreshlyValid lets the watchdog skip when traffic just proved the session', () => {
  const clock = fakeClock();
  const h = createSessionHealth({ now: clock });
  h.recordProbe('in', 'request');
  assert.strictEqual(h.isFreshlyValid(300_000), true);
  clock.advance(301_000);
  assert.strictEqual(h.isFreshlyValid(300_000), false);
});

ok('isFreshlyValid is false once the session went out', () => {
  const h = createSessionHealth({ now: fakeClock(), failureThreshold: 1 });
  h.recordProbe('out');
  assert.strictEqual(h.isFreshlyValid(300_000), false);
});

ok('invalidate() drops the gauge immediately, bypassing the hysteresis', () => {
  // The failed-relogin hole: one 'out' is recorded, then the page is gone and every later
  // watchdog tick is an 'unknown' that never lowers the gauge — so it would sit at 1 while
  // the service is dead. A known-destructive event must be able to say so outright.
  const h = createSessionHealth({ now: fakeClock(), failureThreshold: 2 });
  h.recordProbe('in');
  h.invalidate('relogin:out');
  assert.strictEqual(h.snapshot().session_valid, 0);
  h.recordProbe('unknown', 'no_page');
  h.recordProbe('unknown', 'no_page');
  assert.strictEqual(h.snapshot().session_valid, 0, 'later unknowns must not resurrect the gauge');
  h.recordProbe('in', 'post_login');
  assert.strictEqual(h.snapshot().session_valid, 1, 'a real login must clear it');
});

ok('decideSessionAction: confirmed states are unambiguous', () => {
  assert.strictEqual(decideSessionAction({ state: 'in' }), 'proceed');
  assert.strictEqual(decideSessionAction({ state: 'out' }), 'relogin');
});

ok('decideSessionAction: inconclusive refuses first, escalates only after N in a row', () => {
  // Re-login is destructive (clearSession) — a flapping /api/auth/session must not be
  // able to wipe a working session on the first hiccup.
  assert.strictEqual(decideSessionAction({ state: 'unknown', consecutiveUnknown: 1, escalateAt: 3 }), 'refuse');
  assert.strictEqual(decideSessionAction({ state: 'unknown', consecutiveUnknown: 2, escalateAt: 3 }), 'refuse');
});

ok('decideSessionAction: an unverifiable session resets the browser, it never re-logs-in', () => {
  // 'unknown' is by definition NOT evidence of a logout, so it must never reach the
  // destructive path: autoLogin → clearSession wipes cookies, and a clean re-login is
  // blocked by Turnstile — so escalating on inconclusiveness turned a live-but-unverifiable
  // session into a hard outage (2026-07-29, Codex review). A non-destructive context
  // rebuild from session.json is the strongest action inconclusiveness may justify.
  assert.strictEqual(decideSessionAction({ state: 'unknown', consecutiveUnknown: 3, escalateAt: 3 }), 'reset');
  assert.strictEqual(decideSessionAction({ state: 'unknown', consecutiveUnknown: 9, escalateAt: 3 }), 'reset');
  // A CONFIRMED logout is still the one thing that justifies destroying the cookies.
  assert.strictEqual(decideSessionAction({ state: 'out', consecutiveUnknown: 0 }), 'relogin');
});

ok('shouldRebuildContext: the first rebuild is free, repeats wait out the cooldown', () => {
  // A session that stays unverifiable keeps satisfying the 'reset' action, so without this
  // gate every request would rebuild the whole browser — a spin loop (Codex review).
  assert.strictEqual(shouldRebuildContext({ lastResetAt: 0, now: 1_000, cooldownMs: 60_000 }), true);
  assert.strictEqual(shouldRebuildContext({ lastResetAt: 1_000, now: 2_000, cooldownMs: 60_000 }), false);
  assert.strictEqual(shouldRebuildContext({ lastResetAt: 1_000, now: 60_000, cooldownMs: 60_000 }), false);
  assert.strictEqual(shouldRebuildContext({ lastResetAt: 1_000, now: 61_000, cooldownMs: 60_000 }), true);
  assert.strictEqual(shouldRebuildContext({ lastResetAt: 1_000, now: 999_000, cooldownMs: 60_000 }), true);
});

ok('login throttle blocks re-attempts for the cooldown and clears on success', () => {
  const clock = fakeClock();
  const t = createLoginThrottle({ now: clock, cooldownMs: 120_000 });
  assert.strictEqual(t.blockedForMs(), 0);
  const err = new Error('blocked at step "password-field" by cloudflare_challenge');
  err.loginBlocker = 'cloudflare_challenge';
  t.recordFailure(err);
  assert.strictEqual(t.blockedForMs(), 120_000);
  assert.strictEqual(t.lastError().loginBlocker, 'cloudflare_challenge');
  clock.advance(119_000);
  assert.strictEqual(t.blockedForMs(), 1_000);
  clock.advance(2_000);
  assert.strictEqual(t.blockedForMs(), 0, 'cooldown expires');
  t.recordFailure(err);
  t.recordSuccess();
  assert.strictEqual(t.blockedForMs(), 0, 'a successful login clears the cooldown immediately');
  assert.strictEqual(t.lastError(), null);
});

console.log(`\nAll ${passed} session-health tests passed.`);
