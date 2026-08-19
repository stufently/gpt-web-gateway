# Changelog

## 2.13.1 — the 0600 repair could not run on an upgraded volume (2026-08-19)

2.13.0 both dropped root and started writing `auth/session.json` as 0600, and those two changes
collided on exactly the deployments the release was aimed at. `writeFileSync`'s `mode` applies
only when a file is created, so an existing session needed a repair `chmod` — but after the
switch to `USER node`, that file is still owned by whoever wrote it under the old root image.
`chmod` on a file you do not own is `EPERM` even when `fsGroup` has made it group-writable, so
every save threw and the request came back `500 EPERM: operation not permitted, chmod
'/app/auth/session.json'`. Measured in production immediately after the upgrade; it did not
show up in pre-release testing because a fresh container creates the file itself and owns it.

The repair is now best-effort and warns once instead of failing: the session has already been
saved by the time it runs, and a permission we cannot tighten is not a reason to fail the call.

To actually get 0600 on an upgraded volume, reissue the file as the runtime user — the mount
directory is group-writable, so this needs no root:

    cd /app/auth && cp session.json .new && chmod 600 .new && mv .new session.json

## 2.13.0 — pre-publication security pass (2026-08-19)

Audit of the whole repository ahead of making it public. No credential, cookie or session file
was ever committed — `.env`, `auth/` and `session.json` are excluded from the first commit
onward, and every password/JWT in the test suite is a synthetic placeholder. What the audit did
find was live infrastructure described in prose, plus a set of defaults that are safe behind
this deployment's ingress and unsafe for anyone who copies the image.

### Removed from the tree

- The production hostname, in `clients/chatgpt-web-skill/{SKILL,rules}.md`, replaced with
  `gpt-web-gateway.example.com`.
- Every real address in `docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md` — the dev
  host, the production pod, the egress proxy and the alternate node pool — replaced with
  `<dev-host>`, `<prod-pod>`, `<proxy>`, `<alt-node-pool>`. The document's argument is about
  *which* egress is trusted, so the labels carry it exactly as well as the numbers did, and the
  ASN/netname stay because the conclusion (a young Hetzner /17 is distrusted) depends on them.
- The Cloudflare Ray ID from the 2026-07-27 capture, in both the turnstile doc and the header
  comment of `src/turnstile.js`.
- Names of unrelated private pipelines from the client skill's notes.

### Hardened

- **The container no longer runs as root.** `USER node`, `/app` chowned, and
  `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` — without that last part the browsers stay in
  root's 0700 cache and a non-root start cannot find them at all.
- **Helm**: `runAsNonRoot` + `fsGroup: 1000` (load-bearing — the RWO PVCs at `/app/auth` and
  `/app/public/images` would otherwise arrive root-owned and the session could not be written
  back), `seccompProfile: RuntimeDefault`, `drop: ["ALL"]`, `allowPrivilegeEscalation: false`,
  and `automountServiceAccountToken: false`. The workload drives a browser over untrusted web
  content; it has no business holding a ServiceAccount token.
- **`auth/session.json` is written 0600** (directory 0700), with an unconditional `chmod` so
  files left by an earlier version are fixed on the next save. That file is the live ChatGPT
  session — the cookies are, in practice, the account.
- **`public/index.html` builds result markup as DOM nodes** instead of interpolating into
  `innerHTML`. The image URL is assembled server-side from the request's `Host` header, so a
  spoofed Host reached a script sink.
- `actions/checkout` pinned by commit SHA, matching the other actions in the workflow.
- `npm audit` clean again (`brace-expansion` DoS, transitive through the legacy stealth stack).

### Documented

The README now leads with what `/login` actually is: not a login form but a remote-control
surface for a browser that is already signed in to your ChatGPT account — screenshots out,
clicks and keystrokes in. With `API_KEY` unset the gateway is open, and `/`, `/images/*`,
`/health` and `/metrics` stay outside `API_KEY` by design. Generated images are also served to
anyone who knows the id and are never expired.

## 2.12.0 — the Intelligence tier moved to a slider, and nothing was selecting it (2026-08-08)

### The silent failure

Every request had stopped setting the tier. `thinking_mode` was accepted, echoed back, and then
ignored — each answer ran at whatever level the composer happened to be left on. Measured on
production before the fix:

```
requested extended → applied.thinking_mode = extra_high, thinking_verified = false
[ui-adapter] openIntelligenceMenu FAILED — pill activation did not open levels menu
[ui-adapter] Intelligence menu did not open — skipping level set
```

Nothing was down: `/health` 200, the pill was found and read correctly, no alert could fire.
`thinking_verified: false` was the only signal, and it is a field a caller has to opt into
checking.

### What changed in ChatGPT

The named dropdown is gone. The composer pill now opens a popover with **two faces**:

- collapsed — a **positional slider**, one tick per tier, no names anywhere;
- expanded via **"Advanced"** — **Model** and **Effort** rows, where Effort opens a submenu
  holding the same named levels as before (Instant / Medium / High / Extra High / Pro).

`intelligenceMenuOpen()` required at least two visible `[role="menuitemradio"]` items. Neither
face has any, so it reported "did not open" and `applyLevel` returned before touching anything.

### The fix

`applyLevel` now tries the named submenu first and the slider second.

**Named path preferred deliberately.** Items carry their own text and disabled state, so
"this account cannot select Pro" stays distinguishable from "the click missed" — a distinction
`setThinkingMode` spends real logic on, because one downgrades the tier and the other counts
toward tearing the session down. A bare slider cannot express it: a track that will not move is
all you get.

**The slider is driven by arrow keys**, not by dragging and not by assigning `.value` — React
does not observe a direct property write, so the app would never see the change. Keys work
identically for a native `<input type="range">` and an ARIA thumb, and need no geometry. The
thumb is focused rather than clicked, since a click on the track jumps the value to the click
position.

A slider that stops short of the target is reported as **inconclusive**, never as "the tier is
unavailable". Whether it moved first cannot distinguish the two: a locked Pro reached from
Extra High never moves at all, while the same locked Pro reached from Medium moves three times
and then stops. Unavailability keeps its two trustworthy witnesses — a track too short to hold
the tier, and an explicitly disabled item in the named menu — and a stalled slider is not a
third one.

A short track means the **top** tiers are missing (Plus renders three positions), so
`levelIndex` returns null past the end instead of clamping. Clamping would have reproduced the
exact bug this release fixes — a Pro request quietly served as High and reported as a success.

If the track is longer than there are tiers, the index mapping is unknown and the slider path
is refused outright rather than guessed at, with the geometry logged. ARIA defines no
`aria-valuestep`, so a `role="slider"` scaled 0..100 lands here by construction.

### Diagnostics

The failure path now dumps what the popover actually contains — popover roots with trimmed
`outerHTML`, plus every slider with its ARIA values. This control has been redesigned three
times (effort modal → named dropdown → slider) and each time the logs recorded only that the
*old* shape was missing, never what replaced it. Scoped to popover roots and sliders so it
cannot spill conversation text into the log.

### Also fixed while in here

- `\b` is ASCII-only in JS, so `расширенн[а-яё]*\b` matched nothing: on a Russian UI the
  Advanced/Effort rows were unreachable and every request fell through to the slider.
- One `Escape` closes one layer, and the control nests two deep — the parent popover could be
  left open, and a leaked popover swallows the next activation.
- Arrow keys were aimed at the first slider in DOM order while the state was read from the
  first *visible* one; on a page holding both, we would have read one element and typed at
  another. Failure to focus the thumb is now logged instead of surfacing as a mute track.
- Popover item lookups now also search plain `div.popover` roots, which is how ChatGPT renders
  composer panels — an ARIA-less submenu was invisible to them.

### Unchanged

The API contract (`instant` / `standard` / `extended` / `extra_high` / `pro`), the pro →
extra_high quota downgrade, the cooldown memo, and `thinking_verified` / `requested_verified`
semantics. `applyLevel`'s result shape is untouched, so the tier-chain tests still cover it.

