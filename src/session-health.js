// Session-health state machine — the data behind `gpt_web_gateway_session_valid`.
//
// Why this exists: the 2026-07-25 incident (third of its kind in a month) had the pod
// Running, /health and /health/live green, and the blackbox probe passing — while every
// real request failed because the ChatGPT session was dead. Nothing in the exported state
// described "is this gateway actually logged in?", so the outage was only visible to
// humans reading logs, 34 hours later.
//
// Pure and clock-injectable so it can be unit-tested without a browser:
//   recordProbe('in' | 'out' | 'unknown')  — result of a session check
//   recordSkip(reason)                     — watchdog deliberately did not probe
//   snapshot()                             — gauge values for /metrics
//
// Semantics of the gauge (documented in README, an alert is built on it):
//   1 = the last CONCLUSIVE check said "logged in"
//   0 = the last conclusive check said "logged out", OR nothing has been confirmed yet
//       (a fresh process starts at 0 and flips to 1 as soon as the first probe succeeds)
// An inconclusive probe ('unknown') never flips the gauge on its own — it only ages
// `session_check_age_seconds`, so an alert can distinguish "confirmed logged out" from
// "we have not been able to tell for a while".
//
// Flapping guard: a single negative probe does not flip the gauge to 0; it takes
// `failureThreshold` consecutive negatives (default 2). A positive probe clears the
// streak immediately.

const DEFAULT_FAILURE_THRESHOLD = 2;

function createSessionHealth({ now = Date.now, failureThreshold = DEFAULT_FAILURE_THRESHOLD } = {}) {
  const state = {
    valid: 0,                  // 0 | 1 — the exported gauge
    confirmed: false,          // has any conclusive check ever completed?
    lastConclusiveAt: null,    // ms timestamp of the last 'in'/'out' result
    lastState: 'unknown',      // 'in' | 'out' | 'unknown'
    lastReason: 'startup',
    consecutiveFailures: 0,
    probes: { in: 0, out: 0, unknown: 0 },
    skips: 0,
    startedAt: now(),
  };

  function recordProbe(result, reason = '') {
    if (result === 'in') {
      state.probes.in++;
      state.consecutiveFailures = 0;
      state.valid = 1;
      state.confirmed = true;
      state.lastConclusiveAt = now();
      state.lastState = 'in';
      state.lastReason = reason;
      return state.valid;
    }
    if (result === 'out') {
      state.probes.out++;
      state.consecutiveFailures++;
      state.confirmed = true;
      state.lastConclusiveAt = now();
      state.lastState = 'out';
      state.lastReason = reason;
      if (state.consecutiveFailures >= failureThreshold) state.valid = 0;
      return state.valid;
    }
    // 'unknown' — inconclusive. Does not move the gauge and does not count as a failure:
    // an unreachable /api/auth/session must not be reported as "logged out".
    state.probes.unknown++;
    state.lastState = 'unknown';
    state.lastReason = reason;
    return state.valid;
  }

  function recordSkip(reason = '') {
    state.skips++;
    state.lastReason = `skipped:${reason}`;
  }

  // Hard, hysteresis-free "the session is gone". Used when we KNOW it rather than infer
  // it: the moment a destructive re-login starts (clearSession wipes the cookies) and when
  // a login attempt fails. Without this the gauge could stay at 1 through a failed
  // re-login — the streak needs two negatives, and afterwards there is no page left to
  // probe, so every later watchdog tick is an 'unknown' that deliberately does not lower
  // the gauge. That is the exact "green metric, dead service" hole this release closes.
  function invalidate(reason = '') {
    state.valid = 0;
    state.confirmed = true;
    state.lastConclusiveAt = now();
    state.lastState = 'out';
    state.lastReason = reason;
    state.consecutiveFailures = Math.max(state.consecutiveFailures, failureThreshold);
    return state.valid;
  }

  // True when a conclusive positive check happened within `windowMs` — the watchdog uses
  // this to stay out of the way: real traffic that just authenticated is proof enough,
  // no extra page poking needed.
  function isFreshlyValid(windowMs) {
    return (
      state.valid === 1 &&
      state.lastState === 'in' &&
      state.lastConclusiveAt !== null &&
      now() - state.lastConclusiveAt < windowMs
    );
  }

  function snapshot() {
    const age = state.lastConclusiveAt === null ? now() - state.startedAt : now() - state.lastConclusiveAt;
    return {
      session_valid: state.valid,
      confirmed: state.confirmed,
      check_age_ms: age,
      last_state: state.lastState,
      last_reason: state.lastReason,
      consecutive_failures: state.consecutiveFailures,
      probes: { ...state.probes },
      skips: state.skips,
    };
  }

  return { recordProbe, recordSkip, invalidate, isFreshlyValid, snapshot };
}

