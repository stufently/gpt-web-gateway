# gpt-web-gateway

OpenAI-compatible API gateway backed by the **ChatGPT.com web UI**. A headless
Real Google Chrome (patchright — a patched Playwright fork) drives a real ChatGPT session and exposes
it as familiar REST endpoints: chat completions (with thinking modes), image
generation and image editing.

> **Read the [Disclaimer](#disclaimer) before using this project.** Automating
> the ChatGPT web UI violates OpenAI's Terms of Use and can get the account
> banned. Use a dedicated account with its own Plus/Pro subscription.

## Why this instead of chat2api-style projects

Most "ChatGPT as API" projects reverse-engineer the private `backend-api`
endpoints. That approach is fast but brittle: every token-format or endpoint
change breaks it. This project takes the other trade-off — it runs the **real
browser UI** with real Google Chrome driven by patchright:

- **Survives redesigns better** — it clicks what a human clicks; selectors are
  written with multiple fallbacks (EN + RU UI strings) and a capabilities probe
  reports what the current UI actually supports.
- **Images** — generation *and* editing (multipart uploads, reference images,
  batches up to 10, aspect ratios) through the same UI a Plus user sees.
- **Thinking modes** — instant / standard / extended mapped onto the ChatGPT
  "intelligence" picker, with an `applied` echo block so clients can verify
  what was really activated.
- **Operational hardening** — request queue with `Retry-After`, typed errors
  (`error_kind` / `should_retry` / verbatim `model_message`), Prometheus
  metrics, liveness endpoint with stuck-detection and self-healing browser
  resets, adaptive timeouts that only extend while the page shows live
  progress.

## Quickstart

> **Never expose this gateway without authentication.** With `API_KEY` unset the
> gateway is open, and `/login` is not a login form — it is a remote-control
> surface for the browser: screenshots out, clicks, keystrokes and "save session"
> in. Anyone who can reach that path can drive a browser that is already signed
> in to your ChatGPT account, read your conversations and take the session
> cookies with them. Set `API_KEY`, put auth on your reverse proxy, or bind the
> port to localhost — and note that `/`, `/images/*`, `/health` and `/metrics`
> stay outside `API_KEY` by design, so a public deployment needs the proxy.

### 1. Docker run

```bash
docker build -t gpt-web-gateway .
docker run -d --name gpt-web-gateway \
  -p 3000:3000 \
  -v "$PWD/auth:/app/auth" \
  -v "$PWD/images:/app/public/images" \
  -e HEADLESS=false \
  -e API_KEY=change-me \
  gpt-web-gateway
```

### 2. docker-compose

```bash
cp .env.example .env   # set API_KEY and (optionally) auto-login credentials
docker compose up -d
```

### 3. Log in once

Open `http://localhost:3000/login` — a remote-login UI streams browser
screenshots so you can complete the ChatGPT login (including SSO/2FA) on a
headless server. The session is persisted to the `auth/` volume.

Alternatively, set `CHATGPT_EMAIL`, `CHATGPT_PASSWORD` and (for 2FA)
`CHATGPT_TOTP_SECRET` — the gateway logs in automatically and re-logs-in when
the session expires.

### 4. Use it

```bash
# Chat completion
curl -u "api:$API_KEY" -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Answer with one word: OK"}],"thinking_mode":"instant"}'

# Image generation
curl -u "api:$API_KEY" -X POST http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a red sports car on a mountain road, photorealistic","aspect_ratio":"16:9"}'
```

Works with the OpenAI SDK too:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="change-me")
result = client.images.generate(prompt="a cat in space", n=1)
print(result.data[0].url)
```

## Endpoints

| Method | Path | Description | Auth (`API_KEY` set) |
|---|---|---|---|
| POST | `/v1/chat/completions` | Chat Completions-compatible text chat; `thinking_mode`: `instant` / `standard` / `extended` / `extra_high` / `pro`; optional `conversation_id` (multi-turn) and `stream: true` (SSE; needs backend-api reading, which is enabled by default) | yes |
| POST | `/v1/responses` | Minimal Responses-style endpoint (`input` → `output_text`) | yes |
| POST | `/v1/images/generations` | Image generation: `n` 1..10, `aspect_ratio`, `reference_images`, `quality`, `output_format`, `response_format` (`url` / `b64_json`) | yes |
| POST | `/v1/images/edits` | Image editing: multipart (`image` + optional `reference_images[]`) or legacy JSON+base64 | yes |
| GET | `/v1/images/capabilities` | Probe: which toggles the current ChatGPT UI actually exposes (cached 60 s) | yes |
| GET | `/v1/images/status` | Queue size, rate-limit state, batch metrics | yes |
| GET | `/health` | Readiness: process is up | no |
| GET | `/health/live` | Liveness: 503 when the browser layer is stuck or N consecutive infra failures (pair with a restart policy) | no |
| GET | `/metrics` | Prometheus metrics (counters, error types, duration histogram) | no |
| GET | `/login` | Remote-login web UI (screenshot stream) | yes (Basic prompt in browsers) |
| GET | `/` | Simple web UI for generation/editing | no* |

\* the web UI at `/` and generated images under `/images/` are not covered by
`API_KEY` — protect them at your reverse proxy if the gateway is exposed
publicly. Generated images are served to anyone who knows (or guesses) the id,
and they are never expired: give the volume a retention policy of your own if
the prompts that produced them are sensitive.

All responses include an `applied` echo block (what was really activated in the
UI, e.g. `applied.thinking_verified`) next to `requested`, so clients can
detect silent degradation when the ChatGPT UI changes.

### Automatic tier downgrade (Pro → Extra High)

The Pro tier has its own quota and it runs out. When a `thinking_mode=pro`
request cannot actually get Pro, the gateway serves it on the next tier down
rather than running at whatever level the composer happened to show:

```jsonc
"applied":   { "thinking_mode": "extra_high",   // what really ran
               "thinking_verified": true,       // ...and the UI confirmed it
               "requested_verified": false,     // but it is NOT what was asked for
               "thinking_fallback": { "from": "pro", "to": "extra_high",
                                      "reason": "quota", "verified": true } },