## 2.11.1 — a session envelope carrying `error` is no longer read as "logged in" (2026-07-31)

### The outage

For roughly 7 hours the pod was `Running`, `/health` was 200, `session_valid` was **1**, no alert
fired — and every real request spent 30–40 s typing into a logged-out page before returning 504.

The ChatGPT session's refresh token had died. `/api/auth/session` did not start failing; it kept
answering **200** with the stale `user`, `account` and `accessToken` still in the envelope, plus
one extra key:

```json
{ "user": {...}, "accessToken": "...", "expires": "...", "error": "RefreshAccessTokenError" }
```

The web app honours that `error` and renders the **anonymous** page — Log in / Sign up, plus the
`#modal-no-auth-login` overlay, which then intercepts pointer events and eats a 30 s click
timeout on `#prompt-textarea`. Our probe stopped at `if (j.accessToken || j.user) return true`,
so it reported `in` **47 consecutive times** against a browser that was visibly signed out.

This is the same class of failure as the 27 h (2026-07-22) and 34 h (2026-07-25) incidents — a
false-positive session check — arriving through a door the earlier fixes left open. Those closed
"a visible composer means we are logged in"; this one is "a token in the envelope means we are
logged in".

### Fixed

- **`error` in the session envelope ⇒ not proof of a session** (`src/chatgpt.js`). Deliberately
  *inconclusive*, not a hard logout: `out` drives `autoLogin`, which clears the cookie jar, and
  an error that clears on retry must not cost a live session. The existing retry-then-confirm
  ladder settles it — two more attempts, then the DOM check, which finds the Log in / Sign up
  CTA and the no-auth modal and returns a confirmed `out`. A confirmed `out` puts the request
  path onto its recovery route immediately; `session_valid` drops to 0 on the *second*
  consecutive `out` (the gauge has hysteresis, `failureThreshold` = 2), and
  `GptWebGatewaySessionInvalid` fires after its 10 m `for`.
- **The endpoint's error name is now logged** (`[session] /api/auth/session answered 200 but
  carries error="…"`), once per probe rather than once per attempt. Its absence is why this
  incident could not be diagnosed from the logs at all: finding the cause took launching a
  second browser inside the pod to read the response body by hand. The name is the only thing
  quoted: an object `error` is logged by `code`/`message`, or reduced to its key names if it
  has neither, and control characters are stripped — the schema is unofficial, so its values
  could carry a credential, and a newline would let the endpoint forge a log record.

### Tests

`scripts/test-session-check.js` (+5, 20 total) — the fixture is the real production body
captured from the pod, not an invented shape: envelope-with-error is never `in`, is `out` once
the DOM confirms, and still yields to a `LIVE` response on retry. Two more cover the log line
itself: the error name survives, the token and the account address never appear, and the record
stays on one line.

### Not fixed here

`autoLogin` remains the automated recovery path, and it has never been exercised end to end
against this failure. The manual re-login performed during the incident — through the existing
`/login` UI, from *inside* the live context, keeping `cf_clearance` and the device cookies —
went through email → password → TOTP with no Cloudflare friction at all on patchright.
`autoLogin` calls `clearSession()` first (which does preserve CF cookies), so it starts from a
slightly weaker position than that manual run.

## 2.11.0 — patchright + real Chrome replaces the 2022 stealth bundle (2026-07-29)

`puppeteer-extra-plugin-stealth` has not shipped since 2022. It does not patch the CDP-protocol
leaks (`Runtime.enable`, `Console.enable`) that modern anti-bot systems key on, and — measured
in this repo — it *manufactures* two contradictions of its own: it rewrites the platform to
**Windows** while `navigator.platform` stays `Linux x86_64`, and it leaves `HeadlessChrome` in
`navigator.userAgentData.getHighEntropyValues().fullVersionList`.

The default engine is now **`patchright` driving real Google Chrome**. Every layer agrees:
`X11; Linux x86_64` in the user agent, `platform: "Linux"` in the client hints, and no headless
token anywhere.

### Why now — the old rejection had expired

[docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md](docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md)
tested patchright and rejected it, in its own words: *"Run headless, **as this service must**,
it is worse than what we already have."* The one patchright row in that table that passed was
*real Chrome, **headed under Xvfb***. On **2026-07-27**, the day after, the service moved to
headful under Xvfb for the Turnstile work. The premise the rejection rested on was gone; nobody
revisited the conclusion. See
[docs/2026-07-29-patchright-compat-probe.md](docs/2026-07-29-patchright-compat-probe.md).

### Measured, not assumed

Same image, same `session.json`, same host, arms interleaved (ABBA), a fresh browser process per
trial — the method this repo's own method note prescribes after a previous one-sample-per-
condition mistake inverted a conclusion:

| Engine | Startup session probe | Cloudflare challenge redirects |
| --- | --- | --- |
| `patchright` + real Chrome | **4/4 `session ready — state=in`** | 0 |
| `stealth` + Chromium (legacy) | 1/4 | 3 |

The legacy arm reproduced the exact production symptom (`session state could not be verified`).
A real chat request through the new engine returned a correct answer in 6.8 s with
`answer taken from backend-api stream` — the streaming path, end to end. Resident memory
586 MiB against the pod's 3 Gi limit.

**Scope, stated honestly:** four trials per arm from one egress, and *not* the production pod's.
This is a strong relative signal, not proof that the production outage is cured.

### The one real migration hazard, and what it cost

Under patchright `page.evaluate` defaults to an **isolated** world, and the `exposeFunction`
binding `__gwgSseChunk` is **not installed in the main world** — where the `window.fetch` tee
lives — until Node touches that world once. Measured: `undefined` at t0/50/250/1000/2500 ms,
`function` immediately after a single main-world evaluate. It is not a race that waiting fixes.

Left alone this would have been silent: the old tee did `if (window.__gwgSseChunk)` and simply
skipped, so every streamed answer would have come back **empty** rather than failing loudly.

- The tee now **buffers** into `window.__gwgSseBuffer` (capped at 2000 entries) whenever the
  binding is absent, so nothing is dropped in that window.
- `primeMainWorld()` runs **two** evaluates — the first creates/primes the main world, the
  second is the earliest one that can see the binding — then flushes the buffer. Registered on
  `page.on('load')`, because each new document gets a new main world and the gateway
  re-navigates on Cloudflare retries.
- A binding that stays unreachable now logs a warning instead of quietly serving empty answers.

### Rollback is one environment variable

`BROWSER_ENGINE=stealth` restores the previous stack exactly. The image ships **both** browsers
for this release so a rollback needs no rebuild (image 1.91 GB; drop the `playwright install`
line once patchright has held a full canary). `resolveChannel` follows the engine, so the
rollback also restores the old channel — but note that an explicit `CHROMIUM_CHANNEL` still
overrides both, and under patchright `chromium` selects the configuration measured at 403.

### Also

- `BROWSER_ENGINE` rejects an unrecognised value at startup rather than silently picking one —
  this setting decides which identity goes on the wire.
- `launchArgs` omits `--disable-blink-features=AutomationControlled` under patchright, which
  curates those defaults itself (it also *removes* `--enable-automation` and
  `--disable-component-update`, each a documented detection point).
- The `navigator.webdriver` init-script mask is skipped under patchright: it already reports
  `false` natively, and replacing a native getter with a JS one is an extra patch for nothing.
- `patchright` is pinned exactly (`1.61.1`) — it installs its own Chrome, so a floating range
  would drift the browser between rebuilds.
- 283 tests pass (was 244).

### Fixed during review (Codex + agy), before release

- **The chart still said `2.10.2`.** `helm/Chart.yaml` drives the image tag, so this release
  would have deployed the previous image — the same class of mistake that took the service down
  earlier the same day. Both `version` and `appVersion` are now `2.11.0`, verified by rendering
  the chart.
- **Three page-level scripts still injected the `navigator.webdriver` mask**, bypassing the
  context-level policy and contradicting this changelog. They now go through one engine-aware
  helper, `maybeHideWebdriverOnPage()`.
- **A stale stream could hijack a new turn.** Draining the buffer *after* `beginBackendCapture()`
  would feed the previous navigation's chunks into the new capture — those ids are not yet in
  `staleStreams`, so the first would win `boundStream` and the real answer would be discarded.
  The drain now runs first, while `currentCapture` is still null, which is what marks them
  stale. Drained calls are also awaited: `exposeFunction` returns a promise, and firing them
  unawaited reorders chunks, which for an SSE accumulator is corruption rather than lateness.
- **`HEADLESS` defaulted to `true`** in `helm/values.yaml`, `docker-compose.yml`, `.env.example`
  and the README quickstart — the one configuration measured as *not* working. All now `false`.
- **The buffer cap counted entries, not bytes.** A failed prime could pin an unbounded amount of
  memory in the page; it is now bounded by both (2000 entries / 4 MiB), overflow is counted and
  logged, and a failing prime is logged instead of swallowed.
- **Rollback did not reach the CLI entry points.** The engine was resolved at import while
  `npm run auto-login` loads `.env` afterwards, so `BROWSER_ENGINE` from `.env` was ignored
  there; `npm run login` was hard-wired to the legacy stack, meaning a hand-recovered session
  came from a browser the server would never run. Engine resolution is now lazy and `login.js`
  follows it.

**Known gap, stated rather than hidden:** the test suite still never launches a browser, so
`primeMainWorld` and the buffer have no automated regression test — they were verified by hand
against the real image and a real session. An integration test covering navigation → early SSE →
drain, plus the stale-stream case, is the obvious next piece of work.

## 2.10.2 — a stale page could walk a live session into a destructive re-login (2026-07-29)

Observed twice, on two different pods: the startup probe reports `[startup] session ready —
state=in`, and the first request roughly a minute later reports `unknown` on the **same
page**. The cookies never changed — a page that has been sitting idle gets its in-page XHRs
challenged, while a freshly navigated one does not. The startup path is the proof: the same
`fetch('/api/auth/session')`, the same cookies, a definitive answer.

That was not merely noisy. Every inconclusive check fed `consecutiveUnknownChecks`, and at
`SESSION_UNKNOWN_ESCALATE` (3) the gateway escalated to `autoLogin → clearSession()`. So a
session that was **alive** got its cookies wiped because we could not check it — and the
clean re-login that followed is exactly what Cloudflare Turnstile blocks. A recoverable
hiccup turned into a hard outage needing an interactive login.

Two changes, both about never acting on an unproven logout:

- **Re-navigate before an inconclusive verdict counts.** `probeSessionWithRecovery()` rebuilds
  the page and re-probes once when the first probe says `unknown`. Only the first `unknown`
  of a streak pays for it — a rebuild costs up to the page-creation budget (~90 s), so later
  ones refuse cheaply until the streak breaks.
- **Inconclusiveness may no longer trigger a re-login.** `decideSessionAction()` now answers
  `reset` instead of `relogin` for an `unknown` streak: the browser context is rebuilt from
  `session.json` instead of `clearSession()` wiping it. The live `storageState` is saved
  first (best-effort, bounded) so cookies refreshed since the last snapshot are not rolled
  back. Rebuilds are rate-limited by `CONTEXT_RESET_COOLDOWN_SEC` — an unverifiable session
  keeps qualifying for one, and rebuilding per request would spin. If it is *still*
  unverifiable afterwards the request is refused (retryable `login_failed`) and the alert
  brings a human — strictly better than destroying credentials that were probably working.
  Only a **confirmed** `out` still re-logs in.
- **The credentials check moved below the non-destructive paths.** It used to run before the
  streak was even incremented, so on a `/login`-managed session (no `CHATGPT_EMAIL`) an
  `unknown` threw immediately, the streak stayed pinned at 0, and every single request paid
  for a fresh re-navigation while the context rebuild could never run.

Also fixed alongside: `recreatePage()` awaits the old page's `close()` before building its
replacement (`resetPage()` fired it un-awaited, and here a replacement is built immediately
after), and a `pendingReset` left over from a probe deadline is now dropped once the
re-navigation has produced a confirmed-live page — otherwise the next operation threw away
the page we had just verified.

## 2.10.1 — every image refusal came back as `server_error` (2026-07-29)

2.10.0 made the image path's error message depend on `limitKind`, but read it from the
`errorMsgs` object literal that is built *above* the `let limitKind` declaration. An object
literal evaluates every property eagerly, so that read landed in the temporal dead zone and
threw `Cannot access 'limitKind' before initialization` — not only for `limit`, but for
**every** non-success outcome, `policy` and `refused` included.

The consequence was worse than a bad message. The TDZ error escaped the classifier, so a
content-policy refusal reached the client as:

```jsonc
{ "ok": false, "error_kind": "server_error", "should_retry": true,
  "error": { "message": "Cannot access 'limitKind' before initialization" } }
