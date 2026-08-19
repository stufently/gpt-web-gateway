# Session visibility + diagnosable auto-login (2026-07-26)

## Incident

Third occurrence of the same shape in one month (2026-07-10, 07-22, 07-25). The ChatGPT
session died, auto-login did not restore it, and the gateway served nothing but errors for
**~34 hours** while every signal we had stayed green:

- pod `Running`, no restarts;
- `/health` → 200, `/health/live` → 200;
- blackbox probe green.

Only real API calls failed. The browser sat on the anonymous ChatGPT page, its clicks
intercepted by `#modal-no-auth-login`, with "log in" / "sign up for free" in the button
list. 2.4.0 had already fixed *a* false-positive in `isLoggedIn()` and had not closed the
hole.

## What actually went wrong

### 1. Nothing observable described "am I logged in?"

`/health` is intentionally session-independent: a dead session must not remove the only
replica from the Service, and a restart does not fix an expired cookie. `/health/live`
watches for a *wedged* browser, not a logged-out one. So the only path from "session dead"
to "a human knows" was a failing request — and with low traffic there wasn't one for 34 h.

**Fix:** `gpt_web_gateway_session_valid` (+ check age, check outcomes, login-failure
breakdown) and a watchdog that refreshes it every 5 min regardless of traffic. The alert
goes on the gauge, the probes stay as they are.

### 2. `isLoggedIn()` still had a "logged in" guess in it

After the backend probe came a DOM fallback ending in:

```js
const composer = await p.$('[id="prompt-textarea"]:visible, textarea:visible');
if (composer) return true;
```

ChatGPT renders that composer for **anonymous** visitors (verified 2026-07-26: the
anonymous page shows "Where should we begin?" / "Ask anything" alongside Log in / Sign up).
The preceding logged-out-CTA check waited only 1.5 s, so any slow render fell through to
the composer rule and reported a dead session as healthy.

**Fix:** `/api/auth/session` is the only positive source, retried
(`SESSION_PROBE_ATTEMPTS`, default 3 × 4 s) instead of falling through on the first hiccup.
The DOM may only *confirm a logout* (login CTA / `#modal-no-auth-login`), never a login.
The check is tri-state internally — `in` / `out` / `unknown` — and `isLoggedIn()` is
fail-closed: anything but `in` is "not logged in", so an unverifiable session gets
re-established rather than silently used.

The tri-state matters twice.

*For the gauge:* an unreachable endpoint is not evidence of a logout, so `unknown` leaves
`session_valid` alone and only ages `session_check_age_seconds`. Fail-closed applies to
*behaviour*, not to reporting. Conversely, events we *know* are destructive — the start of
a re-login (which clears the cookies) and a failed login — call `sessionHealth.invalidate()`
and drop the gauge with no hysteresis. Without that, a failed re-login would record a single
`out` (the streak needs two) and then leave no page to probe, so every later tick would be
an `unknown` and the gauge would sit at `1` over a dead service — the very hole this release
closes.

*For the recovery decision* (`decideSessionAction`, pure and unit-tested): `in` → proceed,
`out` → re-login, `unknown` → **refuse the request but keep the cookies**. Re-login is
destructive, so a flapping `/api/auth/session` must not be able to wipe a working session.
Only after `SESSION_UNKNOWN_ESCALATE` (3) inconclusive checks in a row does an `unknown`
escalate to a re-login, so a permanently unverifiable session cannot wedge the gateway
either. For the same reason `403` is inconclusive rather than a logout: Cloudflare and WAFs
answer 403 to requests they dislike, which says nothing about our cookies.

### 3. Auto-login failures were undiagnosable by construction

Both observed failures logged exactly one line:

```
auto-login failed: locator.waitFor: Timeout 15000ms exceeded ... input[type="password"]
auto-login failed: locator.waitFor: Timeout 60000ms exceeded ... #prompt-textarea
```

No `page.url()`, no on-page text, no screenshot. Which screen blocked the login —
Cloudflare interstitial, captcha, "verify it's you", an attempt lockout, or a redesigned
form — was therefore unknowable after the fact, and each incident was re-diagnosed by hand.
The owner has since confirmed the credentials are valid, which makes the blocking screen
*the* question and the missing evidence *the* problem.

**Fix:** every login step runs through `step()` (`src/auto-login.js`). On failure
`captureLoginFailure()` (`src/login-diagnostics.js`) collects url / title / banners /
visible buttons / input inventory / iframe hosts in one bounded `page.evaluate`, classifies
the screen, logs

```
[auto-login] BLOCKED by cloudflare_challenge at step "password-field": Just a moment...
```

and writes `auth/diag/login-fail-<ts>-<step>.{json,jpg}` — on the auth PVC, so it survives
the restart that follows — keeping the last `LOGIN_DIAG_KEEP` (5) incidents. The blocker
class is carried out through the typed error into the API body (`login_blocker` /
`login_step`) and into `gpt_web_gateway_login_failures_total{blocker=…}`.

Diagnostics run on the failure path of something already broken, so they are defensive:
the page probe has a Node-side deadline (`LOGIN_DIAG_TIMEOUT_MS`, 5 s — an in-page timer is
hostage to the same wedged renderer), the JSON report is written *before* the screenshot so
a failed capture cannot cost us the textual diagnosis, and rotation runs both before and
after writing so a full volume still gets reclaimed instead of throwing straight past the
cleanup.