// Throttle for auto-login attempts. Fail-closed session checks (see chatgpt.js) mean an
// unreachable /api/auth/session now triggers a re-login — without a cooldown a flaky
// endpoint (or a Cloudflare interstitial) would hammer the login form request after
// request, which is itself a documented way to earn a "too many attempts" lockout.
// Successful logins clear the cooldown instantly, so the healthy path is unaffected.
function createLoginThrottle({ now = Date.now, cooldownMs = 120000 } = {}) {
  let blockedUntil = 0;
  let lastError = null;

  return {
    // ms remaining before another attempt is allowed (0 = allowed now)
    blockedForMs() {
      return Math.max(0, blockedUntil - now());
    },
    lastError() {
      return lastError;
    },
    recordFailure(err) {
      lastError = err || null;
      blockedUntil = now() + cooldownMs;
    },
    recordSuccess() {
      lastError = null;
      blockedUntil = 0;
    },
  };
}

/**
 * What to do with a session check result on the REQUEST path. Pure, so the policy is
 * readable and testable in isolation from Playwright.
 *
 *   'proceed' — confirmed live session, serve the request
 *   'refuse'  — inconclusive: fail closed (do NOT serve) but keep the cookies. An
 *               unreachable /api/auth/session is not evidence of a logout, and the
 *               recovery path is destructive (autoLogin → clearSession), so a flapping
 *               endpoint must not be able to wipe a working session (Codex review).
 *   'reset'   — inconclusive for `escalateAt` checks in a row: rebuild the browser context
 *               from session.json (non-destructive — cookies survive) so a permanently
 *               unverifiable session does not wedge the gateway forever.
 *   'relogin' — CONFIRMED logged out. The only action that may destroy the cookies.
 *
 * Why 'unknown' never reaches 'relogin' (2026-07-29, Codex review): inconclusive is not
 * evidence of a logout. It used to escalate to autoLogin → clearSession, so a session that
 * was alive but merely unverifiable (Cloudflare challenging /api/auth/session on a stale
 * page) got its cookies wiped — and the clean re-login that followed is blocked by
 * Turnstile, turning a recoverable hiccup into a hard outage.
 */
function decideSessionAction({ state, consecutiveUnknown = 0, escalateAt = 3 }) {
  if (state === 'in') return 'proceed';
  if (state === 'out') return 'relogin';
  return consecutiveUnknown >= escalateAt ? 'reset' : 'refuse';
}

/**
 * May we spend a full browser-context rebuild right now?
 *
 * The 'reset' action stays satisfied for as long as the session is unverifiable, so without
 * a cooldown every request would tear the browser down and build it back up (Codex review).
 * `lastResetAt === 0` means "never rebuilt", which is always allowed.
 */
function shouldRebuildContext({ lastResetAt = 0, now, cooldownMs }) {
  if (!lastResetAt) return true;
  return now - lastResetAt >= cooldownMs;
}

// Auto-login failures broken down by the screen that blocked us (see login-diagnostics.js).
// Lives here rather than in metrics.js so chatgpt.js can record without a require cycle;
// metrics.js reads it when rendering /metrics. Pre-seeded with every label so the series
// always exist for alerting/Grafana.
const { LOGIN_BLOCKERS } = require('./login-diagnostics');
const loginFailures = Object.fromEntries(LOGIN_BLOCKERS.map((b) => [b, 0]));

function recordLoginFailure(blocker) {
  const key = loginFailures[blocker] === undefined ? 'unknown' : blocker;
  loginFailures[key]++;
}

// Process-wide singletons used by chatgpt.js / metrics.js / server.js.
const sessionHealth = createSessionHealth();

module.exports = {
  sessionHealth,
  createSessionHealth,
  createLoginThrottle,
  decideSessionAction,
  shouldRebuildContext,
  recordLoginFailure,
  loginFailures,
  DEFAULT_FAILURE_THRESHOLD,
};