```

`should_retry: true` is exactly the opposite of what a refusal means. The whole point of
`error_kind` is that a caller must not retry a prompt that can never succeed, and for a day
every such prompt was advertised as retryable — while the real reason for the failure was
invisible to both the caller and the logs.

Computing `limitKind` before `errorMsgs` restores the intended classification
(`policy_violation` / `refused` / `rate_limit` / `tier_limit`) with their correct
`should_retry` values. No behaviour was redesigned; only the order of two adjacent blocks.

Found from the outside: `/v1/images/edits` returned the TDZ message verbatim while
`/v1/chat/completions` and `/v1/images/generations` were healthy — the error path was simply
the only code nobody had exercised since the release.

**The gap that let it through, now closed:** the suite covered `classifyError`'s message→kind
mapping (`scripts/test-classify.js`) and the DOM predicate that decides *which* outcome the
page shows (`scripts/test-refusal-detect.js`), but nothing asserted what an outcome turns
*into*. A temporal dead zone is invisible to `node --check` and to every test that never
executes the line.

`waitAndExtractImage` is now exported under `_test` and exercised against a page double —
`waitForFunction` returning the verdict and one `evaluate` — since a non-success outcome
throws long before any image work. Four cases: `policy` → `policy_violation`, `refused` →
`refused` (both asserted non-retryable via `shouldRetryKind`), a bare limit → `rate_limit`,
and a Pro-quota notice → `tier_limit` with the tier memoized and *not* a global rate limit.
Reverting just the statement order fails all four.

## 2.10.0 — Pro falls back to Extra High when its quota is out (2026-07-28)

The account's Pro quota runs out periodically. Until now a `thinking_mode=pro` request in
that state did not fail — it ran at whatever level the composer pill happened to show
(usually the previous chat's), reported `thinking_verified: false`, and nobody looked. The
caller silently got a weaker answer than any tier it would have chosen deliberately.

Now the request is served one tier down and the response says so:

```jsonc
"applied":   { "thinking_mode": "extra_high", "thinking_verified": true,
               "requested_verified": false,
               "thinking_fallback": { "from": "pro", "to": "extra_high", "reason": "quota" } },