Blocker labels (stable, used by alerting): `cloudflare_challenge`, `captcha`,
`rate_limited`, `credentials_rejected`, `device_verification`, `mfa_required`,
`login_form_changed`, `unknown`.

### 4. Fail-closed needed a brake

Fail-closed checks mean an unreachable endpoint now triggers a re-login. Against a screen
that blocks *every* attempt (captcha, lockout) that would mean one login attempt per
request — the fastest way to turn a temporary block into a long one.
`AUTO_LOGIN_RETRY_COOLDOWN_SEC` (120) re-surfaces the previous diagnosed reason instead of
retrying; a successful login clears it immediately.

## Watchdog safety rules

The watchdog must never become the thing that breaks the session:

- **read-only** — the same `GET /api/auth/session` the app already makes, issued from the
  page that is already open. No navigation, no clicks, no `clearSession()`;
- **skips while a job is queued or running** (`progress.queue_size > 0`), so it cannot
  interleave with an operation on the single browser page. That check alone is a TOCTOU —
  a request can enqueue right after it — so an in-flight probe is published as
  `sessionProbeInFlight` and `_ensureLoggedIn()` awaits it before touching the page. The
  two can never drive the page concurrently, and a slow tick cannot stack up behind the
  next one (single-flight);
- **skips while a login is in flight** (the `ensureLoggedIn` single-flight promise);
- **skips when recent traffic already proved the session valid** within the interval —
  a request that just authenticated is better evidence than another poll;
- **never opens a page and never logs in.** If there is no page it reports `unknown`.
  Recovery stays on the request path; a session that needs a human (captcha, device
  verification) stays a human's job via `/login`;
- **is bounded from Node, not from the renderer.** The probe's `AbortController` lives
  inside the page and therefore cannot fire when the renderer is the thing that is wedged —
  `page.evaluate` would hang forever, and since that promise is the lease requests wait on,
  the gateway would deadlock. Every probe is raced against a Node-side deadline
  (`SESSION_PROBE_TIMEOUT_SEC + SESSION_PROBE_DEADLINE_SLACK_MS`).

  Racing a deadline bounds *our wait* but does not cancel the evaluate, so blowing it also
  **discards the page**: closing it rejects the orphaned call, guarantees the next
  `getPage()` builds a fresh one, and stops successive ticks from stacking up hung calls.
  Marking the session degraded and leaving the reset for later is not enough — whoever
  calls `getPage()` next may not consume the pending reset and would inherit the same dead
  page. A request waiting on the lease caps out at `SESSION_LEASE_WAIT_MS` and does the
  same discard, and the watchdog skips its tick entirely while a reset is pending.

## Secret hygiene

Diagnostics touch the login page, so everything that leaves the module is redacted:
configured e-mail / password / TOTP secret / API key, any e-mail-shaped string, bearer
tokens, long opaque blobs. URLs keep parameter *names* but never values
(`code`, `state`, `token`, …). Screenshots use Playwright's `mask:` on every
`<input>` / `<textarea>` / contenteditable **and** on any element rendering the configured
e-mail as plain text — a device-verification screen says "we sent a code to
you@example.com" in its copy, not in a field. Masking happens *during rendering*, so
nothing sensitive ever exists in the file: no DOM mutation, no state corruption.
`LOGIN_DIAG_SCREENSHOTS=0` disables images entirely for anyone unwilling to store them.
Artifacts live on the private auth volume (never `public/images/`, which is served
over HTTP).

## Verification

- `npm test` — 45 new assertions across `test-session-health.js`,
  `test-login-diagnostics.js`, `test-session-check.js`, including the regression itself
  (anonymous page with a visible composer ⇒ **not** logged in), "an endpoint that never
  answers fails closed", "`invalidate()` beats the hysteresis", "inconclusive refuses before
  it escalates", "a hung `page.evaluate` cannot hang the diagnostics" and "no credential
  reaches a written artifact".
- The session-check fixture executes the real in-page probe against a stubbed `fetch`, so
  response-shape handling (401 / `{}` / `{accessToken}` / unknown schema) is under test.

## Open question (out of scope here) — ANSWERED, see below

The headless browser uses `playwright-extra` + `puppeteer-extra-plugin-stealth`, but the
context claims a **macOS** user agent while running headless Chromium on **Linux**, and the
hard-coded `Chrome/131` no longer matches the bundled `playwright-core` (1.58.x). A UA that
contradicts the platform and the client hints is a cheap anti-bot signal, and anti-bot
screens are now the leading hypothesis for the login failures. Worth revisiting once the
diagnostics have named the actual blocker a couple of times.

**Resolution (2026-07-26, same day).** The diagnostics shipped here did their job on the
first production start — they named `cloudflare_challenge` immediately — and the hypothesis
above turned out to be **wrong**: the pinned macOS UA never reached the network, because the
stealth plugin rewrites the user agent per page (measured: byte-identical wire headers with
and without the pin). The actual blocker is the pod's **egress IP** — the same image and
fingerprint is served HTTP 200 from one address and answered `403 cf-mitigated: challenge`
from the production node's freshly-allocated hosting range. Full measurements, the
`patchright` evaluation, and what 2.6.0 does about it:
[2026-07-26-cloudflare-block-fingerprint-vs-egress.md](2026-07-26-cloudflare-block-fingerprint-vs-egress.md).