"requested": { "thinking_mode": "pro" }         // unchanged: what the caller asked
```

`thinking_verified` refers to `applied.thinking_mode`. After a downgrade it is
`true` because Extra High really is active — read `requested_verified` (or the
presence of `thinking_fallback`) to know whether the requested tier was applied.

`reason` is one of `quota` / `disabled` / `not-offered` / `click-not-applied` /
`cooldown:<earlier reason>`. Only strong evidence memoizes the tier as gone
(`TIER_UNAVAILABLE_COOLDOWN_SEC`): an explicitly disabled item or the post-submit
limit notice immediately, a missing menu item after two consecutive sightings, a
single unverified click never. A memo never overrides reality — if the pill
already shows Pro, Pro is used and the memo is dropped.

Two limits worth knowing:

- **The downgrade is decided before the prompt is sent.** If ChatGPT only reveals
  the exhausted quota *after* submission (a limit notice instead of an answer),
  that request fails with `error_kind: tier_limit` (HTTP 503, `should_retry:
  true`) — the prompt is already submitted, and re-sending it silently is how you
  get duplicate generations. The tier is memoized at that moment, so a retry and
  every request after it are downgraded automatically. On an image turn the same
  notice is told apart from the image-creation limit, so it raises `tier_limit`
  rather than the global-cooldown `rate_limit`.
- **A batch (`n > 1`) can straddle the boundary.** `thinking_verified` and
  `requested_verified` are true only if *every* image confirmed it, and
  `applied.thinking_mode_mixed` marks a batch whose images did not all run on the
  same tier (`applied.thinking_mode` then describes the first one).
- `tier_limit` is deliberately **not** `rate_limit`: that kind arms a global
  cooldown that blocks every endpoint for 30 minutes, while this affects one tier.

Set `TIER_FALLBACK_PRO=off` to disable the downgrade entirely.

### Multi-turn conversations (`conversation_id`)

Text responses from `/v1/chat/completions` and `/v1/responses` always include a
top-level `conversation_id` (the ChatGPT conversation UUID, or `null` when it
could not be determined). Pass it back in the next request to continue the same
conversation instead of starting a new chat:

```bash
curl -s localhost:3000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"My name is Ada. Remember it."}]}'
# → { ..., "conversation_id": "1f0e4b2a-...", ... }

