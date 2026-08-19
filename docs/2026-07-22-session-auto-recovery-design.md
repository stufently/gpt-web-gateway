# Session auto-recovery — permanent fix (2026-07-22)

## Incident

`GptWebGatewayHighErrorRate` critical fired. The ChatGPT session had been logged out for
27h+; every `/v1/chat/completions` failed and no auto-login ever ran. Manual `rollout
restart` alone did **not** fix it.

## Root cause

1. The ChatGPT session token expired (`session.json` kept only Cloudflare cookies, no
   `__Secure-next-auth.session-token`).
2. **`isLoggedIn()` false-positived on the logged-out page.** ChatGPT now renders the
   composer/`textarea` even when logged out (alongside "Log in" / "Sign up" buttons). The
   login-CTA check in `isLoggedIn` races the button render and misses; the `textarea:visible`
   check then returns `true`.
3. Because `isLoggedIn` returned `true`, `ensureLoggedIn()` skipped `autoLogin()` on *every*
   request — the session stayed dead indefinitely, surviving restarts.
4. `autoLogin()` itself is healthy: forcing `node src/auto-login.js` in the pod passed
   Cloudflare + TOTP and restored the session (CF cookies are preserved by `clearSession`).

So the true root cause is the **incorrect `isLoggedIn`**, which killed the auto-relogin path.
Low traffic only affected how the alert was computed, not the recovery.

## Fix (core 1+2+3)

### 1. `isLoggedIn()` — authoritative session check
Source of truth = ChatGPT's own `fetch('/api/auth/session')`: a live session returns an
`accessToken`, a logged-out one returns `{}` (200). DOM heuristics become a fallback used
only when the backend call is inconclusive, and that fallback now *waits* briefly for the
logout CTA so a late render is not missed. Result: `autoLogin` fires reliably on an expired
session.

### 2. Mid-request logout escalation + retry (`completeText`)
A logout/navigation that destroys the Playwright context is retried **only before the prompt
was submitted** — a fresh page + the now-correct `ensureLoggedIn` re-logs-in within the same
request. After a confirmed submit it is final (the same error also fires on benign SPA
navigation, so blindly retrying would re-issue the prompt into a fresh chat → duplicate
generation). Genuine login failures carry a typed `login_failed` code for alerting; the
ambiguous context-destroyed message stays `server_error`.

### Review-driven hardening (Codex/agy)
- `getContext()`/`getPage()`/the re-login are **single-flight** so the startup warm-up can't
  race the first request into two browsers or two concurrent logins.
- The `/api/auth/session` probe is bounded by a 4 s `AbortController` (a hung endpoint must
  not wedge the single request queue).
- `isLoggedIn` returns "logged out" only for a **confirmed empty** `{}` body; any other shape
  is inconclusive → DOM fallback (a schema drift must not wipe a working session).
- `ensureLoggedIn` **verifies** `isLoggedIn` after `autoLogin` (which declares success on a
  visible textarea — the same false-positive class) and raises `login_failed` otherwise.

### 3. Startup pre-login (`server.js`)
After `app.listen`, kick off a best-effort `ensureSessionReady()` so a fresh pod establishes
/validates the session at boot rather than lazily on the first request. Non-blocking; does
not gate readiness.

## Explicitly out of scope (optional, later)
A background session-keeper (idle heartbeat that re-logins proactively). With fix #1 the next
request self-heals and with #2 even the triggering request recovers, so the heartbeat is a
warmth optimization, not a correctness requirement, and it carries browser-context race risk.

## Verification
- `npm test` green (adds a `classifyError` case for the logout signature).
- Live: fresh pod logs `[startup] session ready — logged_in=true`; control chat probe returns
  `{"ok":true}`.
