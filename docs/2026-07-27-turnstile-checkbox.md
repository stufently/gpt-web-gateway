# The challenge that had to be clicked (2026-07-27)

## Symptom

The session was dead and could not be rebuilt. The pod was `Running`, `1/1`, zero restarts,
`/health` returned `{"status":"ok"}` — and `gpt_web_gateway_session_valid` was `0`, with
`gpt_web_gateway_login_failures_total{blocker="cloudflare_challenge"}` climbing. Every
auto-login ended the same way:

```
[auto-login] Filled email
[auto-login] Submitted email
[auto-login][diag] step=password-field blocker=cloudflare_challenge
  url=https://auth.openai.com/api/accounts/authorize?…&prompt=login
  title="Just a moment..." inputs=email:false,password:false,otp:false
  banners=[] buttons=["Cloudflare","Privacy"] iframes=[]
[auto-login] BLOCKED by cloudflare_challenge at step "password-field": Just a moment...
  (underlying: locator.waitFor: Timeout 15000ms exceeded.)
```

## What the capture actually showed

The diagnostic screenshot saved alongside that JSON
(`/app/auth/diag/login-fail-2026-07-27T02-00-50-312Z-password-field.jpg`, Ray ID
`<ray-id>`) does not show a passive interstitial. It shows the Cloudflare widget
rendered with a **checkbox**: *"Verify you are human"*.

That single observation invalidates the premise 2.6.1 was built on. `CHANGELOG.md` for 2.6.1
records the conclusion "the challenge verdict is decided per navigation, so a fresh `goto` is
what clears it", and `src/cloudflare.js` carries the same reasoning. It holds for the passive
interstitial. It cannot hold for a checkbox: **every fresh navigation just renders a fresh,
unticked checkbox.** Cloudflare stopped auto-ticking that box even for ordinary browsers — it
wants the pointer event, so it can sample how the click arrives.

Nothing in the codebase clicked anything. Three consecutive releases —
`b45364d` (diagnostics), `e830289` (fingerprint evasions + egress proxy), `2a5547f` (retry
instead of waiting) — all tuned navigation behaviour. The missing behaviour was never a
shorter wait or another `goto`.

## Why the diagnostics pointed the wrong way

The capture reported `iframes: []` for a page that visibly had the widget.
`src/login-diagnostics.js` enumerated frames with `document.querySelectorAll('iframe')`, which
only sees the light DOM. Turnstile renders inside a cross-origin iframe that sits under a
**shadow root**, so the query returns nothing, and the failure reads as "no iframes, no
inputs — the login form must have changed". That is a diagnosis pointing at a UI redesign that
never happened.

Playwright's frame graph is built from CDP target information rather than DOM queries, so it
sees that frame straight through the shadow boundary. That is now both the way the widget is
located and an extra field in the capture.

## The second failure mode, recorded but not fixed

One run (2026-07-26 20:18) got **through** Cloudflare and reached the real password page:

```
url=https://auth.openai.com/log-in/password
title="Oops, an error occurred! - OpenAI"
bodyText="Route Error (400 Invalid content type: text/html; charset=UTF-8)"
iframes=["auth.openai.com","sentinel.openai.com"]
```

So the checkbox is passable, and there is a second layer behind it (`sentinel.openai.com` is
OpenAI's own bot detection). This is **evidence, not a diagnosis** — a 400 on that route has
other explanations, and one sample proves no causal link. It is recorded here so the next
investigation starts from it rather than rediscovering it.

## What changed

- **`src/turnstile.js`** — locate the widget (frame graph first, shadow-piercing DOM walk as
  fallback), compute the checkbox point from its bounding box, move the pointer in steps and
  click, then watch until the widget goes away. Never throws, never navigates: a failed solve
  leaves the caller exactly where it was.
- **The click is wired in at the step that actually fails.** The challenge does not appear on a
  `goto`, so wrapping navigation does nothing for it — it appears on the redirect *after* the
  email submit. `src/auto-login.js` now races "field appears" against "challenge appears" at
  the password and email steps (`waitForThroughChallenge`), with the budget raised from a flat
  15 s to `LOGIN_FIELD_TIMEOUT_SEC` (default 60) so a solve can finish inside it.
- **`src/cf-navigate.js`** also attempts a solve before spending an attempt on a re-navigation,
  for the case where a `goto` does land on a checkbox.
- **`src/login-diagnostics.js`** pierces open shadow roots and merges Playwright's frame graph
  into `iframes`, so `challenges.cloudflare.com` shows up in a capture — which the existing
  `cloudflare_challenge` classifier rule already matches.

## Deliberately not done

**Patchright was not adopted.** It removes the `Runtime.enable` CDP leak that Cloudflare
fingerprints (confirmed in its patch set) — but `Target.setAutoAttach` remains, so it reduces
signal rather than removing it, and its own guidance is real Chrome + persistent context +
`headless:false`, which is not what this pod runs. More to the point, it implements
`addInitScript` through request routing, and this app depends on init scripts,
`exposeFunction` and its own `context.route()` for conversation trimming and SSE capture
(`src/chatgpt.js:318`, `:325`). Swapping the engine risks the paths that currently work in
order to fix one that can be fixed directly. It belongs behind an A/B canary with a full smoke
run (login, chat, SSE, upload, image generation, session reuse), not in this release.

Known fingerprint leaks that remain, for whoever picks that up: the channel is
`headless-shell`, and `userAgentData.getHighEntropyValues()` still reports `HeadlessChrome` in
`fullVersionList` even when `gpt_web_gateway_browser_ua_evasion_ok` is `1`.