curl -s localhost:3000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"conversation_id":"1f0e4b2a-...","messages":[{"role":"user","content":"What is my name?"}]}'
```

Notes:

- Backward compatible: omit `conversation_id` and every request is a fresh chat
  (previous behavior, unchanged).
- The id must be a UUID exactly as returned earlier — anything else is rejected
  with 400 (`invalid_request`).
- Conversations live **inside the logged-in ChatGPT account**: ids from another
  account (or deleted chats) fail with `page_load_failed`. Treat the id as valid
  only for the lifetime of that account session.
- When continuing a conversation, send only the NEW user message — the history
  already lives in the ChatGPT chat itself.

### Streaming (`stream: true`)

`POST /v1/chat/completions` accepts OpenAI-style `stream: true` and answers with
`text/event-stream` of `chat.completion.chunk` events (`delta.content` pieces,
then a `finish_reason: "stop"` chunk carrying `conversation_id`, then
`data: [DONE]`). Errors after the stream started are sent as a terminal
`data: {"error": ...}` event.

Streaming requires backend-api reading (`READ_VIA_BACKEND_API`, on by default) —
the intercepted backend-api SSE deltas are the streaming source. If the server
was started with `READ_VIA_BACKEND_API=0`, `stream: true` is rejected with 400
instead of faking a stream. `/v1/responses` does not support streaming.

### Advanced features

These automate unofficial ChatGPT internals (`/backend-api/*`); endpoints may
drift with ChatGPT updates, so each one degrades gracefully (logs + fallback to
the default path) when it fails. All of them were verified against the live
ChatGPT UI on 2026-07-18 (answer source, multi-turn context carry-over, SSE
chunks, trim route rewrite, memory PATCH, image generation with interception
active, and the DOM-only fallback path).

| Flag | What it does |
|---|---|
| `READ_VIA_BACKEND_API` (**on** by default; `0` to disable) | Read assistant answers passively from ChatGPT's own backend-api traffic (`page.on('response')` + an injected `fetch` tee for live SSE deltas) instead of scraping the DOM. More robust against UI redesigns; the DOM extractor remains the fallback. Prerequisite for `stream: true`. |
| `CONVERSATION_TRIM_LIMIT=N` (off by default) | Rewrite `GET /backend-api/conversation/{id}` responses via `page.route()` so ChatGPT renders only the last N messages of the active branch — long conversations stop freezing the tab (matters for multi-turn `conversation_id` reuse). Client-side load optimization only: the server-side conversation context is untouched. `0` = off. |
| `DISABLE_CHATGPT_MEMORY=1` (off by default — **account-wide** side effect, deliberate opt-in) | Once per process, PATCH the account settings that control ChatGPT "memory" to `false`, so chat history stops leaking into answers (more deterministic, closer to a stateless API). Verified: "reference chat history" toggles fine (200); "saved memories" (`sunshine`) can be server-gated (403 on some accounts) — disable that one manually in ChatGPT settings if needed. Best-effort with logging, never a hard failure; the setting is not switched back automatically. |

### Error format

Every endpoint returns a uniform error shape:

```json
{
  "ok": false,
  "error_kind": "refused",
  "should_retry": false,
  "model_message": "verbatim refusal/banner text from the ChatGPT UI",
  "error": { "message": "...", "type": "server_error" }
}
```

| HTTP | `error_kind` | `should_retry` |
|---|---|---|
| 400 | `invalid_request` | false |
| 401 | `unauthorized` | false |
| 404 | `conversation_not_found` | false — the `conversation_id` does not exist or belongs to another account |
| 503 | `tier_limit` | true — the requested tier's quota is exhausted (reported only after submit); the retry is served on the fallback tier |
| 422 | `refused` / `policy_violation` | **false** — change the prompt |
| 429 | `rate_limit` | false — wait `Retry-After` |
| 429 | `queue_full` | true |
| 500 | `server_error` | true |
| 503 | `login_failed` / `upload_failed` / `page_load_failed` | true |
| 504 | `timeout` | true |

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `API_KEY` | Optional app-level auth for `/v1/*` and `/login/*`: accepts `Bearer <API_KEY>` or Basic auth with any username and `API_KEY` as password. Unset = open (put auth on your reverse proxy). `/health` and `/metrics` are always open | — |
| `BROWSER_MODE` | `default` (Playwright Chromium + saved session), `chrome` (system Chrome profile), `cdp` (attach to a running Chrome) | `default` |
| `HEADLESS` | Headless browser mode. **Keep this `false`.** A headless build is an anti-bot signal that no JS-level evasion fixes; the image runs the browser headed under Xvfb, so no display is needed | `false` |
| `CDP_URL` | CDP endpoint for `BROWSER_MODE=cdp` | `http://127.0.0.1:9222` |
| `CHROME_USER_DATA_DIR` | Chrome profile dir for `BROWSER_MODE=chrome` (auto-detected if empty) | — |
| `CHROME_PROFILE` | Chrome profile name for `BROWSER_MODE=chrome` | `Default` |
| `PROXY_SERVER` | Route the browser's traffic through a proxy (`http://`, `https://`, `socks5://`, `socks4://`; credentials may be embedded). Useful against a genuinely distrusted egress address, but **not the first thing to reach for on a Cloudflare challenge** — that verdict is decided per navigation, and the retry below clears it without a proxy (see [docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md](docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md)). A malformed value fails at startup rather than silently sending traffic out of the address you were trying to avoid. Not applied when `BROWSER_MODE=cdp` (launch that Chrome with `--proxy-server=`) | — (direct) |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | Proxy credentials; override anything embedded in `PROXY_SERVER`. **HTTP(S) proxies only** — Chromium does not implement SOCKS proxy authentication, so credentials on a `socks*://` server are rejected at startup instead of failing on first launch. Not logged by this service; startup also refuses to run with a password if `DEBUG` enables `playwright-extra`, which prints its launch options verbatim | — |
| `BROWSER_USER_AGENT` | Pin the browser's user agent. **Normally leave unset** — the context deliberately sends no UA of its own so the browser (as rewritten by the stealth bundle) stays self-consistent, and a pin that disagrees with the platform or the client hints is an anti-bot signal rather than a disguise. When set, it is installed *inside* the stealth bundle so it actually takes effect; note that bundle's user-agent evasion deliberately masks Linux as Windows, so the platform part of what you pin is rewritten (coherently) — the substitution is logged, and `/metrics` reports what the page really advertises | — (browser's own) |
| `CF_LOAD_ATTEMPTS` | How many times to navigate to ChatGPT before giving up on a Cloudflare challenge. The verdict is decided **per navigation** — the same address challenged now is served 200 a minute later — so a fresh `goto` is what clears it, and waiting on the interstitial is not. Keep it consistent with `CF_LOAD_BUDGET_SEC` — a budget too small for the configured attempts makes the last ones unreachable. Both measured recoveries came on the second navigation | `2` |
| `CF_RETRY_GAP_SEC` | Pause before the next navigation attempt; grows linearly (45 → 67 → 90 s by default) | `45` |
| `CF_CHALLENGE_GRACE_SEC` | How long to stay on the interstitial before re-navigating. A challenge that clears itself does so in seconds; beyond that the budget belongs to the retries | `15` |
| `CF_LOAD_BUDGET_SEC` | Wall-clock ceiling for the whole sequence, **navigations included** — the attempt count alone does not bound time. It is the first term of the timeout ladder: `90 + CHAT_COMPLETION_TIMEOUT_SEC + CHAT_COMPLETION_RETRY_TIMEOUT_SEC` must stay under the ingress `proxy-read-timeout` (960), which must stay under the client's own budget (`chat.sh --max-time 1020`). Raise any one of them only together with the ones outside it, or nginx cuts the connection first and the caller gets its bare 504 instead of the gateway's typed error | `90` |
| `LOGIN_FIELD_TIMEOUT_SEC` | How long a post-submit login field gets to appear, **including** the time to clear a Cloudflare checkbox standing in front of it. Was a hard-coded 15 s, which is what turned the 2026-07-27 challenge into an outage: the wait expired in front of a "Verify you are human" widget and the failure was filed against the password field. A solve is the click plus ~15 s of settling, so the budget has to be able to contain one. Floored at 15 | `60` |
| `CF_TURNSTILE_BUDGET_SEC` | Ceiling for one attempt at clicking the interactive Cloudflare checkbox on the page-load path. Kept well under a retry gap: the click is cheap, and the point is to try it before burning a navigation, not to replace the navigation with a long wait | `20` |
| `BROWSER_ENGINE` | Which driver launches the browser. `patchright` = the maintained Playwright fork driving **real Google Chrome**: patches the `Runtime.enable` / `Console.enable` CDP leaks and produces a fingerprint where every layer agrees (`X11; Linux x86_64`, `platform: "Linux"`, no headless token — including in the high-entropy client hints). `stealth` = the pre-2.11.0 `playwright-extra` + `puppeteer-extra-plugin-stealth` path, kept for rollback; the image ships both browsers, so switching back needs no rebuild. An unrecognised value is rejected at startup | `patchright` |
| `CHROMIUM_CHANNEL` | Which browser build to drive. Normally leave unset — it follows `BROWSER_ENGINE` (`patchright` → `chrome`, `stealth` → Playwright's bundled headless shell). An explicit value **overrides that**, so setting `chromium` under patchright selects the combination measured at `403` against chatgpt.com | — (follows the engine) |
| `CHATGPT_EMAIL` | ChatGPT account email (enables auto-login) | — |
| `CHATGPT_PASSWORD` | ChatGPT account password (auto-login) | — |
| `CHATGPT_TOTP_SECRET` | Base32 TOTP secret for 2FA (auto-login) | — |
| `MAX_QUEUE_SIZE` | Max queued requests; above this the gateway replies 429 `queue_full` | `5` |
| `MAX_BATCH_N` | Upper bound for `n` in one generation request | `10` |
| `MAX_UPLOAD_BYTES` | Per-file upload limit for edits/references | `52428800` (50 MB) |
| `QUEUE_FULL_RETRY_AFTER_SEC` | `Retry-After` when the queue is full | `60` |
| `RATE_LIMIT_COOLDOWN_MINUTES` | Cooldown after ChatGPT rate-limits the account — **reactive**, it arms only once ChatGPT has already refused | `30` |
| `MIN_JOB_GAP_SEC` | **Proactive** pacing: minimum idle time between one **upstream turn** finishing and the next starting — a batch request of `n` images pays it `n-1` times, not once. Measured from the finish, not the start: a gap measured from the start does nothing when the turn itself runs longer than the gap, and these turns take a minute or more each. Waiting happens inside the queue slot (so a waiting request keeps its place and callers see ordinary `queue_full` backpressure) and beats a heartbeat, so a deliberate pause is not mistaken for a hang. `0` disables pacing. Current state is visible in `GET /v1/images/status` under `pacing` | `60` |
| `GENERATION_TIMEOUT_SEC` | First wait window for an image | `240` |
| `GENERATION_RETRY_TIMEOUT_SEC` | Size of one adaptive extension, granted only while the page shows live generation progress (stop button / "creating image") | `90` |
| `GENERATION_MAX_TIMEOUT_SEC` | Hard ceiling for the whole image wait (first window + all extensions). Keep ≤ your proxy read timeout | `600` |
| `RENDER_WAIT_SEC` | Extra wait after "Image created" before extraction | `15` |
| `UPLOAD_MAX_ATTEMPTS` | Retries for attaching files to the composer before failing `upload_failed` | `3` |
| `CAPABILITIES_CACHE_TTL_MS` | Cache TTL for `/v1/images/capabilities` probe | `60000` |
| `CHAT_COMPLETION_TIMEOUT_SEC` | Base wait for a text answer. The cluster runs **600** for the Extra High / Pro tiers, which think for minutes; see the ladder note on `CF_LOAD_BUDGET_SEC` before changing it | `360` |
| `TIER_FALLBACK_PRO` | Tier used when `thinking_mode=pro` cannot be applied. `off`/`none`/empty disables the downgrade | `extra_high` |
| `TIER_UNAVAILABLE_COOLDOWN_SEC` | How long a tier proven unavailable is skipped outright. Cleared early on a successful selection. `0` = re-probe every request | `900` |
| `CHAT_COMPLETION_RETRY_TIMEOUT_SEC` | One-time adaptive extension for text, granted only while the model is visibly streaming/thinking. Cluster runs **180** | `120` |
| `CHAT_STALL_WINDOW_SEC` | Stuck-guard: extensions require page/text change within the last N s (×2 for thinking modes). A frozen page with a stop button is not "live" | `120` |
| `CHAT_STREAM_RESCUE_SEC` | Grace window to rescue a response that is still streaming at the deadline | `60` |
| `CHATGPT_TEXT_RETRY_ATTEMPTS` | Attempts for `page_load_failed` transients (fresh page → full browser rebuild) | `4` |
| `CHATGPT_TEXT_HARD_RESET` | Allow full browser-context rebuild on repeated `page_load_failed` (auto-off in `cdp` mode) | `true` |
| `HEALTH_STUCK_SEC` | Liveness: queued work without heartbeat for N s → `/health/live` 503 | `900` |
| `HEALTH_FAILURE_STREAK` | Liveness: N consecutive infra failures → `/health/live` 503 (`refused`/`rate_limit` reset the streak) | `3` |
| `SESSION_WATCHDOG` | Traffic-independent session check that keeps `gpt_web_gateway_session_valid` fresh (`0`/`false` to disable) | **on** |
| `SESSION_WATCHDOG_INTERVAL_SEC` | How often the watchdog checks the session (skipped while a job runs / a login is in flight / traffic already proved it valid) | `300` |
| `SESSION_PROBE_ATTEMPTS` | Attempts against `/api/auth/session` before the check is considered inconclusive | `3` |
| `SESSION_PROBE_TIMEOUT_SEC` | Per-attempt budget for the `/api/auth/session` probe | `4` |
| `SESSION_PROBE_RETRY_DELAY_MS` | Pause between probe attempts | `500` |
| `SESSION_PROBE_DEADLINE_SLACK_MS` | Extra grace before Node gives up on `page.evaluate` itself (the in-page abort timer cannot fire on a wedged renderer) | `2000` |
| `SESSION_LEASE_WAIT_MS` | Hard cap on how long a request waits for an in-flight watchdog probe to release the page | `15000` |
| `SESSION_PROBE_DOM_TIMEOUT_MS` | Last-resort wait for a *logged-out* DOM marker when the endpoint is unreachable | `2000` |
| `SESSION_UNKNOWN_ESCALATE` | Consecutive *inconclusive* checks before escalating to a non-destructive browser-context rebuild (cookies preserved). Below the threshold the request is refused with a retryable `login_failed`. Inconclusiveness never triggers a re-login — only a *confirmed* logout does | `3` |
| `CONTEXT_RESET_COOLDOWN_SEC` | Minimum gap between non-destructive context rebuilds. A session that stays unverifiable keeps qualifying for one, so without this the browser would be rebuilt on every request | `60` |
| `PAGE_CLOSE_DEADLINE_MS` | Hard cap on waiting for a stale page to close before its replacement is built (a wedged renderer can hang `close()` forever) | `5000` |
| `SESSION_SAVE_DEADLINE_MS` | Hard cap on the best-effort `storageState` save taken before a context rebuild, so cookies newer than the last `session.json` snapshot are not rolled back | `5000` |
| `AUTO_LOGIN_RETRY_COOLDOWN_SEC` | After a failed auto-login, don't retry the login for N s (a blocked login screen stays blocked; retrying per request only burns attempts) | `120` |
| `LOGIN_DIAG_DIR` | Where auto-login failure screenshots + JSON reports are written. Must be on a volume that survives a restart | `auth/diag` |
| `LOGIN_DIAG_KEEP` | How many failed-login incidents to keep (older ones are rotated out) | `5` |
| `LOGIN_DIAG_SCREENSHOTS` | Write a screenshot alongside the JSON report (`0` = report only) | **on** |
| `LOGIN_DIAG_TIMEOUT_MS` | Deadline for collecting page diagnostics — a wedged renderer must not hang the login path | `5000` |
| `READ_VIA_BACKEND_API` | Read answers from intercepted backend-api traffic instead of DOM scraping (DOM stays the fallback). Required for `stream: true`; `0` = DOM-only | **on** |
| `CONVERSATION_TRIM_LIMIT` | Trim reopened conversations to the last N messages of the active branch (`page.route()` rewrite; client-side load optimization, server context untouched). `0` = off | `0` |
| `DISABLE_CHATGPT_MEMORY` | Disable ChatGPT account memory once at session start (unofficial settings PATCH, best-effort, **account-wide**) | off |
| `DEBUG_SNAPSHOTS` | Dump screenshot+HTML on failures (`1`/`true`). Snapshots may contain prompts — opt-in | off |
| `DEBUG_SNAPSHOT_DIR` | Where to write debug snapshots | `/tmp/chatgpt-debug` |

## Deployment notes

- **Volumes**: `auth/` holds the ChatGPT session cookies — treat it like a
  password and keep the volume private. It also holds `auth/diag/`, the rotated
  auto-login failure reports (see below), which is why they survive a restart.
  `public/images/` holds generated images served at `/images/<id>.png`.
- **Kubernetes**: an example Helm chart lives in [`helm/`](helm/) (ingress with
  Basic auth, PVCs for session+images, liveness probe on `/health/live`).
  Values are generic placeholders — set your own registry and host.
- **Memory**: the chart requests 1 Gi and limits 3 Gi. Chromium alone peaked at
  ~1.7 GiB over 48 h of light production traffic, so a 2 Gi limit leaves very
  little headroom for a long batch.
- **Prometheus**: metrics are emitted under the `gpt_web_gateway_*` prefix
  (kept stable for dashboard compatibility).

### Monitoring: is the gateway actually logged in?

`/health` and `/health/live` deliberately do **not** depend on the ChatGPT
session (a dead session must not remove the only replica from the Service, and a
restart does not fix an expired cookie anyway). So a pod can be `Running`, both
probes 200, and every real request still failing — that exact combination hid a
34 h outage on 2026-07-25.

The session state is exported instead:

| Metric | Meaning |
|---|---|
| `gpt_web_gateway_session_valid` | `1` = the last conclusive check said "logged in", `0` = confirmed logged out, or nothing confirmed since boot |
| `gpt_web_gateway_session_check_age_seconds` | Age of the last **conclusive** check. Grows while checks are inconclusive (e.g. `/api/auth/session` unreachable) |
| `gpt_web_gateway_session_checks_total{result="in\|out\|unknown"}` | Check outcomes |
| `gpt_web_gateway_login_failures_total{blocker="…"}` | Auto-login failures by the screen that blocked them: `cloudflare_challenge`, `captcha`, `rate_limited`, `credentials_rejected`, `device_verification`, `mfa_required`, `login_form_changed`, `unknown` |
| `gpt_web_gateway_browser_ua_evasion_ok` | `1` = a real page reported a user agent with no headless token; `0` = it still advertises a headless build **or nothing has been verified yet** (same "0 until confirmed" convention as `session_valid`). A `0` is strong evidence the stealth evasions stopped applying — with them the gateway is served HTTP 200, without them `403 cf-mitigated: challenge` from the same host. A `1` is *not* a clean bill of health for the whole fingerprint: the passing configuration still leaks `HeadlessChrome` through `userAgentData` high-entropy hints. Worth an alert on `0` |
| `gpt_web_gateway_cloudflare_challenges_total` | Page loads abandoned on a Cloudflare challenge that never cleared. Rising while `browser_ua_evasion_ok` is `1` means the one fingerprint symptom we can observe is absent — so the **egress IP** is the next thing to test (run the same image from another address and compare), not a proven diagnosis |

Recommended alert: `gpt_web_gateway_session_valid == 0` for ~10 min (critical —
nothing will work until the session is restored), optionally paired with
`gpt_web_gateway_session_check_age_seconds > 1800` (we have not been able to
*tell* for half an hour).

The value is refreshed by every request and, independently of traffic, by a
watchdog every `SESSION_WATCHDOG_INTERVAL_SEC`. The watchdog is read-only: it
issues the same `GET /api/auth/session` the app already makes, from the page
that is already open — it never navigates, clicks, clears cookies or logs in.
It skips a tick entirely while a job is queued or a login is in flight, so it
cannot interleave with a request.

**When it fires**, check the pod log for `[auto-login] BLOCKED by <blocker>` and
the artifacts in `auth/diag/`: each failed login writes
`login-fail-<timestamp>-<step>.json` (URL, on-page banners, visible buttons,
which inputs were present) plus a screenshot with form fields and any plaintext
occurrence of the configured e-mail masked. Credentials, e-mail addresses and
auth tokens are redacted from every field. The same class is returned to the
caller as `login_blocker` / `login_step` in the error body. A session that cannot
be re-established headlessly (captcha, device verification) needs a manual pass
through the `/login` UI.

**What happens on a session the gateway cannot verify** (e.g. `/api/auth/session`
unreachable): the page is rebuilt and re-probed once before the verdict is accepted
at all. A page that has been sitting idle gets its in-page XHRs challenged while a
freshly navigated one does not, so an inconclusive answer is usually a stale page
rather than a dead session — re-navigating turns it back into a definitive one.

If it is still inconclusive, the request fails closed with a retryable `login_failed`
and the cookies are left untouched. After `SESSION_UNKNOWN_ESCALATE` inconclusive
checks in a row the browser context is rebuilt from `session.json` — non-destructive,
the cookies survive — so a permanently unverifiable session cannot wedge the gateway
forever. Only a *confirmed* logout ever re-logs in, because that is the only state
that justifies `clearSession()`; escalating on inconclusiveness used to wipe a live
session and then fail to log back in, since a clean login is what Turnstile blocks.

## Limitations

- **One request at a time.** The gateway serializes work through a single
  browser session (queue up to `MAX_QUEUE_SIZE`). It is a personal/team
  gateway, not a high-throughput proxy.
- **Streaming needs backend-api reading.** `stream: true` works only while
  `READ_VIA_BACKEND_API` is enabled (the default; see "Advanced features");
  images do not stream.
- **Multi-turn is chat-only.** `conversation_id` continues text conversations;
  image requests are a fresh chat each time (batch image requests share one
  chat for consistency).
- **UI coupling.** OpenAI redesigns the ChatGPT UI regularly; selectors have
  fallbacks and the capabilities probe reports drift, but breakage is possible
  at any time.
- **Your account's limits apply.** This does not bypass OpenAI rate limits or
  paywalls — you need your own Plus/Pro subscription, and the gateway applies
  cooldowns when ChatGPT rate-limits the account.
- Model choice is not exposed; the `model` field is accepted and ignored.

## Disclaimer

This project automates the ChatGPT **web interface**, which **violates
OpenAI's Terms of Use** (automated access outside the official API). Using it
may get the ChatGPT account **suspended or banned without warning**.

- Use a **dedicated account**, never your main one.
- You need your **own paid subscription** (Plus/Pro); this is not a way to
  avoid paying OpenAI.
- The session cookies stored in `auth/` grant full access to the account —
  keep that volume private and never commit it.
- Provided **as-is**, for educational purposes, with **no warranty** of any
  kind. You are solely responsible for how you use it.

See [SECURITY.md](SECURITY.md) for security notes and reporting.

## Development

```bash
# Install deps once (tests import modules that require playwright-extra,
# but never launch a browser — skip the browser download)
docker run --rm -v "$PWD":/app -w /app -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node:20-slim npm ci --omit=dev

# Run tests (pure node:assert scripts, no browser needed)
docker run --rm -v "$PWD":/app -w /app node:20-slim npm test
```

## License

[MIT](LICENSE)
