# Cloudflare block: fingerprint vs egress (2026-07-26)

Follow-up to [2026-07-26-session-visibility-and-login-diagnostics.md](2026-07-26-session-visibility-and-login-diagnostics.md),
whose closing "Open question" this document answers.

> **Correction (2026-07-26, shipped in 2.6.1) — read this before acting on the rest.**
> The conclusion below ("the egress IP decides the verdict") was drawn from **one sample per
> address**. Repeating the measurement — several navigations per address, spaced out in time —
> showed the verdict is decided **per navigation**, not per address, and that the outage had a
> nearer cause: the load path navigated once and then waited on the interstitial.
> See [Correction: the verdict is per navigation](#correction-the-verdict-is-per-navigation) at
> the end. The proxy support this document motivated is still useful, and the fingerprint
> findings still hold — but a proxy is not what this failure needed.

## Symptom

2.5.0 shipped the login diagnostics, and the first production start named the blocker on the
spot:

```
[load 59] title="Just a moment..." url="https://chatgpt.com/"
[load] page not ready after wait loop (title="Just a moment...") — failing fast (page_load_failed)
[startup] session warm-up failed (will retry on first request): Cloudflare challenge did not clear
```

`gpt_web_gateway_session_valid 0`. The owner confirmed the credentials were valid, so the
question was narrowed to: **what makes Cloudflare challenge us, and why does the challenge
never clear?**

## The hypothesis that was wrong

`src/browser.js` pinned a user agent claiming **macOS, Chrome 131**, while running headless
Chromium **145** on **Linux**. A UA that contradicts its own platform and client hints is a
cheap anti-bot signal, and that made it the leading suspect.

Measuring it refuted it.

### The pinned UA never reached the network

Captured from a real navigation to a local server, inside the production image:

| context `userAgent` | UA on the wire | `Sec-CH-UA-Platform` |
| --- | --- | --- |
| the pinned macOS Chrome/131 | `Windows NT 10.0 … Chrome/145.0.7632.6` | `"Windows"` |
| *(none — Playwright default)* | `Windows NT 10.0 … Chrome/145.0.7632.6` | `"Windows"` |

Byte-identical. `puppeteer-extra-plugin-stealth` installs a per-page
`Network.setUserAgentOverride`, which **beats** the context-level `userAgent` option — so the
pinned string was dead code. It was not harmless, though: see "What was still worth fixing".

This is a general property worth stating once, because it invalidates the obvious fix: while
stealth is alive, *any* `newContext({ userAgent })` is inert. A user agent this service wants
to control has to be installed **inside** the bundle, by replacing its own
`user-agent-override` evasion with a configured copy. Doing that works — a pinned
`Chrome/149` reaches the wire, brands and all — with one caveat: the evasion deliberately
masks Linux as Windows, so `X11; Linux x86_64 … Chrome/149` goes out as
`Windows NT 10.0; Win64; x64 … Chrome/149`. Version and brands are honoured, the platform is
rewritten, and the result stays internally consistent (UA, `Sec-CH-UA`, `navigator.platform`
all agree). Consistency is the property that matters, so it is left alone — and the
substitution is logged rather than hidden.

### What actually decides the verdict

Order-controlled trials against `https://chatgpt.com` (one container per trial, 45 s apart,
run order varied so "first hit from a warm IP" could not masquerade as a fingerprint effect):

| Stack | Headless | From `<dev-host>` | From the pod's `<prod-pod>` |
| --- | --- | --- | --- |
| playwright-extra + stealth, headless shell (**production**) | yes | **200 PASS** | **403 `cf-mitigated: challenge`** |
| playwright-extra + stealth, new headless (`channel: chromium`) | yes | **200 PASS** | **403 challenge** |
| vanilla Playwright, headless shell | yes | 403 challenge | — |
| vanilla Playwright, new headless | yes | 403 challenge | — |
| stealth, via authenticated proxy | yes | **200 PASS** | — |

Two findings, both reproducible:

1. **On a clean egress, the current stack passes.** The stealth *bundle* is what does it: with
   it, HTTP 200; without it, `403 cf-mitigated: challenge` — same host, same image, same
   minute.

   Worth stating precisely, because it is tempting to overclaim: this experiment does **not**
   isolate which evasion earns the 200. The obvious candidate is the `HeadlessChrome` token,
   which stealth strips from the UA — but in the configuration that passes,
   `navigator.userAgentData.getHighEntropyValues()` still reports
   `HeadlessChrome/145.0.7632.6` in `fullVersionList`. So the token is demonstrably not
   fatal by itself, and what we know is the weaker, still useful statement: **the bundle as a
   whole is required**, and a UA that has reverted to advertising headless is reliable
   evidence that the bundle has stopped applying.

2. **From the production pod, nothing passes.** The *same image*, driven by `kubectl exec` in
   the running pod, is challenged with the identical fingerprint that is served from another
   address. No fingerprint variant changed that.

So the block is not a fingerprint problem. It is the **egress IP**:

| | this host | production pod |
| --- | --- | --- |
| address | `<dev-host>` (DE, colo AMS) | `<prod-pod>` (FI, colo HEL) |
| network | — | Hetzner `AS24940`, netname `CLOUD-HEL1`, a /17 first registered 2026-02 |
| Cloudflare `sliver` | `none` | `010-tier2` |
| chatgpt.com | 200 | 403 challenge |

A freshly allocated hosting range carries no reputation and plenty of neighbours; Cloudflare
scores it low and serves a managed challenge that a headless browser cannot solve. The
gateway then burns its 60-iteration wait loop and fails — exactly the observed log.

## Was `patchright` the answer?

The strongest published claim is that the real detection vector is the CDP handshake
(`Runtime.enable`, `Console.enable`) rather than the JS fingerprint, and that
`puppeteer-extra-plugin-stealth` is therefore obsolete. `patchright` — a drop-in Playwright
fork that patches those protocol leaks — benchmarks well. It was tested rather than assumed:

| Configuration | Egress | Result |
| --- | --- | --- |
| patchright, bundled Chromium, **headless** | clean IP | **403 challenge** |
| patchright, real Google Chrome (`channel: "chrome"`), **headless** | clean IP | **403 challenge** |
| patchright, real Chrome, **headed** under Xvfb, persistent context | clean IP | **200 PASS** |
| playwright-extra + stealth, headless (**current**) | clean IP | **200 PASS** |

`patchright` does not neutralise the `HeadlessChrome` token — deliberately: its documentation
tells you not to set a custom user agent, because its supported configuration is
`channel: "chrome"` with `headless: false`, where the token does not exist. Run headless, as
this service must, it is **worse than what we already have**: blocked where the current stack
is served.

Reaching its passing configuration would mean shipping real Chrome in the image (~400 MB),
adding an X server process, running headed, and moving from `storageState` to persistent
contexts — and it would still be aimed at the wrong problem, since the measured blocker is
the address, not the protocol trace. `storageState()` does keep working under patchright
(verified: 7 cookies round-tripped), so the door is not closed; it is simply not today's fix.

**Verdict: not migrating.** The protocol-leak argument is plausible in general and untestable
as a cause here, because the stack that supposedly leaks is served HTTP 200 by the same
Cloudflare zone the moment it leaves from a different IP.

## What was still worth fixing

The hypothesis was wrong about the cause but right about the smell, and the investigation
turned up three real defects.

### 1. The pinned UA was a loaded gun

It is dead code *while stealth works*. If stealth ever stops applying — a version bump, a
`playwright-extra` incompatibility — that string becomes the only identity on the wire, and
it is measurably incoherent:

```
user-agent:         Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Chrome/131.0.0.0
sec-ch-ua:          "Not:A-Brand";v="99", "HeadlessChrome";v="145", "Chromium";v="145"
sec-ch-ua-platform: "macOS"
navigator.platform: "Linux x86_64"
```

Three mutually contradictory answers to "what am I?". The browser's own UA is at least
self-consistent. So the pin is gone: the context now sends **no** user agent and lets the
browser (as normalised by stealth) speak for itself. `BROWSER_USER_AGENT` remains as an
operator escape hatch.

### 2. Nothing checked that the evasions still worked

On the one egress where this gateway is served at all, stealth is what makes the difference
between HTTP 200 and a challenge (it was never tested on a *third* address, so "on any IP" is
more than the experiment supports). Its failure mode is silent — it soft-fails and the browser
simply starts announcing itself as headless. Every context now reports what a real page says
about itself:
`gpt_web_gateway_browser_ua_evasion_ok`, a warning line, and a coherent Linux Chrome fallback
identity for the case where the evasions are confirmed dead (and nothing is left to override
a context-level UA).

The gauge starts at **0** and only rises once a page has actually been asked — the same
"0 until confirmed" convention as `session_valid`. An unverified browser reading as healthy
is the exact class of bug this release exists to remove, and the earlier revision had it three
different ways: the `chrome` and `cdp` modes returned before any probe ran; a browser rebuild
inherited the previous run's value; and — most subtly — substituting the fallback identity
made the *final* user agent look clean, so the reading erased the failure that had just
triggered the substitution. The pre-context verdict now wins, and the state resets on every
rebuild.

The name is deliberately narrow. It tracks one observable — whether the effective
`navigator.userAgent` still carries a headless token — not the health of the fingerprint as a
whole. A `0` is strong evidence the bundle stopped applying; a `1` is not a clean bill of
health, since the passing configuration still leaks `HeadlessChrome` through the high-entropy
client hints.

**A fix that made things worse, kept here as the warning it is.** The first version of this
guard also injected matching `Sec-CH-UA*` headers via `extraHTTPHeaders`, reasoning that
Playwright derives the platform hint from a custom UA but not the brand list. Measured, that
was actively harmful: `extraHTTPHeaders` *does* take effect while the context `userAgent`
*does not*, so the pair put stealth's `Windows` user agent on the wire next to our own
`Sec-CH-UA-Platform: "Linux"` — a brand-new contradiction, created by the code meant to
remove one. A header that cannot be kept in sync with the UA is worse than the leak it
patches, so the fallback now moves the user agent only. There is a regression test.

### 3. Stealth mutates the shared launch-args array

`COMMON_CHROMIUM_ARGS` was a module-level array passed straight to `chromium.launch()`. The
plugin appends its own entry to the `--disable-blink-features=` flag *in place*, so every
browser restart grew it (measured after four launches:
`--disable-blink-features=AutomationControlled,AutomationControlled,AutomationControlled,AutomationControlled,AutomationControlled`).
Harmless in effect, unbounded in principle; each launch now gets a fresh copy.

## What ships in 2.6.0

- **`PROXY_SERVER` / `PROXY_USERNAME` / `PROXY_PASSWORD`** — route the browser out through a
  different address without a rebuild. This is the lever that addresses the measured cause.
  Verified end-to-end against chatgpt.com through an authenticated proxy, stealth intact.
  Three things fail loudly at startup instead of later and quietly: a malformed URL, an
  unsupported scheme, and **credentials on a SOCKS proxy** (Chromium implements proxy auth for
  HTTP(S) only — Playwright otherwise throws "Browser does not support socks5 proxy
  authentication" on the first launch).
- **A password cannot be logged by accident.** `playwright-extra` prints its full launch
  options under its own `debug` namespace, proxy password included (verified: the sentinel
  appeared twice in stderr). Startup now refuses a configured `PROXY_PASSWORD` together with a
  `DEBUG` value that enables that namespace, and says which one to change.
- **No pinned user agent**, plus the verification guard and the `BROWSER_USER_AGENT` override
  — which now actually works, by configuring the stealth evasion rather than being silently
  discarded by it.
- **`gpt_web_gateway_browser_ua_evasion_ok`** gauge and
  **`gpt_web_gateway_cloudflare_challenges_total`** counter.
- **Cloudflare diagnostics** on the `page_load_failed` path — one line carrying
  `cf-mitigated`, `cf-ray`/colo, the egress IP as Cloudflare reports it, whether a live
  `cf_clearance` cookie existed, and whether the UA was still clean, followed by a pointer to
  the more likely of the two causes. The next occurrence diagnoses itself. Detection keys on
  the `cf-mitigated` header first and the page title only as a fallback, and the whole
  collection — cookies included, not just the `evaluate` — sits behind a single Node-side
  deadline, because it runs on a page that has already proved it is unhealthy.
- **`CHROMIUM_CHANNEL`** — opt into the full Chromium build (new headless) without a code
  change. Left off by default: measured at ~722 MB resident against the headless shell's
  ~377 MB on an idle page, versus a 3 Gi limit that already peaks near 1.7 GiB, and it changed
  the Cloudflare outcome in neither direction.
- **`navigator.webdriver` hidden at context level**, so every page gets it rather than the two
  that remembered to ask.
- **`src/login.js` lost its own copy of the pinned macOS UA**, which had been missed on the
  first pass.

## Still open — needs the owner

Code cannot fix a distrusted IP. One of these has to happen:

1. **Route the browser through a cleaner egress** — set `PROXY_SERVER` (plus credentials) on
   the deployment. The host used throughout this investigation (`<dev-host>`) is served
   normally, and its proxy is already running; it is simply not reachable from the cluster
   (port filtered), so a firewall rule or a different proxy is required.
2. **Move the pod to a node with a different address.** The cluster spans two ranges —
   `<prod-/17>` (Hetzner `CLOUD-HEL1`, the blocked one) and `<alt-net-a>` /
   `<alt-net-b>` on the `<alt-node-pool>` nodes. Whether the latter is treated better is **untested**
   — nothing in the cluster could originate a browser request from it — but a `nodeSelector`
   is a cheap experiment and needs no code change.
3. **Log in once by hand via `/login`** from a browser that Cloudflare trusts, so the session
   cookies (and a `cf_clearance`) land on the auth volume. This unblocks the service but does
   not stop the next expiry from repeating the outage, since the automated re-login still has
   to pass the same challenge.

Option 1 or 2 is the durable fix; 3 is the stopgap.

## Reproducing

The probes used here are deliberately not committed — they are throwaway harnesses, and
`tmp/` is git-ignored. The method, though, is worth keeping:

- one container per trial, several tens of seconds apart, with the **run order varied**;
  Cloudflare shapes per-IP request rate, and a naive sequential loop reports the first trial
  as the winner regardless of what it is testing (this happened, and inverted the conclusion);
- always compare the *same* code from *two* egresses before blaming a fingerprint;
- `https://chatgpt.com/cdn-cgi/trace` reports the address and the `sliver` tier Cloudflare
  assigns — the cheapest reputation signal available;
- `kubectl exec` into the running pod is enough to test the production egress, and needs no
  new workload.

## Correction: the verdict is per navigation

Everything above rests on one sample per address. That is exactly the sampling error the
"Reproducing" section warns about, and it caught this investigation too.

Re-measuring with **repeated navigations per address, spaced a minute apart**, gives a
different shape (each row is one fresh browser, same stealth stack, same image):

| Egress | Attempt 1 | Attempt 2 (+60 s) | Immediate follow-ups |
|---|---|---|---|
| production pod `<prod-pod>` | 403 challenge | **200** | 200, 200, 200 |
| proxy `<proxy>` | 403 challenge | **200** | 200, 200, 200 |
| host `<other-host>` | 200 (first ever visit) | 403 an hour later | — |
| 15-proxy pool, one visit each | 4 × 200, 11 × 403 | — | — |

Three conclusions, in order of how much they change what to do:

1. **The pod's own address is not blacklisted.** It is challenged on one navigation and served
   200 on the next. The "freshly allocated hosting range, `sliver=010-tier2`" reading of the
   original measurement was over-fitted to a single sample.
2. **Once a navigation gets through, the access holds.** Three immediate follow-up navigations
   in the same context were all 200 — the service only ever needed *one* window.
3. **The bug was in our load path.** It navigated **once**, then sat on the interstitial for
   60 × 2 s and failed. That page does not clear itself for this browser, so the process could
   never take the next window: the challenge was recoverable, and we never retried.

A control rules out "the stealth stack is simply detected": from the same address, in the same
minute, `https://lowendtalk.com/` (also behind Cloudflare) is served **200** while
`chatgpt.com` is challenged. The evasions work; the chatgpt.com zone is just strict.

### What shipped instead of a proxy

2.6.1 retries the navigation (`CF_LOAD_ATTEMPTS`, `CF_RETRY_GAP_SEC`) and caps the time spent
on the interstitial (`CF_CHALLENGE_GRACE_SEC`). The policy is pure and unit-tested in
`src/cloudflare.js` / `scripts/test-cloudflare.js`.

`PROXY_SERVER` from 2.6.0 stays — it is the right tool for an address that really is
distrusted, and it is now measured rather than assumed. It is simply not what this outage
needed, and a proxy adds a dependency (and, for a shared pool, spreads the automation's
reputation cost onto whatever else uses those addresses).

### Method note

Two mistakes worth not repeating, both mine:

- **One sample per condition is not a measurement** when the system under test is
  probabilistic. The first pass looked decisive precisely because every address was tried once.
- **A "clean IP" result decays.** The host that returned 200 at 16:19 returned 403 at 17:15,
  which briefly looked like "the IP burns after one automated visit". Repeating on a rested
  address showed the simpler truth: passes are sporadic, and the way to get one is to ask
  again.

### Follow-up this release does NOT do

`CF_LOAD_BUDGET_SEC` bounds one page-load sequence. It does not bound a request: the text
turn may re-enter that sequence up to `CHATGPT_TEXT_RETRY_ATTEMPTS` times before submit, and
an auto-login carries navigation budgets of its own. A request-level deadline — threaded
through the queue, the login flow and the retries, resetting the page when it fires — is the
real fix and is deliberately left as its own change. Until it exists, the honest statement is
the one in the tests: a single page load fits beside the answer wait, nothing stronger.