"requested": { "thinking_mode": "pro" }
```

- **`applied.requested_verified`** is new. `thinking_verified` refers to what was *applied*,
  so after a successful downgrade it is `true` — a client reading it alone would conclude
  "Pro confirmed". `requested_verified` answers the actual question.
- **Downgrade ≠ memo.** Serving this request one tier down is cheap and always safe;
  remembering the tier as gone is sticky and hurts when wrong, so the two use different
  evidence bars: an explicitly disabled item (`aria-disabled`/`data-disabled`) or the
  post-submit limit notice memoize at once, a missing menu item needs two consecutive
  sightings (the menu counts as "open" at two visible levels — a half-rendered one looks
  identical), and a click the UI swallowed never memoizes. `TIER_UNAVAILABLE_COOLDOWN_SEC`
  (default 900) bounds it, and a pill that already shows Pro clears the memo outright, so a
  restored quota is never fought by the adapter.
- **A broken menu is not a tier problem.** If the dropdown does not open at all, no fallback
  is attempted (a lower tier lives in the same menu) and the old degradation accounting
  applies — counted **once per call**, never once per hop, so a downgrade can no longer
  push the session toward a reset by itself.
- **New `error_kind: tier_limit`** (HTTP 503, `should_retry: true`) for the case ChatGPT
  reveals only after submission: a limit notice instead of an answer. It used to burn the
  whole budget and surface as a timeout, plus a stall-abort that marked a perfectly healthy
  session degraded. No automatic resend — the prompt is already submitted — but the tier is
  memoized at that moment, so the retry and everything after it are downgraded automatically.
  Deliberately **not** `rate_limit`: that kind arms a global cooldown across every endpoint.
- **An image turn's Pro-limit no longer takes the whole gateway down.** The notice matches
  the broad `достигли лимита` phrase the image-limit detector uses, and that path raises
  `rate_limit` — which arms a 30-minute cooldown across *every* endpoint. It is now told
  apart and raised as `tier_limit` instead.
- **Batches (`n > 1`) report the tier honestly.** The echo was taken from the first image;
  if Pro ran out on image 3, the response still claimed a confirmed Pro batch.
  `thinking_verified` / `requested_verified` are now true only if *every* turn was, any
  single downgrade is surfaced, and `applied.thinking_mode_mixed` marks a batch whose turns
  did not all run on the same tier.
- **Metrics**: `gpt_web_gateway_tier_fallbacks_total{from,to}` (counted only when the
  downgrade actually took effect; the configured pair is always emitted, at 0 if it never
  fired) and `gpt_web_gateway_tier_cooldown_active{tier}`.
- **Client scripts**: `chat.sh` / `generate.sh` no longer report every 503 as "check your
  credentials" — a pre-existing misdirection that `tier_limit` would have walked straight
  into. `chat.sh` also prints a `NOTE:` on stderr when the answer came from a lower tier.
- Config: `TIER_FALLBACK_PRO` (default `extra_high`, `off` disables),
  `TIER_UNAVAILABLE_COOLDOWN_SEC` (default 900).

The post-submit detector is fenced three ways, because it reads whole-page text: it is armed
only for the tier that actually ran, the caller's own prompt is subtracted (asking Pro about
Pro limits must not abort its own request), and the notice must be *new* relative to the page
before this turn (otherwise one banner would kill every following request in a continued
conversation).

Known gap: the downgrade is decided *before* the prompt is sent, so the post-submit path
costs one failed request per quota-exhaustion event — by design, since re-sending a submitted
prompt is how you get duplicate generations.

## 2.9.1 — Timeout ladder raised for the Pro tier (2026-07-27)

- **The client skill is now tracked** in `clients/chatgpt-web-skill/` (`chat.sh`,
  `generate.sh`, `edit_image.py`, `SKILL.md`, `rules.md`). It is a client of this API and has
  to move with it — the `--extra-high` / `--pro` flags and the raised `--max-time` had existed
  on one disk only. `.env` stays out (gitignored); only `.env.example` is tracked. The
  directory's README carries the sync commands and the drift warning.

The top tiers shipped in 2.9.0 can think for minutes, and the text budget had been sized
for the lower three. Raising it alone would not have worked: nginx would have cut the
connection first and returned *its* 504, throwing away the structured error body
(`error_kind`, `should_retry`) that clients branch on. So the whole ladder moves together,
each layer strictly above the one inside it:

| Layer | Was | Now |
|---|---|---|
| server, text (`90 + CHAT_COMPLETION_TIMEOUT_SEC + …_RETRY_…`) | 570 | **870** (600 + 180) |
| server, images (`90 + GENERATION_MAX_TIMEOUT_SEC`) | 690 | 690 (unchanged) |
| ingress `proxy-read/send-timeout` | 720 | **960** |
| client `chat.sh --max-time` | 900 | **1020** |
| client `generate.sh --max-time` | 600 | **1020** |

- **`generate.sh` was already inconsistent** at 600 s — *below* the 690 s the server may
  legitimately spend on an image, so a slow generation was cut off by the client before the
  server had finished. Fixed in the same pass.
- Server budgets live in the cluster values (`CHAT_COMPLETION_TIMEOUT_SEC=600`,
  `CHAT_COMPLETION_RETRY_TIMEOUT_SEC=180`); the ingress annotation carries the arithmetic in
  a comment so the next person raising one knows which others must move with it.
- Headroom, not a fix: the worst measured answer so far is 266 s, well inside the old 360 s.

## 2.9.0 — Every intelligence tier is reachable (2026-07-27)

The ChatGPT "Intelligence" dropdown offers five levels on non-Plus plans —
`Instant / Medium / High / Extra High / Pro`. The API exposed the lower three.

- **`extra_high` and `pro` are now API modes**, mapping to Extra High and Pro.
- **The top tiers are no longer pushed back down.** This is the part that mattered beyond
  "you could not ask for them": because `veryhigh`/`pro` were missing from `LEVEL_TO_MODE`,
  an account sitting on one of them was read as `extended` and then actively switched DOWN
  to High on the next request. Selecting Pro by hand in the UI could not survive a single
  call.
- **BREAKING: `thinking_mode: "pro"` no longer means `extended`.** It used to be an alias
  for High; now that a real Pro tier exists, it selects Pro — which is what a caller asking
  for "pro" plainly means. The generic synonyms `advanced` / `deep` / `расширенный` still
  resolve to `extended`.
- **`applied.effort` counts the top tiers.** It was `appliedMode === 'extended'`, so the two
  highest settings in the product would have reported `effort: false`.
- **Asking for a tier your plan lacks no longer tears the session down.** An unverified
  switch increments `consecutiveMenuFailures`, and two in a row call `markSessionDegraded`
  → page/hard reset. Since tier availability is plan-dependent (Plus has no Extra High or
  Pro), requesting one would have been read as a broken adapter. The adapter now separates
  "the menu opened and this level is not in it" from "the menu did not open / the click
  missed", reports the former as `unsupported` and does not count it as degradation.
- **UI level names are accepted as aliases.** `thinking_mode: "high"` — the obvious thing to
  try after reading the dropdown — used to resolve to `instant`, the opposite of the
  request. `high`/`высокий` → extended, `medium`/`средний` → standard. An unrecognised
  explicit mode still falls back to `instant` but now logs a warning instead of doing it
  silently.
- **The tier maps moved to `src/chatgpt-tiers.js`** with a test asserting they are mutual
  inverses. A mode present in one map and missing from the other is exactly how the top
  tiers came to be downgraded in the first place.
- Web UI (`public/index.html`), `chat.sh`, `generate.sh` and the skill docs list the new
  tiers. Image endpoints share the same parser, so `--pro` works there too — expect minutes.

## 2.8.3 — The challenge loop was finite; we were the ones giving up (2026-07-27)

Headful under Xvfb did not stop Cloudflare re-challenging after the password submit. What
the logs showed instead is that the loop was cut off by **our** budget, not by Cloudflare
relenting: each clear-then-re-challenge cycle costs ~15 s, and the hard-coded 60 s fitted
exactly three.

- **`CHAT_READY_TIMEOUT_SEC`** (default 60, floor 30) makes that budget configurable.
- **Measured answer: the loop ends.** At 300 s the login walked through it, reached the
  composer and saved the session. `session_valid` went to 1 and the service came back —
  chat (`ok:true`, `thinking_verified:true`) and image generation (1254×1254) both
  verified end to end.
- The Turnstile solver from 2.7.0 is what made this reachable at all: the same run shows
  it clearing the checkbox that stood in front of the password field
  (`challenge cleared after 3s`), which is the step every attempt had been dying on.
- Cluster values: `CHROMIUM_CHANNEL=chromium`, `HEADLESS=false`,
  `CHAT_READY_TIMEOUT_SEC=300`.

## 2.8.2 — Run the Xvfb wrapper under tini (2026-07-27)

2.8.1 fixed the crash but not the outage: the pod reached `Running` and then logged
**nothing at all**, never bound the port, and was killed by the liveness probe — the
silent-failure shape this service has been bitten by before.

- **`xvfb-run` cannot be PID 1.** It is a shell script that waits for SIGUSR1 from the X
  server, and that handshake does not complete under PID 1. Measured in a clean image
  with `xauth` present: the wrapped command printed nothing and the container hung until
  it was killed (exit 124); with `ENTRYPOINT ["/usr/bin/tini", "-g", "--"]` in front, the
  same command printed `DISPLAY=:99` and exited 0. Verified on the real image too —
  `/health` answers `200 {"status":"ok"}` within 3 s of start. `-g` additionally forwards
  SIGTERM to the process group and reaps the browser's orphaned children.
- `--error-file=/dev/stderr` so the X server's own log lands in `kubectl logs` instead of
  a file nobody reads.

## 2.8.1 — Install xauth alongside xvfb (2026-07-27)

2.8.0 never started in production: the container exited immediately with
`xvfb-run: error: xauth command not found`, and the pod went to CrashLoopBackOff.

- `xauth` is only a **Recommends** of the `xvfb` package, so `--no-install-recommends`
  dropped it — while `xvfb-run` shells out to it unconditionally to write the display
  cookie. The image now installs `xvfb xauth`.

## 2.8.0 — Run the browser headful under Xvfb (2026-07-27)

With the solver working, production showed the next wall: Cloudflare accepted every
click, cleared the widget, and served another challenge — three rounds in a row until the
step's budget ran out. That is a **challenge loop**, which Cloudflare's own troubleshooting
docs describe as the symptom of a browser it does not trust. Clicking was never going to
end it: the click was already succeeding.

- **Headless is the signal that remains.** It differs from real Chrome well below the JS
  surface any evasion can patch, so no amount of stealth scripting removes it. The image
  now ships `xvfb` and starts the server under `xvfb-run`, making the browser a normal
  windowed Chrome that happens to draw to a virtual screen. `HEADLESS` defaults to
  `false`; setting it back to `true` still works.
- **Screen is 1280x800x24**, matching the viewport — the solver clicks real coordinates,
  so the widget must not be clipped.
- Pairs with `CHROMIUM_CHANNEL=chromium` (full build rather than the bundled
  headless-shell), already set in the cluster values. Deploying that alone moved the email
  and password steps to no challenge at all, but did not end the loop after the password.

## 2.7.2 — Solve the challenge after the password too (2026-07-27)

2.7.1 proved the solver works: production logs show it finding the widget through the
frame graph, clicking at (222, 335), retrying once and clearing the challenge — after
which the password field appeared and was filled, which is the step the outage died on.

It also showed the last unwired step. Cloudflare challenges the navigation AFTER the
password submit as well, and `chat-ready` was still a bare 60 s wait.

- **`chat-ready` races the composer against a challenge**, like the email and password
  steps already did.
- **The `auth_route_error` is Cloudflare, confirmed.** Taking the page's "Try again"
  turns `400 Invalid content type: text/html` into a plain "Just a moment" interstitial
  with `challenges.cloudflare.com` in the frame graph — the 400 was that challenge
  answering an XHR with HTML. The separate blocker label stays: it names the screen
  accurately, and it is the evidence trail that made the connection visible.

## 2.7.1 — Name the second blocker, and take its retry (2026-07-27)

Deploying 2.7.0 confirmed the Cloudflare fix and exposed what was behind it. The login
now walks past the checkbox and fills the password — the step that had been failing —
and then stops on OpenAI's own auth app instead.

- **The app-shell loader clicks too.** 2.7.0 wired the solve into the login path and the
  navigation helper but not into `chatgpt.js`, whose own settle loop still only waited
  and re-navigated. Production logs showed exactly that loop spinning on a challenge.
- **`auth_route_error` is now its own blocker.** The page reached after the password
  submit is `Oops, an error occurred! Route Error (400 Invalid content type: text/html)`
  — the Remix data request was answered with HTML where it expected JSON. It was being
  classified as `login_form_changed`, which points the next investigation at a UI
  redesign that never happened.
- **That page's own "Try again" is taken once** before the step fails. It re-issues the
  request, and by then a clearance cookie the first attempt lacked may be set.
- **`CF_TURNSTILE_BUDGET_SEC`** (default 20) bounds one solve attempt on the page-load
  path.

Note for whoever picks this up: the frame-graph merge added in 2.7.0 is what made the
second layer visible at all — the capture now lists `sentinel.openai.com (frame-graph)`,
which the old light-DOM walk could not see.

## 2.7.0 — Click the Cloudflare checkbox (2026-07-27)

2.6.1 shipped on the conclusion that a challenge is cleared by navigating again. The
diagnostic screenshot from the 2026-07-27 login outage shows why that could never
recover this one: the widget was rendered with a **"Verify you are human" checkbox**.
Evidence and full reasoning:
[docs/2026-07-27-turnstile-checkbox.md](docs/2026-07-27-turnstile-checkbox.md).

- **A checkbox challenge cannot be re-navigated away.** Every fresh `goto` renders a
  fresh, unticked box. Cloudflare no longer ticks it automatically even for ordinary
  browsers — it wants the pointer event, to sample how the click arrives. Nothing in
  the codebase clicked anything, which is why three releases spent on navigation
  timing changed nothing.
- **New `src/turnstile.js`.** Finds the widget through Playwright's frame graph (which
  sees the cross-origin iframe straight through the shadow root that hides it from DOM
  queries), falls back to a shadow-piercing walk, computes the checkbox point from the
  bounding box, moves the pointer in steps, clicks, and watches until the widget is
  gone. It never throws and never navigates, so a failed solve leaves the existing
  re-navigation path untouched — the two handle different challenge types.
- **The click is wired in where the login actually failed.** The challenge appears on
  the redirect *after* the email submit, not on a navigation, so the navigation wrapper
  could never have seen it. The password and email steps now race "field appears"
  against "challenge appears" (`waitForThroughChallenge`).
- **`LOGIN_FIELD_TIMEOUT_SEC`** (default 60, was a hard-coded 15) — a solve needs the
  click plus ~15 s of settling, so the step budget has to be able to contain one.
- **Diagnostics stop lying about iframes.** `document.querySelectorAll('iframe')` sees
  only the light DOM, so the capture reported `iframes: []` for a page that visibly had
  the widget and the failure was filed as "the login form changed". The walk now
  pierces open shadow roots and merges Playwright's frame graph, so
  `challenges.cloudflare.com` appears in the capture — which the existing
  `cloudflare_challenge` rule already matches.
- **A failed probe is no longer mistaken for a solved challenge.** Widget detection is
  tri-state (`present` / `absent` / `error`): a frame detached mid-navigation used to read
  as "no widget", so the solve reported success and the caller skipped the
  re-navigation that was its real way out. Success now also requires the widget to be
  absent on two consecutive probes, so one flicker cannot win.
- **The solve cannot outrun its budget.** `budgetMs` bounds the whole call rather than
  each attempt, every sleep is clamped to what is left, and each page probe is raced
  against a Node-side timeout — a renderer that stops answering never rejects, so
  `try/catch` alone could not bound it.
- **The frame graph is listed first in a capture.** With ten ordinary iframes the DOM
  entries filled the list and the appended graph entries were cut by the final slice,
  hiding the one host the fix exists to surface. Dedup is by exact hostname.
- **Patchright was evaluated and deliberately not adopted** in this release: it reduces
  the CDP fingerprint but not to zero, and it reimplements `addInitScript` via request
  routing, which is what conversation trimming and SSE capture depend on. Reasoning and
  the leaks that remain are in the doc above.

## 2.6.1 — Retry the Cloudflare challenge instead of waiting it out (2026-07-26)

2.6.0 shipped on the conclusion that the egress IP decides the verdict. Measuring
the same question a second time — repeated navigations from three different
addresses, spaced out in time — refined that into the cause of the outage itself.
Correction and data: the "Correction" section of
[docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md](docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md).

- **The verdict is per navigation, not per address.** The production pod's own IP —
  the one written off as permanently distrusted — is challenged on one `goto` and
  served **HTTP 200** on the next one a minute later. Once a navigation gets
  through, the access holds: three immediate follow-up navigations were all 200.
  The same pattern reproduces through unrelated proxy addresses.
- **The bug: one navigation, then two minutes of waiting.** The load path navigated
  **once** and then sat on the interstitial for 60 × 2 s before failing. That page
  does not clear itself for this browser, so the service could never take the next
  window — a recoverable challenge became a 34-hour outage.
- **Fix: a fresh navigation after a pause** (`CF_LOAD_ATTEMPTS`, default 2;
  `CF_RETRY_GAP_SEC`, default 45, growing linearly for further attempts). Waiting on the
  interstitial is now capped by `CF_CHALLENGE_GRACE_SEC` (default 15) — enough for a
  challenge that does clear on its own, after which the budget goes to the retries.
  Only a Cloudflare challenge is retried; a blank SPA keeps its own recovery path.
- **One absolute deadline bounds the page load** (`CF_LOAD_BUDGET_SEC`, default 90) —
  navigations included, not just the waits. An attempt count is not a time ceiling: three
  slow `goto`s alone spent 250 s against the 240 s a first cut of this release called a
  ceiling. The deadline now clamps each navigation's timeout, the app-shell polling, the
  interstitial grace, the gaps, and the reload inside `recoverContentFailed`. A gap is only
  waited out when the attempt it exists for also fits — otherwise the pause buys nothing.
  Defaults fit the caller's clock: 90 s of page load + the 360 s answer wait + its 120 s
  extension stay inside the ~600 s clients allow, and tests assert both halves so the pair
  cannot drift apart silently.
- **Known limitation, stated rather than papered over:** this bounds ONE page-load sequence,
  not a whole request. `CHATGPT_TEXT_RETRY_ATTEMPTS` can re-enter the page load up to four
  times before submit, and an auto-login brings navigation budgets of its own, so a
  pathological request can still outlive a client timeout. Bounding a request end to end
  needs a deadline threaded through the queue, login and retries (and a page reset when it
  fires) — a change of its own, deliberately not smuggled in here.
- **Auto-login retries its navigations too** (`src/cf-navigate.js`). Both pre-credential
  GETs — `chatgpt.com` and `chatgpt.com/auth/login` — were single-shot, so a challenge
  there ended as "waited for the password field, gave up" and armed the login cooldown,
  no matter how well the app-shell loader recovered. When the retries are spent, the
  `goto-login` step now fails *there*, so the diagnostics say `cloudflare_challenge`
  instead of blaming a UI redesign (`login_form_changed`) 15 seconds later — the step passes
  an explicit `blockerHint`, because an interstitial with no title yet is invisible to a
  DOM-based classifier. A confident DOM verdict still wins over the hint.
- **A recovery reload no longer hides a fresh challenge.** `recoverContentFailed` reloads
  the page and used to discard the response, leaving the loop to judge Cloudflare by the
  headers of the *original* navigation — so a challenge that arrived with the reload, with
  no title yet, was invisible.
- **Every Cloudflare interstitial counts, not just the "Just a moment" wording.** The wait
  loop keyed on that literal string, so "Attention Required", "Checking your browser" and a
  challenge visible only in `cf-mitigated` fell through to generic polling and burned a
  minute per attempt. And once we know we are challenged, only a *real* page title releases
  us — an empty title (normal right after `domcontentloaded`) must not cancel the verdict.
- **A challenge served at `/auth/login` no longer counts as "reached the auth page".**
  Cloudflare returns its interstitial at whatever path was requested, so the URL heuristic
  alone would publish a challenge page and leave auto-login poking at it instead of retrying.
- **The policy is a pure module** (`src/cloudflare.js`) with unit tests
  (`scripts/test-cloudflare.js`), plus `scripts/test-cf-navigate.js`, which drives the real
  retry loop against a scripted fake page (virtual clock, no browser, no network). The
  predicate being right while the loop that uses it is wrong is precisely how this outage
  happened; two of the bugs listed above were caught by that test, not by review.
- **`PROXY_SERVER` is no longer the recommended first move.** It still works and
  still helps a genuinely bad address, but it is not needed for this failure — and
  routing through a proxy has its own cost. Reach for the retry first.

## 2.6.0 — Cloudflare block: fingerprint hardening + egress control (2026-07-26)

2.5.0's diagnostics named the blocker on the first production start
(`cloudflare_challenge`, `session_valid 0`). The leading hypothesis was the
browser fingerprint — `browser.js` pinned a **macOS Chrome/131** user agent while
running headless Chromium **145** on **Linux**. Measuring it refuted that and
found the real cause. Full write-up:
[docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md](docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md).

- **Diagnosis: the egress IP, not the fingerprint.** The pinned UA never reached
  the network — the stealth plugin rewrites the UA per page, so the wire headers
  were byte-identical with and without it. What *does* decide the verdict is the
  address: the **same image, same fingerprint** is served HTTP 200 from one host
  and answered `403 cf-mitigated: challenge` from the production pod, whose node
  sits in a freshly allocated hosting range that Cloudflare scores as low-trust
  (`sliver=010-tier2`). No fingerprint variant changed that, in either direction.
- **`PROXY_SERVER` / `PROXY_USERNAME` / `PROXY_PASSWORD`.** Route the browser out
  through a different address without a rebuild — the lever that addresses the
  measured cause. Verified end-to-end against chatgpt.com through an authenticated
  proxy with the evasions intact. A malformed URL, an unsupported scheme, or
  credentials on a SOCKS proxy (Chromium implements proxy auth for HTTP(S) only)
  all fail at startup instead of quietly sending traffic out of the very address
  they were meant to avoid — or crashing on the first launch.
- **The proxy password cannot be logged by accident.** `playwright-extra` prints
  its full launch options under its own `debug` namespace, password included.
  Startup refuses a configured `PROXY_PASSWORD` together with a `DEBUG` value that
  enables it, naming which one to change.
- **The pinned user agent is gone.** Dead code while the stealth plugin works —
  but if that plugin ever stops applying, the pin becomes the only identity on the
  wire, and it is measurably incoherent (UA "macOS Chrome/131" + `Sec-CH-UA`
  "HeadlessChrome/145" + `navigator.platform` "Linux"). The context now sends no UA
  of its own and lets the browser speak for itself. `src/login.js` carried its own
  copy of the same string; that is gone too.
- **`BROWSER_USER_AGENT` now actually takes effect.** A context-level `userAgent` is
  inert while stealth is alive — it re-overrides the UA on every page — so the
  override is installed *inside* the bundle instead. Caveat, logged rather than
  hidden: that evasion deliberately masks Linux as Windows, so the platform part of
  a pinned UA is rewritten (coherently); version and brands are honoured.
- **The evasions are now verified instead of assumed**, in **every** `BROWSER_MODE`.
  They are the single thing standing between this gateway and a challenge on *any*
  IP (with stealth: 200; without: 403, same host, same minute), and they fail
  silently. Each finished context is asked what it really advertises;
  `gpt_web_gateway_browser_ua_evasion_ok` starts at `0` and rises only once that
  has happened, so an unverified browser never reads as healthy. Deliberately
  narrow name: it tracks the user-agent token, which is evidence the bundle stopped
  applying — not a verdict on the whole fingerprint, which still leaks
  `HeadlessChrome` through `userAgentData` high-entropy hints even when it passes.
- **Cloudflare failures explain themselves.** A stuck challenge used to produce 60
  identical `Just a moment...` lines and no cause. It now emits one line with
  `cf-mitigated`, `cf-ray`/colo, the egress IP as Cloudflare reports it, whether a
  live `cf_clearance` cookie existed, and whether the UA was still clean — followed
  by a pointer to the more likely of the two causes. Detection keys on the
  `cf-mitigated` header rather than an English page title, and the whole collection
  (cookies included) sits behind one Node-side deadline, since it runs against a
  page already known to be unhealthy. Plus
  `gpt_web_gateway_cloudflare_challenges_total`.
- **`CHROMIUM_CHANNEL`** opts into the full Chromium build (new headless) without a
  code change. Off by default: measured ~722 MB resident vs the headless shell's
  ~377 MB on an idle page, against a 3 Gi limit that already peaks near 1.7 GiB,
  and it moved the Cloudflare outcome in neither direction.
- **Fixed: the stealth plugin mutated the shared launch-args array** in place,
  appending to `--disable-blink-features=` on every launch, so the flag grew with
  each browser restart. Each launch now gets a fresh copy.
- **`navigator.webdriver` is hidden at context level**, covering every page instead
  of the two that remembered to add it.
- **Evaluated and rejected: migrating to `patchright`.** Tested rather than assumed:
  headless — the only way this service can run — it is *blocked* where the current
  stack is served, because it deliberately does not remove the `HeadlessChrome`
  token. It passes only in its documented configuration (real Chrome, headed, under
  an X server), which would mean ~400 MB of Chrome in the image, an extra process
  and a move off `storageState`, aimed at a cause the measurements do not support.

Still needs the owner: code cannot fix a distrusted IP. Either set `PROXY_SERVER`,
or move the pod to a node with a different address (`nodeSelector`), or log in once
by hand via `/login` as a stopgap. See the doc's "Still open" section.

## 2.5.0 — session visibility + diagnosable auto-login (2026-07-26)

Third outage of the same shape in a month (2026-07-10, 07-22, 07-25): the ChatGPT
session died, auto-login did not restore it, and the service sat broken for ~34 h
with the pod `Running`, `/health` and `/health/live` returning 200 and the
blackbox probe green. 2.4.0 fixed *one* false-positive; this release removes the
blind spot itself.

- **`gpt_web_gateway_session_valid` gauge.** Nothing exported whether the gateway
  was logged in, so the only signal was a human reading logs. The session state is
  now a first-class metric (`1` = last conclusive check said logged in, `0` =
  logged out or never confirmed), alongside
  `gpt_web_gateway_session_check_age_seconds`,
  `gpt_web_gateway_session_checks_total{result=…}` and
  `gpt_web_gateway_login_failures_total{blocker=…}`. `/health` deliberately stays
  session-independent (see README) — the alert belongs on the gauge.
- **Traffic-independent session watchdog.** Every
  `SESSION_WATCHDOG_INTERVAL_SEC` (default 300) the gateway re-checks its own
  session, so a dead session surfaces in minutes instead of on the next request.
  Strictly read-only — the same `GET /api/auth/session` the app already makes,
  from the page that is already open; it never navigates, clicks, clears cookies
  or logs in. It skips the tick while a job is queued, while a login is in flight,
  and when recent traffic already proved the session valid, so it cannot interfere
  with the request queue.
- **Session probes are bounded from Node, not from the renderer.** The probe's
  `AbortController` runs inside the page, so it cannot fire when the renderer
  itself is wedged — `page.evaluate` would hang forever. Every probe is now raced
  against a Node-side deadline, and blowing it **discards the page** (a race bounds
  the wait but does not cancel the call, so the next user of that page would hang
  identically). A request waiting on an in-flight watchdog probe gives up after
  `SESSION_LEASE_WAIT_MS` and discards the page the same way.
- **`isLoggedIn()` no longer guesses, and fails closed.** The DOM fallback used to
  treat *a visible composer* as proof of a session — but ChatGPT renders the
  composer for anonymous visitors too (confirmed 2026-07-26: the anonymous page
  shows "Ask anything" next to Log in / Sign up), which is how a dead session read
  as healthy. `/api/auth/session` is now the only positive source and is **retried**
  (`SESSION_PROBE_ATTEMPTS`, default 3) instead of falling through to guesswork on
  the first hiccup; the DOM is consulted only to *confirm a logout*. The check is
  tri-state internally (`in`/`out`/`unknown`) and anything short of a confirmed
  live session counts as logged out. A `403` is treated as inconclusive rather than
  as a logout — Cloudflare/WAF answers 403 to requests it dislikes, which says
  nothing about our cookies.
- **Failing closed does not mean destroying the session.** Re-logging in wipes the
  cookies (`clearSession`), so an *inconclusive* check now refuses the request with
  a retryable `login_failed` and keeps the session; only a confirmed logout
  re-logs in at once. `SESSION_UNKNOWN_ESCALATE` (default 3) consecutive
  inconclusive checks escalate to a re-login anyway, so an unverifiable session
  cannot wedge the gateway indefinitely.
- **Auto-login failures are now diagnosable.** Previously a failure logged only
  `Timeout 15000ms exceeded ... input[type="password"]` — no URL, no page text, no
  screenshot — so the blocking screen was unknowable after the fact. Every step now
  reports **which screen blocked it**: `cloudflare_challenge`, `captcha`,
  `rate_limited`, `credentials_rejected`, `device_verification`, `mfa_required`,
  `login_form_changed`. The class appears in the log (`[auto-login] BLOCKED by …`),
  in the API error body (structured `login_blocker` / `login_step` fields), and in
  the metrics label; the page URL, on-page banners, visible buttons, input
  inventory and a screenshot are written to
  `auth/diag/login-fail-<ts>-<step>.{json,jpg}` — on the auth volume, so they
  survive the restart — keeping the last `LOGIN_DIAG_KEEP` (5) incidents. The
  collection runs under its own deadline (`LOGIN_DIAG_TIMEOUT_MS`), so a wedged
  renderer cannot hang the login path it is diagnosing.
- **No credential leakage in diagnostics.** Everything written or logged passes
  through redaction (configured e-mail/password/TOTP/API key, any e-mail-shaped
  text, bearer tokens and long opaque blobs); auth URLs keep parameter names but
  never values; screenshots mask every `<input>`/`<textarea>`/contenteditable plus
  any plaintext occurrence of the configured e-mail (verification screens print it
  in the copy), and can be turned off with `LOGIN_DIAG_SCREENSHOTS=0`.
- **Auto-login cooldown (`AUTO_LOGIN_RETRY_COOLDOWN_SEC`, default 120).** With
  fail-closed checks, a login blocked by a captcha or a lockout would otherwise be
  retried on every request — which is itself a way to earn a longer lockout. After
  a failure the previous, already-diagnosed reason is re-surfaced until the
  cooldown expires; a successful login clears it immediately.
- **Helm: default memory limit 2 Gi → 3 Gi.** Chromium peaked at ~1.7 GiB over 48 h
  of light traffic; 2 Gi left almost no headroom.
- **CI: third-party actions pinned by commit SHA.** The `docker` job holds a GHCR
  push token, and `docker/*@vN` are mutable tags — a retagged upstream release
  would run with our registry credentials. Pinned to exactly what those tags
  resolved to on 2026-07-25, so build behaviour is unchanged:
  `docker/setup-buildx-action@8d2750c6` (v3.12.0),
  `docker/login-action@c94ce9fb` (v3.7.0),
  `docker/metadata-action@c299e40c` (v5.10.0),
  `docker/build-push-action@10e90e36` (v6.19.2).
  First-party `actions/checkout@v4` left as is (same trust domain as the runner).
  Build behaviour unchanged; the pin ships with this release.

## 2.4.0 — permanent session auto-recovery (2026-07-22)

Fixes the root cause of the `GptWebGatewayHighErrorRate` incident where a
logged-out ChatGPT session stayed broken for 27h+ and never auto-recovered.

- **`isLoggedIn()` is now authoritative.** It reads ChatGPT's own
  `/api/auth/session` (an `accessToken`/`user` ⇒ logged in; a confirmed empty `{}`
  ⇒ logged out; any other shape ⇒ inconclusive → DOM fallback) instead of trusting
  DOM heuristics. ChatGPT renders the composer/`textarea` even on the logged-out
  page, so the old check false-positived → `ensureLoggedIn` skipped `autoLogin` on
  every request and the dead session survived restarts. The backend probe is
  bounded by a 4 s `AbortController` so a hung endpoint can't wedge the queue, and
  the DOM fallback now *waits* for the "Log in" CTA so a late render can't lose the
  race.
- **`autoLogin` result is verified.** `ensureLoggedIn()` re-checks `isLoggedIn`
  after login (autoLogin declares success on a visible textarea — the same
  false-positive class) and raises a typed `login_failed` if the session still
  isn't authenticated. The re-login runs under a single-flight guard so concurrent
  callers can't launch two competing logins.
- **Mid-turn logout is recoverable — safely.** A logout/navigation that destroys
  the Playwright context is retried in `completeText` **only before the prompt was
  submitted** (a fresh page + the corrected `ensureLoggedIn` re-logs-in within the
  request). After a confirmed submit it is final, so the prompt is never
  re-issued (no duplicate generation).
- **Startup pre-login.** `server.js` calls `ensureSessionReady()` after listen
  (non-blocking, best-effort) so a fresh pod establishes/validates the session at
  boot rather than lazily on the first caller. `getContext()`/`getPage()` are now
  single-flight so the warm-up can't race the first request into two browsers.

`autoLogin` itself was already healthy (verified: passes Cloudflare + TOTP and
restores the session); these changes ensure it actually *fires*.

## 2.2.1 — SSRF guard for /login/navigate

- `POST /login/navigate` no longer accepts a caller-supplied URL: it always
  navigates to `https://chatgpt.com` (the only target the login UI ever used).
  Previously any URL was accepted, letting an API caller drive the
  authenticated login browser to arbitrary hosts (SSRF / cookie-exposure
  primitive); a host allowlist was rejected as still bypassable via HTTP
  redirects, which `page.goto()` follows. In-page auth/SSO redirects during
  login are unaffected.

## 2.2.0 — advanced features verified live, backend-api reading on by default

All 2.1.0 features were verified end-to-end against the live ChatGPT UI
(2026-07-18): backend-api answer source, multi-turn context carry-over,
SSE chunk stream with `[DONE]`, conversation-trim route rewrite on a real
conversation (chat unbroken, server-side context untouched), memory PATCH,
image generation with interception active, and the DOM-only fallback path.
The "experimental" label is dropped.

- **`READ_VIA_BACKEND_API` is now ON by default** (set `0` for the DOM-only
  path). Consequently `stream: true` works out of the box.
- Memory disable verified with a nuance: `hive_referenced_in_internal_knowledge`
  ("reference chat history") PATCHes fine; `sunshine` ("saved memories") can be
  server-gated (403 on some accounts) — documented, still best-effort.
- Conversation trim documented as a client-side load optimization (server-side
  conversation context is untouched).
- Docs: "Experimental features" → "Advanced features" (README, .env.example,
  docker-compose).
- Fixed: the streaming gate in `routes/images.js` parsed `READ_VIA_BACKEND_API`
  independently (hard-coded default-off), so with a clean env `stream: true`
  was rejected while interception was actually on. The flag is now exported by
  `src/chatgpt.js` and imported — one source of truth; regression tests pin the
  `envFlag` semantics (absent → default, explicit off forms, typo → default).
- Follow-up candidates (review notes): mask the injected fetch tee's `toString`
  and move page→Node chunk delivery off a named `window.*` binding (stealth
  hardening); unify remaining boolean env vars on `envFlag`.

## 2.1.0 — multi-turn, backend-api reading, streaming

Improvements inspired by the ChatGPT Multi Pane extension
(megamen32/chatgpt-multi) and Habr article 1052710. All behavioral changes are
behind env flags (default OFF) except multi-turn `conversation_id`, which is
backward-compatible. The flagged features are **experimental**: they automate
unofficial `/backend-api/*` internals and have not been validated against the
live ChatGPT UI by CI (unit tests cover the pure logic; the default DOM path is
unchanged and remains the fallback).

- **Multi-turn conversations**: `POST /v1/chat/completions` and
  `POST /v1/responses` accept an optional `conversation_id` (strictly validated
  UUID) to continue an existing ChatGPT conversation; every text response now
  includes a top-level `conversation_id`.
- **Backend-api answer reading** (`READ_VIA_BACKEND_API=1`): passively
  intercept ChatGPT's own `/backend-api/conversation` traffic
  (`page.on('response')` + injected fetch tee for live SSE deltas) and take the
  assistant answer from there; DOM scraping stays as the fallback. New pure
  module `src/lib/conversation-read.js` (mapping walker + incremental SSE
  accumulator for both the legacy and the delta wire formats).
- **SSE streaming** (`stream: true`, requires `READ_VIA_BACKEND_API=1`):
  OpenAI-compatible `chat.completion.chunk` events with `data: [DONE]`
  termination and a terminal error event on mid-stream failures. New pure
  module `src/lib/sse-transform.js`. Without the flag, `stream:true` is
  rejected with a clear 400; `/v1/responses` rejects `stream` always.
- **Conversation trim** (`CONVERSATION_TRIM_LIMIT=N`): rewrite
  `GET /backend-api/conversation/{id}` via `page.route()` to the last N
  messages of the active branch — long chats stop freezing the tab. Logic
  ported (with tests) from chatgpt-multi `src/lib/conversation-trim.js`.
- **Memory disable** (`DISABLE_CHATGPT_MEMORY=1`): once per process, PATCH the
  account-level memory settings to `false` for more deterministic answers
  (unofficial endpoint, best-effort with logging).
- Tests: three new node:test suites (conversation-read, conversation-trim,
  sse-transform) with realistic conversation fixtures; wired into `npm test`.
- Docs: README sections for multi-turn, streaming and experimental flags;
  `.env.example` and docker-compose env examples.

## 2.0.0 — initial public baseline

First public release, migrated from a private deployment (fresh history).

- OpenAI-compatible endpoints backed by the ChatGPT.com web UI via Playwright
  + stealth Chromium:
  - `POST /v1/chat/completions` and `POST /v1/responses` with thinking modes
    (`instant` / `standard` / `extended`) and an `applied` echo block
    (including `thinking_verified`).
  - `POST /v1/images/generations` — batches up to 10, aspect ratios,
    reference images, quality/format preferences, `url` / `b64_json`.
  - `POST /v1/images/edits` — multipart image editing with reference images.
  - `GET /v1/images/capabilities` (UI probe) and `GET /v1/images/status`.
- Optional app-level auth: `API_KEY` env guards all `/v1/*` routes
  (Bearer or Basic); `/health` and `/metrics` stay open.
- Typed error contract: `error_kind`, `should_retry`, verbatim
  `model_message` from the UI; adaptive timeouts that extend only while the
  page shows live progress; stall-guard for frozen pages.
- Reliability: request queue with `Retry-After`, rate-limit cooldown,
  auto-login (email/password/TOTP), remote-login web UI (`/login`),
  self-healing browser resets, liveness endpoint (`/health/live`) with
  stuck-detection and failure-streak tracking.
- Observability: Prometheus `/metrics` (counters, error types, duration
  histogram).
- Ops: Dockerfile, docker-compose, example Helm chart, GitHub Actions CI with
  GHCR image publishing.
