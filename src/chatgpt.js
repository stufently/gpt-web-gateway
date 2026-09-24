const { getContext, saveSession, closeBrowser, browserFingerprint, maybeHideWebdriverOnPage } = require('./browser');
const { autoLogin } = require('./auto-login');
const {
  sessionHealth, createLoginThrottle, recordLoginFailure, decideSessionAction, shouldRebuildContext,
} = require('./session-health');
const { normalizeThinkingMode, envFlag } = require('./params');
const {
  looksLikeCloudflareChallenge, titleSettled, safeHeaders, nextLoadAction, retryGapMs,
  challengeGraceExpired, effectiveGapMs,
} = require('./cloudflare');
const { solveTurnstile } = require('./turnstile');
const { SseAccumulator, parseSseBody, extractAssistantFromMapping, isValidConversationId } = require('./lib/conversation-read');
const { trimConversationData } = require('./lib/conversation-trim');
// Liveness heartbeat for /health/live — named `liveness` to avoid clashing with the
// local `progress` indicator object inside waitAndExtractImage.
const { progress: liveness } = require('./progress');
const fs = require('fs');

const CHATGPT_URL = 'https://chatgpt.com';

// Configurable timeouts (ChatGPT Image 2.0 thinking mode can take longer)
function safePositiveInt(envValue, defaultValue) {
  const n = parseInt(envValue, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}
const GENERATION_TIMEOUT_MS = safePositiveInt(process.env.GENERATION_TIMEOUT_SEC, 240) * 1000;
// Adaptive second-chance budget: applied only when first wait timed out AND we can
// still observe an active generation indicator (stop-button / "Creating image…").
const GENERATION_RETRY_TIMEOUT_MS = safePositiveInt(process.env.GENERATION_RETRY_TIMEOUT_SEC, 90) * 1000;
// Hard ceiling for the whole image wait (first window + all adaptive extensions).
// ChatGPT Pro image generation can take several minutes; as long as an active
// generation indicator (stop-button) keeps showing, we extend in RETRY-sized chunks
// up to this cap instead of giving up after a single extension.
const GENERATION_MAX_TIMEOUT_MS = safePositiveInt(process.env.GENERATION_MAX_TIMEOUT_SEC, 600) * 1000;
const CHAT_COMPLETION_TIMEOUT_MS = safePositiveInt(process.env.CHAT_COMPLETION_TIMEOUT_SEC, 360) * 1000;
// Cloudflare interstitial policy (see src/cloudflare.js for the measurements behind it).
// The challenge verdict is decided per navigation, so a fresh `goto` after a pause is the
// way through; sitting on the interstitial is not, and doing only that cost a 34-hour outage.
// Two, not more, on purpose. Both measured recoveries came on the SECOND navigation, and the
// whole sequence has to fit inside the caller's clock: page load + CHAT_COMPLETION_TIMEOUT_SEC
// (360) + CHAT_COMPLETION_RETRY_TIMEOUT_SEC (120) must stay under the ~600 s clients allow.
// That leaves ~90 s for the page, which fits two attempts (2 × grace + one gap = 75 s) and not
// three (157.5 s) — a budget too small for the configured attempts makes the last ones
// unreachable dead code, which is exactly what the first cut of this release shipped.
// scripts/test-cloudflare.js asserts both halves of that arithmetic.
const CF_LOAD_ATTEMPTS = safePositiveInt(process.env.CF_LOAD_ATTEMPTS, 2);
// Floor for starting (or continuing) a navigation: below this there is no point beginning one.
const MIN_LOAD_ATTEMPT_MS = 5000;
// What a retry needs reserved for itself before the gap is allowed to eat the rest of the
// budget: a navigation plus a look at the result. Bigger than the bare floor above, because a
// retry that gets 5 s to load ChatGPT is a retry in name only.
const RETRY_ATTEMPT_RESERVE_MS = 20000;
const CF_RETRY_GAP_MS = safePositiveInt(process.env.CF_RETRY_GAP_SEC, 45) * 1000;
// Grace before giving up on THIS navigation: a challenge that clears itself does so in
// seconds. Kept small on purpose — the budget belongs to the retries, not to the waiting.
const CF_CHALLENGE_GRACE_MS = safePositiveInt(process.env.CF_CHALLENGE_GRACE_SEC, 15) * 1000;
// Ceiling for one attempt at clicking the interactive checkbox, carved out of the same page
// budget as everything else. Kept well under a retry gap: the click is cheap, and the point is
// to try it BEFORE burning a navigation, not to replace the navigation with a long wait.
const CF_TURNSTILE_BUDGET_MS = safePositiveInt(process.env.CF_TURNSTILE_BUDGET_SEC, 20) * 1000;
// Below this a solve would be cut off mid-settle and report a false negative, so it is skipped
// and the budget goes to the retry that already exists.
const MIN_TURNSTILE_SOLVE_MS = 8000;
// Wall-clock ceiling for the whole retry sequence — navigations included, not just the waits.
// 90 s is what is left of a ~600 s client budget after CHAT_COMPLETION_TIMEOUT_SEC (360) and
// its adaptive extension (120). Raise it only together with the client/ingress timeouts;
// otherwise the request dies on the caller's clock while the server is still politely retrying.
const CF_LOAD_BUDGET_MS = safePositiveInt(process.env.CF_LOAD_BUDGET_SEC, 90) * 1000;
// Adaptive second-chance budget for text turns: applied only when the base wait
// elapsed AND ChatGPT is still actively streaming/thinking (stop-button visible).
// Mirrors GENERATION_RETRY_TIMEOUT_MS for image generation — extended/long reasoning
// can outlast the base window, and we'd rather wait than cut an in-progress answer.
const CHAT_COMPLETION_RETRY_TIMEOUT_MS = safePositiveInt(process.env.CHAT_COMPLETION_RETRY_TIMEOUT_SEC, 120) * 1000;
// Stuck-generation guard: grant the adaptive extension ONLY if the page showed some text
// progress within this window. A stale/stuck UI can keep the stop-button visible forever
// (incident 2026-07-10: a trivial prompt hung 499s and head-of-line-blocked the queue) —
// stop-button alone is not proof of live generation.
const CHAT_STALL_WINDOW_MS = safePositiveInt(process.env.CHAT_STALL_WINDOW_SEC, 120) * 1000;
// Text-turn retry budget. A repeated page_load_failed signals a poisoned service-worker
// app-shell cache that survives in the browser context, so a fresh page alone won't help —
// the catch block escalates to a full context rebuild (see TEXT_HARD_RESET_ENABLED).
const CHATGPT_TEXT_RETRY_ATTEMPTS = safePositiveInt(process.env.CHATGPT_TEXT_RETRY_ATTEMPTS, 4);
// Hard browser-context reset is unsafe in CDP mode (we'd close the user's external Chrome).
// Env override (`CHATGPT_TEXT_HARD_RESET=false`) disables it without a release.
const TEXT_HARD_RESET_ENABLED =
  (process.env.CHATGPT_TEXT_HARD_RESET || 'true') !== 'false' &&
  (process.env.BROWSER_MODE || 'default') !== 'cdp';
// Image 2.0 standard mode renders in 10-25s (was 60-120s for Image 1.5) → shorter render wait OK
const RENDER_WAIT_MS = safePositiveInt(process.env.RENDER_WAIT_SEC, 15) * 1000;
// Snapshots may contain prompts and chat history — opt-in only
const DEBUG_SNAPSHOTS_ENABLED = process.env.DEBUG_SNAPSHOTS === '1' || process.env.DEBUG_SNAPSHOTS === 'true';
const DEBUG_SNAPSHOT_DIR = process.env.DEBUG_SNAPSHOT_DIR || '/tmp/chatgpt-debug';
// Stream-rescue (2026-07-11): новый рендерер ChatGPT может не дорисовать текст ответа
// в headless-странице (submit подтверждён, сервер ответил — видно из другого клиента,
// а в DOM пустой <p data-start data-end> внутри result-thinking). Если стрим не принёс
// ни символа за это окно — перезагружаем страницу: готовый ответ приходит статически
// и извлекается обычным путём. Окно меньше stall-abort (120с), чтобы rescue успел
// отработать до объявления сессии деградировавшей.
const CHAT_STREAM_RESCUE_MS = safePositiveInt(process.env.CHAT_STREAM_RESCUE_SEC, 60) * 1000;

// ==== Session validity checking (see probeSessionState / the watchdog below) ====
// /api/auth/session is authoritative but occasionally hiccups; one 4 s shot used to fall
// straight through to DOM guessing. Retry it instead, with a bounded total budget
// (attempts × timeout + delays ≈ 13 s worst case) that still cannot wedge the queue.
const SESSION_PROBE_ATTEMPTS = safePositiveInt(process.env.SESSION_PROBE_ATTEMPTS, 3);
const SESSION_PROBE_TIMEOUT_MS = safePositiveInt(process.env.SESSION_PROBE_TIMEOUT_SEC, 4) * 1000;
const SESSION_PROBE_RETRY_DELAY_MS = safePositiveInt(process.env.SESSION_PROBE_RETRY_DELAY_MS, 500);
// Last-resort DOM confirmation of a LOGOUT only (never of a login).
const SESSION_PROBE_DOM_TIMEOUT_MS = safePositiveInt(process.env.SESSION_PROBE_DOM_TIMEOUT_MS, 2000);
// Grace added to the in-page budget before Node gives up on page.evaluate() itself.
const SESSION_PROBE_DEADLINE_SLACK_MS = safePositiveInt(process.env.SESSION_PROBE_DEADLINE_SLACK_MS, 2000);
// Hard cap on how long a request may wait for an in-flight watchdog probe to release the
// page. Belt and braces: the probe is already bounded, but a request must never be able to
// hang on a background timer, whatever future bug shows up in the probe.
const SESSION_LEASE_WAIT_MS = safePositiveInt(process.env.SESSION_LEASE_WAIT_MS, 15000);
// Hard cap on waiting for a stale page to close before its replacement is built.
const PAGE_CLOSE_DEADLINE_MS = safePositiveInt(process.env.PAGE_CLOSE_DEADLINE_MS, 5000);
// Traffic-independent session watchdog: without it, a dead session is only discovered by
// a real request failing — which is how a 34 h outage stayed invisible behind green
// probes. Exports gpt_web_gateway_session_valid. Read-only, never logs in by itself.
const SESSION_WATCHDOG_ENABLED = envFlag('SESSION_WATCHDOG', true);
const SESSION_WATCHDOG_INTERVAL_MS = safePositiveInt(process.env.SESSION_WATCHDOG_INTERVAL_SEC, 300) * 1000;
// Cooldown after a FAILED auto-login: fail-closed checks plus a blocked login screen
// (Cloudflare/captcha/lockout) would otherwise retry the login on every single request.
const AUTO_LOGIN_RETRY_COOLDOWN_MS = safePositiveInt(process.env.AUTO_LOGIN_RETRY_COOLDOWN_SEC, 120) * 1000;
// How many consecutive INCONCLUSIVE checks on the request path before we stop refusing
// politely and escalate to a destructive re-login. Keeps a flaky /api/auth/session from
// wiping a working session, without letting a permanently unverifiable one wedge forever.
const SESSION_UNKNOWN_ESCALATE = safePositiveInt(process.env.SESSION_UNKNOWN_ESCALATE, 3);
const loginThrottle = createLoginThrottle({ cooldownMs: AUTO_LOGIN_RETRY_COOLDOWN_MS });

// envFlag comes from ./params (single shared implementation, unit-tested there).

// Default ON (verified live 2026-07-18; set READ_VIA_BACKEND_API=0 to opt out):
// read the assistant answer from ChatGPT's own backend-api traffic instead of
// scraping the DOM. Passive interception: page.on('response') for finished
// payloads + an injected fetch tee for live SSE deltas. The DOM extractor stays
// as the fallback either way.
const READ_VIA_BACKEND_API = envFlag('READ_VIA_BACKEND_API', true);

// Default 0 = off (verified live 2026-07-18: route fires, mapping shrinks, chat
// unbroken — server-side context is untouched, this only speeds up tab loading):
// rewrite GET /backend-api/conversation/{id} responses so ChatGPT renders only the
// last N messages of the active branch. Long conversations freeze the tab (and slow
// every multi-turn request); trimming keeps them snappy. Pure transform:
// src/lib/conversation-trim.js (ported from the chatgpt-multi extension).
const CONVERSATION_TRIM_LIMIT = (() => {
  const n = parseInt(process.env.CONVERSATION_TRIM_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

// Default 0 = off (account-wide side effect — deliberate opt-in): once per process,
// PATCH the account settings that control ChatGPT "memory" to false, so chat history
// stops leaking into answers and the gateway behaves closer to a stateless API.
// Verified live 2026-07-18: 'hive_referenced_in_internal_knowledge' (reference chat
// history) PATCHes fine (200); 'sunshine' (saved memories) returned 403 on the test
// account — server-gated, disable it manually in ChatGPT settings if needed. Logged
// best-effort, never a hard failure.
const DISABLE_CHATGPT_MEMORY = envFlag('DISABLE_CHATGPT_MEMORY');
// PATCH /backend-api/settings/account_user_setting?feature=<f>&value=false
const MEMORY_DISABLE_FEATURES = ['hive_referenced_in_internal_knowledge', 'sunshine'];

let page = null;

// ==== Backend-api passive reading (READ_VIA_BACKEND_API=1) ====
// One capture per text turn: completeText() calls beginBackendCapture() before submit;
// the page-level hooks below feed everything that looks like the current answer into it.
let currentCapture = null;          // SseAccumulator | null (+ .boundStream)
let lastConversationFetch = null;   // { conversationId, lastAssistantText, isComplete, at }
// Stream ids seen outside any capture, or consumed by an ended capture. A late chunk
// from a PREVIOUS turn's SSE stream must never bind to (and pollute) the next turn's
// capture — cross-request answer/conversation_id bleed (Codex P1).
const staleStreams = new Set();

function beginBackendCapture() {
  if (!READ_VIA_BACKEND_API) return null;
  currentCapture = new SseAccumulator();
  // First fresh (non-stale) stream observed after this point becomes THE stream of
  // this turn; chunks from any other stream id are ignored.
  currentCapture.boundStream = null;
  return currentCapture;
}

function endBackendCapture() {
  if (currentCapture && currentCapture.boundStream) staleStreams.add(currentCapture.boundStream);
  if (staleStreams.size > 500) staleStreams.clear(); // unbounded-growth guard
  currentCapture = null;
}

const SINGLE_CONVERSATION_PATH_RE = /^\/backend-api\/conversation\/[0-9a-f-]+$/i;
const CONVERSATION_POST_PATH_RE = /^\/backend-api\/(f\/)?conversation$/;

function conversationIdFromUrl(url) {
  const m = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url || '');
  return m ? m[1].toLowerCase() : null;
}

// Passive listener: GET conversation JSON (rendered after reloads / conversation opens)
// and finished SSE bodies (authoritative once the stream closed — merged into the live
// capture in case the injected tee missed chunks).
function onBackendResponse(response) {
  (async () => {
    let pathname;
    try {
      pathname = new URL(response.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.includes('/backend-api/')) return;
    const method = response.request().method();
    if (method === 'GET' && SINGLE_CONVERSATION_PATH_RE.test(pathname)) {
      if (!response.ok()) return;
      const data = await response.json().catch(() => null);
      const snap = data ? extractAssistantFromMapping(data) : null;
      if (snap && snap.lastAssistantText) {
        lastConversationFetch = { ...snap, at: Date.now() };
      }
      return;
    }
    if (method === 'POST' && CONVERSATION_POST_PATH_RE.test(pathname)) {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('text/event-stream')) return;
      // Snapshot the capture BEFORE awaiting the body: the response event fires when
      // headers arrive (inside the right turn), but text() resolves only when the
      // stream ends — by then a NEW turn's capture may be current. Merging into the
      // snapshot keeps a late body from bleeding into the wrong turn (Codex P1).
      const cap = currentCapture;
      if (!cap) return;
      const body = await response.text().catch(() => null);
      if (body) cap.merge(parseSseBody(body));
    }
  })().catch(() => {});
}

// Injected into every document at document_start: clones the SSE response of
// POST /backend-api/conversation and streams the CLONE's chunks to Node
// (page.on('response') only yields the body after the stream ends). The ORIGINAL
// Response object is returned to the app untouched — no reconstruction, so
// type/redirected/url survive and a mid-read failure can't hand the app a locked
// body (Codex review). Each read stream carries a unique id so Node can bind
// chunks to exactly one turn's capture.
function backendFetchTeeInitScript() {
  if (window.__gwgFetchTeed) return;
  window.__gwgFetchTeed = true;
  // Chunks that arrive before the exposeFunction binding exists in THIS world.
  //
  // Under patchright `page.evaluate` defaults to an isolated world, and the binding is not
  // installed in the main world — where this script runs — until Node touches that world once
  // (measured: `typeof window.__gwgSseChunk` is `undefined` at t0/50/250/1000/2500 ms, and
  // `function` immediately after a single main-world evaluate; see
  // docs/2026-07-29-patchright-compat-probe.md). Without a buffer, every chunk in that window
  // is dropped — silently, because the old code just skipped when the binding was falsy, so a
  // streamed answer would come back empty rather than failing.
  //
  // Bounded: a runaway stream must not grow an array inside the page forever. Under the legacy
  // stealth engine the binding is there from document-start, so this stays empty.
  // Bounded by BYTES as well as by entry count: 2000 entries caps how many chunks are held,
  // not how large they are, and an SSE chunk has no fixed size — a failed prime could otherwise
  // pin an unbounded amount of memory inside the page until the document goes away (Codex).
  // Overflow is counted rather than ignored, so "the answer was truncated" is observable
  // instead of being indistinguishable from a short reply.
  window.__gwgSseBuffer = [];
  window.__gwgSseBufferBytes = 0;
  window.__gwgSseDropped = 0;
  const BUF_MAX_ENTRIES = 2000;
  const BUF_MAX_BYTES = 4 * 1024 * 1024;
  const deliver = (streamId, chunk) => {
    if (typeof window.__gwgSseChunk === 'function') {
      window.__gwgSseChunk(streamId, chunk);
      return;
    }
    const buf = window.__gwgSseBuffer;
    if (!buf
      || buf.length >= BUF_MAX_ENTRIES
      || window.__gwgSseBufferBytes + chunk.length > BUF_MAX_BYTES) {
      window.__gwgSseDropped++;
      return;
    }
    window.__gwgSseBufferBytes += chunk.length;
    buf.push([streamId, chunk]);
  };
  const origFetch = window.fetch.bind(window);
  const isConversationPost = (input, init) => {
    try {
      const url = typeof input === 'string' ? input
        : (input instanceof URL) ? input.href
          : (input && typeof input.url === 'string') ? input.url : '';
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method !== 'POST') return false;
      const u = new URL(url, location.origin);
      if (u.origin !== location.origin) return false;
      return /^\/backend-api\/(f\/)?conversation$/.test(u.pathname);
    } catch {
      return false;
    }
  };
  window.fetch = async function gwgTeedFetch(input, init) {
    const resp = await origFetch(input, init);
    try {
      if (!isConversationPost(input, init)) return resp;
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream') || !resp.body || resp.bodyUsed) return resp;
      const copy = resp.clone();
      if (!copy.body) return resp;
      const reader = copy.body.getReader();
      const decoder = new TextDecoder();
      const streamId = `gwg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            deliver(streamId, decoder.decode(value, { stream: true }));
          }
        } catch {}
      })();
      return resp;
    } catch {
      return resp;
    }
  };
}

// Conversation-trim route handler (CONVERSATION_TRIM_LIMIT > 0): fetch the real
// response in Node, trim the mapping, fulfill with the smaller body. Any failure
// falls back to the untouched network response — trimming must never break a chat.
async function trimConversationRoute(route) {
  try {
    const request = route.request();
    let pathname;
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      return await route.fallback();
    }
    if (request.method() !== 'GET' || !SINGLE_CONVERSATION_PATH_RE.test(pathname)) {
      return await route.fallback();
    }
    const response = await route.fetch();
    const ct = response.headers()['content-type'] || '';
    if (response.status() !== 200 || !ct.includes('application/json')) {
      return await route.fulfill({ response });
    }
    const data = await response.json().catch(() => null);
    const trimmed = data ? trimConversationData(data, CONVERSATION_TRIM_LIMIT) : null;
    if (!trimmed) return await route.fulfill({ response });
    console.log(`[trim] ${pathname.split('/').pop()}: mapping trimmed to last ${CONVERSATION_TRIM_LIMIT} messages`);
    return await route.fulfill({ response, json: trimmed });
  } catch (e) {
    try {
      await route.fallback();
    } catch {}
  }
}

// Registered on the CONTEXT (not the page): survives page recreation and covers any
// page in the context. Known limitation (documented): Playwright routes
// do not intercept requests served by a Service Worker, and routing disables the HTTP
// cache for matched URLs — if ChatGPT serves conversations through its SW, the trim
// simply does not apply (passthrough, nothing breaks).
const trimRoutedContexts = new WeakSet();
async function setupConversationTrim(ctx) {
  if (CONVERSATION_TRIM_LIMIT <= 0 || trimRoutedContexts.has(ctx)) return;
  trimRoutedContexts.add(ctx);
  await ctx.route('**/backend-api/conversation/*', trimConversationRoute);
  console.log(`[trim] conversation trim enabled (CONVERSATION_TRIM_LIMIT=${CONVERSATION_TRIM_LIMIT})`);
}

async function setupBackendReadHooks(p) {
  if (!READ_VIA_BACKEND_API) return;
  p.on('response', onBackendResponse);
  await p.exposeFunction('__gwgSseChunk', (streamId, chunk) => {
    if (typeof streamId !== 'string' || typeof chunk !== 'string') return;
    const cap = currentCapture;
    if (!cap) {
      // No turn in flight — remember the stream so it can never bind later.
      staleStreams.add(streamId);
      return;
    }
    if (cap.boundStream === null) {
      if (staleStreams.has(streamId)) return; // stream predates this capture
      cap.boundStream = streamId;
    }
    if (cap.boundStream !== streamId) return;
    try { cap.feed(chunk); } catch {}
  });
  await p.addInitScript(backendFetchTeeInitScript);
  // Every fresh document needs its main world touched once, or the tee above can never reach
  // Node (see primeMainWorld). 'load' rather than a one-shot call: the gateway re-navigates on
  // Cloudflare retries and page rebuilds, and each new document gets a new main world.
  p.on('load', () => { primeMainWorld(p).catch(() => {}); });
  await primeMainWorld(p);
  console.log('[backend-read] passive backend-api interception enabled (READ_VIA_BACKEND_API=1)');
}

/**
 * Install the `__gwgSseChunk` binding in the page's MAIN world and flush anything the tee
 * buffered before it existed.
 *
 * Engine-agnostic on purpose. Under the legacy stealth engine the binding is present from
 * document-start and the buffer is always empty, so this is a cheap no-op; under patchright it
 * is what makes streamed answers work at all. `evaluate`'s third positional argument selects
 * the world — patchright-only API, ignored by vanilla Playwright, which is why the call is
 * written to degrade rather than throw.
 */
async function primeMainWorld(p) {
  if (!READ_VIA_BACKEND_API || !p || p.isClosed()) return 0;
  try {
    // TWO evaluates, and the order is load-bearing. The binding is installed as a side effect
    // of the main world being touched, so it is NOT yet visible inside the very call that
    // touches it — measured: a single combined evaluate still reports `undefined`. The first
    // call creates/primes the world; only the second can see and use the binding.
    await p.evaluate(() => { window.__gwgPrimed = true; }, undefined, false);
    const drained = await p.evaluate(async () => {
      if (typeof window.__gwgSseChunk !== 'function') return -1;
      const buf = window.__gwgSseBuffer;
      if (!buf || !buf.length) return 0;
      // Drain by EMPTYING, never by nulling. `deliver()` only buffers when the binding is
      // absent, so a live binding costs nothing here — but if the binding ever goes away again
      // (a rebuilt context, a re-navigation racing this call) a nulled buffer would make
      // `deliver()` drop chunks on the floor silently, which is the exact failure mode this
      // whole mechanism exists to prevent (agy review).
      const batch = buf.splice(0, buf.length);
      window.__gwgSseBufferBytes = 0;
      // Awaited: the binding returns a promise, and firing them without waiting lets chunks
      // reach Node out of order — which for an SSE accumulator is corruption, not lateness.
      for (const [id, chunk] of batch) {
        try { await window.__gwgSseChunk(id, chunk); } catch {}
      }
      const dropped = window.__gwgSseDropped || 0;
      window.__gwgSseDropped = 0;
      return { flushed: batch.length, dropped };
    }, undefined, false);
    if (drained === -1) {
      // Loud, because this is the failure mode that would otherwise show up as empty answers.
      console.log('[backend-read] WARNING: __gwgSseChunk is not reachable from the page — ' +
        'streamed chunks will be buffered but never delivered');
      return 0;
    }
    if (drained.flushed > 0) console.log(`[backend-read] flushed ${drained.flushed} buffered SSE chunk(s)`);
    if (drained.dropped > 0) {
      console.log(`[backend-read] WARNING: dropped ${drained.dropped} SSE chunk(s) — the page ` +
        'buffer overflowed while the binding was unreachable; this answer may be truncated');
    }
    return drained.flushed;
  } catch (e) {
    // Not swallowed: a prime that keeps failing is the difference between streamed answers and
    // empty ones, and it used to be invisible (Codex review).
    console.log(`[backend-read] main-world prime failed: ${e.message}`);
    return 0;
  }
}

// Single-flight guard (same rationale as browser.js getContext): startup warm-up and the
// first request can both reach getPage() with `page` still null and would otherwise each
// create a page and overwrite the singleton. Memoize the in-flight creation.
let pagePromise = null;
async function getPage() {
  if (page && !page.isClosed()) {
    await recoverContentFailed(page);
    return page;
  }
  if (pagePromise) return pagePromise;
  pagePromise = _createPage();
  try {
    return await pagePromise;
  } finally {
    pagePromise = null;
  }
}

/**
 * Explain a Cloudflare block in one grep-able line, instead of 60 identical
 * "Just a moment..." lines that say nothing about WHY.
 *
 * The 2026-07-26 investigation cost hours precisely because a stuck challenge looks the same
 * whatever causes it, and the two causes need opposite fixes:
 *
 *   - the evasions stopped applying → `ua_evasion_ok=0` here names it immediately;
 *   - our egress IP is distrusted    → identical fingerprint, different address, different
 *                                      verdict. `egress_ip` is what makes that visible, and
 *                                      it is the case that actually happened: the same image
 *                                      was served HTTP 200 from one IP and challenged from
 *                                      the production node's.
 *
 * Never throws and never blocks for long — it runs on a path that is already failing.
 */
const CF_DIAG_BUDGET_MS = 8000;

async function reportCloudflareBlock(p, navResponse) {
  const facts = {
    status: null,
    cf_mitigated: null,
    cf_ray: null,
    colo: null,
    egress_ip: null,
    cf_clearance: 'absent',
    ua_evasion_ok: browserFingerprint.ua_evasion_ok,
    ua_source: browserFingerprint.ua_source,
    channel: browserFingerprint.channel,
    egress: browserFingerprint.proxy,
    ua: browserFingerprint.effective_ua,
  };
  // Response headers are synchronous and cannot hang.
  try {
    if (navResponse) {
      facts.status = navResponse.status();
      const h = navResponse.headers() || {};
      facts.cf_mitigated = h['cf-mitigated'] || null;
      facts.cf_ray = h['cf-ray'] || null;
      if (facts.cf_ray) facts.colo = String(facts.cf_ray).split('-').pop();
    }
  } catch {}

  // Everything below talks to a page that has just proved it is not healthy, so the WHOLE
  // collection sits behind one Node-side deadline — not just the evaluate. `context.cookies()`
  // is a driver round-trip and can hang on a wedged browser just as easily (Codex review).
  const gather = (async () => {
    // A live cf_clearance is what lets a headless browser skip the interrogation entirely;
    // knowing whether we had one separates "our clearance expired" from "we never earn one".
    try {
      const now = Date.now() / 1000;
      // Scoped to ChatGPT: a `chrome`-profile or `cdp` context carries cookies for every site
      // the profile has visited, and a cf_clearance belonging to some other Cloudflare host
      // would be reported as ours (Codex review, round 2).
      const cookies = await p.context().cookies(CHATGPT_URL);
      const clearance = cookies.find((c) => c.name === 'cf_clearance');
      if (clearance) {
        facts.cf_clearance =
          clearance.expires === -1 || clearance.expires > now
            ? `present (expires in ${clearance.expires === -1 ? 'session' : Math.round(clearance.expires - now) + 's'})`
            : 'expired';
      }
    } catch {}
    // Cloudflare's own echo of the address it sees us from — the field that separates a
    // fingerprint problem from a reputation problem.
    try {
      facts.egress_ip = await p.evaluate(async () => {
        const r = await fetch('/cdn-cgi/trace', { cache: 'no-store' });
        const t = await r.text();
        const m = t.match(/^ip=(.+)$/m);
        return m ? m[1] : null;
      });
    } catch {}
  })();
  let timer;
  await Promise.race([
    gather.catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, CF_DIAG_BUDGET_MS); }),
  ]).finally(() => clearTimeout(timer));

  browserFingerprint.cloudflare_challenges++;
  console.log(
    `[load][cloudflare] BLOCKED status=${facts.status} cf-mitigated=${facts.cf_mitigated} ` +
      `cf-ray=${facts.cf_ray} colo=${facts.colo} egress_ip=${facts.egress_ip} egress=${facts.egress} ` +
      `cf_clearance=${facts.cf_clearance} ua_evasion_ok=${facts.ua_evasion_ok} ua_source=${facts.ua_source} ` +
      `channel=${facts.channel} ua="${facts.ua}"`,
  );
  if (facts.ua_evasion_ok === 0) {
    console.log(
      '[load][cloudflare] start here: the browser is advertising a headless build, so the ' +
        'anti-automation evasions are not applying (see the [browser] WARNING above).',
    );
  } else {
    // Carefully worded: a clean user agent rules out ONE symptom, not the fingerprint as a
    // whole (high-entropy client hints still leak a headless brand even when requests
    // succeed). It is a pointer to the next experiment, not a diagnosis.
    console.log(
      `[load][cloudflare] the one fingerprint symptom we can see — a headless user agent — is ` +
        `absent, so the next thing to test is the egress address (${facts.egress_ip || 'unknown'}): ` +
        'run the same image from another IP and compare. A low-reputation address is challenged ' +
        'whatever the browser claims to be; PROXY_SERVER routes around it (see README).',
    );
  }
  return facts;
}

async function _createPage() {
  if (page && !page.isClosed()) return page;

  const ctx = await getContext();
  await setupConversationTrim(ctx);
  // Build the page in a LOCAL and publish it to the module-level `page` only after it is
  // fully initialized (hooks + navigation + a usable/auth state). Publishing early would let
  // a concurrent getPage() fast-path (`if (page && !page.isClosed())`) return a
  // half-initialized about:blank page and start a login flow on it. (Codex review)
  const p = await ctx.newPage();
  // Guard EVERY init step: a failure from hooks/goto/the wait-loop/saveSession (not only the
  // typed page_load_failed below) must close this local page, or it leaks with active response
  // hooks. `page = p` is published only after the whole init AND saveSession succeed.
  let published = false;
  try {

  // Hide automation — legacy engine only; patchright reports webdriver=false natively.
  await maybeHideWebdriverOnPage(p);

  await setupBackendReadHooks(p);

  // Navigation is RETRIED on a Cloudflare challenge, because that verdict is decided per
  // navigation: the same address that is challenged now is served 200 on a fresh `goto` a
  // minute later, and once through, the access holds (measured 2026-07-26 from three egress
  // addresses, including the production pod's — see src/cloudflare.js). The previous code
  // navigated once, waited out ~2 minutes on the interstitial and gave up; that is how a
  // recoverable challenge turned into a 34-hour outage.
  let navResponse = null;
  let ready = false;
  let finalTitle = '';
  const loadStartedAt = Date.now();

  // ONE absolute deadline governs the whole sequence — the navigations, the interstitial
  // grace and the gaps alike. An attempt-count ceiling is not a time ceiling: three slow
  // `goto`s alone can outrun a budget that only counts grace and gaps (Codex review, round 2:
  // 3 × 30 s navigations spent 250 s against a 240 s budget).
  const loadDeadline = loadStartedAt + CF_LOAD_BUDGET_MS;
  const remainingMs = () => loadDeadline - Date.now();
  // A between-iterations check is not enough on its own: `page.title()` and the `evaluate()`
  // inside the content-failed probe are hostage to the renderer, and a wedged one never
  // returns — the budget would be checked at a point the code never reaches again (Codex
  // review, round 4). Racing them against what is left of the budget makes the ceiling real:
  // the loop breaks, `ready` stays false, and the `finally` below closes this page instead of
  // leaving it to hold the queue until the liveness probe restarts the pod.
  const LOAD_DEADLINE = Symbol('load-deadline');
  const withLoadDeadline = (promise, fallback) => {
    let timer;
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(LOAD_DEADLINE), Math.max(0, remainingMs()));
      }),
    ]).finally(() => clearTimeout(timer));
  };

  for (let attempt = 1; attempt <= CF_LOAD_ATTEMPTS; attempt++) {
    // Starting an attempt that cannot finish only produces a confusing instant timeout.
    if (attempt > 1 && remainingMs() <= MIN_LOAD_ATTEMPT_MS) {
      console.log(
        `[load][cloudflare] page-load budget spent (${Math.round((Date.now() - loadStartedAt) / 1000)}s) — ` +
          `not starting attempt ${attempt}`,
      );
      break;
    }
    console.log(
      attempt === 1
        ? 'Navigating to ChatGPT...'
        : `Navigating to ChatGPT (attempt ${attempt}/${CF_LOAD_ATTEMPTS})...`,
    );
    // Keep the navigation response: its Cloudflare headers are the only thing that
    // distinguishes "we were challenged" from "the SPA failed to boot", and they are gone by
    // the time the wait loop below gives up.
    //
    // The navigation timeout is whatever is left of the budget (capped at the usual 60 s), so
    // a hanging `goto` cannot push the sequence past the deadline on its own.
    const navTimeout = Math.min(60000, Math.max(MIN_LOAD_ATTEMPT_MS, remainingMs()));
    navResponse = await p.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    let navHeaders = safeHeaders(navResponse);

    console.log('Waiting for ChatGPT to load...');
    let challengeSince = 0;
    for (let i = 0; i < 60; i++) {
      // The deadline governs THIS loop too, not only the challenge branch: a booting-but-never-
      // ready SPA polls here for a full minute, and `recoverContentFailed` below can reload
      // twice at 30 s each, on every iteration. Without this check the "budget" would bound
      // only the paths that already behaved (Codex review, round 3).
      if (remainingMs() <= 0) {
        console.log('[load] page-load budget spent while waiting for the app shell');
        break;
      }
      const title = await withLoadDeadline(p.title(), '');
      if (title === LOAD_DEADLINE) {
        console.log('[load] page-load budget spent — the renderer did not answer, abandoning this page');
        break;
      }
      const url = p.url();
      console.log(`[load ${i}] title="${title}" url="${url}"`);

      // Every Cloudflare interstitial, not just the "Just a moment" wording: "Attention
      // Required", "Checking your browser" and a challenge visible only in `cf-mitigated`
      // used to fall through to the generic polling and burn a full minute per attempt
      // (Codex review).
      //
      // Once we know we are challenged, only a REAL title releases us — an empty title (very
      // common right after domcontentloaded) must not cancel the verdict the headers gave us.
      const challenged = challengeSince
        ? !titleSettled(title)
        : looksLikeCloudflareChallenge(title, navHeaders);
      if (challenged) {
        if (!challengeSince) challengeSince = Date.now();
        // The grace is also bounded by the shared deadline: waiting out a challenge with no
        // time left to re-navigate is the old failure mode in miniature.
        if (challengeGraceExpired(Date.now() - challengeSince, CF_CHALLENGE_GRACE_MS)
            || remainingMs() <= 0) {
          // The grace has told us the page will not clear ITSELF. That leaves two very
          // different challenges, and only one of them is helped by navigating again: the
          // interactive checkbox renders afresh on every `goto`, so the retry below can loop
          // on it forever (it did, for 34 hours). Try the click first; a passive interstitial
          // simply finds no widget and falls through to the retry exactly as before.
          const solveBudget = Math.min(CF_TURNSTILE_BUDGET_MS, remainingMs() - MIN_LOAD_ATTEMPT_MS);
          if (solveBudget >= MIN_TURNSTILE_SOLVE_MS
              && await solveTurnstile(p, { budgetMs: solveBudget, label: 'load' })) {
            challengeSince = 0;
            continue;
          }
          console.log('[load] Cloudflare challenge is not clearing on its own — re-navigating');
          break;
        }
        console.log('[load] Cloudflare challenge detected, waiting...');
        await p.waitForTimeout(2000);
        continue;
      }
      challengeSince = 0;

      // Dismiss login modal if present
      const loginModal = await p.$('#modal-no-auth-login');
      if (loginModal) {
        console.log('[load] Login modal detected, dismissing...');
        await p.evaluate(() => {
          const modal = document.getElementById('modal-no-auth-login');
          if (modal) modal.remove();
        });
        await p.waitForTimeout(500);
      }

      const textarea = await p.$('[id="prompt-textarea"]:visible, textarea:visible');
      if (textarea) {
        console.log('ChatGPT loaded and ready.');
        break;
      }

      const recovered = await withLoadDeadline(recoverContentFailed(p, { deadline: loadDeadline }), false);
      if (recovered === LOAD_DEADLINE) {
        console.log('[load] page-load budget spent during content recovery — abandoning this page');
        break;
      }
      if (recovered) {
        // A recovery reload is a NEW navigation: adopt its response, or the Cloudflare verdict
        // below would still be judged by the original goto's headers (Codex review, round 2).
        if (recovered.response) {
          navResponse = recovered.response;
          navHeaders = safeHeaders(navResponse);
          challengeSince = 0;
        }
        continue;
      }

      const loginBtn = await p.$('button:has-text("Log in")');
      if (loginBtn) {
        console.log('Login page detected.');
        break;
      }

      await p.waitForTimeout(1000);
    }

    finalTitle = await p.title().catch(() => '');
    const blocked = looksLikeCloudflareChallenge(finalTitle, safeHeaders(navResponse));
    const hasComposer = await p.$('[id="prompt-textarea"]:visible, textarea:visible').catch(() => null);
    // Treat the full auth surface as "ready enough" — a logged-out page must still be
    // handed to ensureLoggedIn()/auto-login, not killed as page_load_failed. Covers
    // Log in / Sign up / Get started CTAs, the auth URL, and visible email/password fields.
    const authDom = await p.$(
      'button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up"), a:has-text("Sign up"), a:has-text("Get started"), input[type="password"], input[name="username"], input[type="email"]'
    ).catch(() => null);
    // The URL alone is NOT enough while we are challenged: Cloudflare serves its interstitial
    // at whatever path we asked for, so a challenge on /auth/login would otherwise read as
    // "auth surface reached", get published, and leave auto-login poking at an interstitial
    // instead of retrying (Codex review). Real DOM controls still count either way — a login
    // form is not a challenge page.
    const authUrl = /\/auth\/(login|signup)|auth0\.com|\/log-in/i.test(p.url());
    const hasAuthSurface = !!authDom || (authUrl && !blocked);
    ready = !!(hasComposer || hasAuthSurface);

    const action = nextLoadAction({ ready, blocked, attempt, attempts: CF_LOAD_ATTEMPTS });
    if (action !== 'retry') break;

    // The pause shrinks to fit rather than cancelling the retry: asking again sooner beats
    // not asking at all, and a slow first navigation must not silently cost the second one.
    const gap = effectiveGapMs(retryGapMs(attempt, CF_RETRY_GAP_MS), remainingMs(), RETRY_ATTEMPT_RESERVE_MS);
    if (!gap) {
      console.log(
        `[load][cloudflare] challenged on attempt ${attempt}/${CF_LOAD_ATTEMPTS}, but the ` +
          `${Math.round(CF_LOAD_BUDGET_MS / 1000)}s page-load budget is spent — giving up so the ` +
          'caller gets a typed error instead of a request that outlives its own timeout',
      );
      break;
    }
    console.log(
      `[load][cloudflare] challenged on attempt ${attempt}/${CF_LOAD_ATTEMPTS} — ` +
        `re-navigating in ${Math.round(gap / 1000)}s (the verdict is per navigation, not permanent)`,
    );
    await p.waitForTimeout(gap);
  }

  // Still not usable after every attempt (stuck on Cloudflare or a blank SPA): fail fast with
  // a typed error and close the local page instead of publishing it — otherwise the next
  // getPage() returns it via the fast path and the bad state sticks. No saveSession() either.
  if (!ready) {
    console.log(`[load] page not ready after ${CF_LOAD_ATTEMPTS} attempt(s) (title="${finalTitle}") — failing fast (page_load_failed)`);
    const blockedByCloudflare = looksLikeCloudflareChallenge(finalTitle, safeHeaders(navResponse));
    if (blockedByCloudflare) await reportCloudflareBlock(p, navResponse);
    const e = new Error(blockedByCloudflare
      ? 'Cloudflare challenge did not clear'
      : 'ChatGPT page did not load');
    e.code = 'page_load_failed';
    if (blockedByCloudflare) e.cloudflareChallenge = true;
    throw e;
  }

  await saveSession();
  page = p; // publish only after full init AND session save succeed
  published = true;
  return page;
  } finally {
    if (!published) await p.close().catch(() => {});
  }
}

// Sentinel: the probe blew its Node-side deadline (see below).
const PROBE_DEADLINE = Symbol('probe-deadline');

// Discard a page whose renderer stopped answering. Closing it is what actually cancels the
// pending evaluate; clearing the singleton is what makes the next getPage() rebuild.
function closeWedgedPage(p) {
  try {
    if (p && (!p.isClosed || !p.isClosed())) p.close().catch(() => {});
  } catch {}
  if (p === page) page = null;
}

// Race a promise against a wall-clock deadline that lives in NODE, not in the page.
function raceDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(PROBE_DEADLINE), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// One bounded call to ChatGPT's own session endpoint, executed inside the page so the
// session cookies apply. Returns true (live session) / false (confirmed logged out) /
// null (inconclusive: aborted, network error, non-2xx, unexpected schema) /
// PROBE_DEADLINE (the renderer never answered at all).
//
// The AbortController below lives in the renderer, so it is useless precisely when the
// renderer is wedged — `page.evaluate` would then never settle. That promise is what the
// watchdog publishes as its lease and what every request waits on, so an unbounded probe
// would deadlock the whole gateway (Codex review). Hence the outer Node-side deadline.
async function fetchSessionState(p, timeoutMs, { logErrors = false } = {}) {
  const evaluation = p.evaluate(async (budget) => {
    // Bounded: a hung endpoint must not wedge the (single) request queue.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), budget);
    try {
      const r = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: ctrl.signal });
      // 401 is an explicit "no session". 403 is NOT: Cloudflare/WAF answers 403 to a
      // request it dislikes, which says nothing about our cookies (Codex review).
      if (r.status === 401) return { v: false };
      if (!r.ok) return { v: null }; // 403 / 5xx / network / redirect → inconclusive, retry
      const j = await r.json().catch(() => null);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { v: null };
      // An envelope that carries `error` is NOT proof of a session, however complete the
      // rest of it looks. Observed 2026-07-31: after the refresh token died the endpoint
      // kept answering 200 with the stale user + accessToken AND
      // error:"RefreshAccessTokenError". The web app honours the error and renders the
      // anonymous page — so the token is worthless, and reading it as "in" is what let a
      // dead session pass 47 consecutive checks with session_valid=1 and no alert.
      // Inconclusive rather than a hard logout on purpose: 'out' drives autoLogin, which
      // clears the cookie jar, and an error that clears on retry must not cost a live
      // session. The DOM confirmation at the end of probeSessionState settles the real case.
      // Stringified defensively: this schema is unofficial and `error` has been seen as a
      // bare string, but an object would log as "[object Object]" and hide the one fact
      // this line exists to carry (agy review). Only the two conventional name fields are
      // quoted verbatim — an unnamed object is reduced to its KEY names, because an
      // unofficial schema's values may carry a credential and this ends up in the pod log.
      // Control characters are stripped for the same reason: a `\n` in the name would let
      // the endpoint forge a second log record (Codex review).
      if (j.error) {
        const name = typeof j.error === 'object'
          ? (j.error.code || j.error.message || `{${Object.keys(j.error).join(',')}}`)
          : j.error;
        return { v: null, err: String(name).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 80) };
      }
      // Positive signals: a live session carries accessToken (and a user object).
      if (j.accessToken || j.user) return { v: true };
      // Confirmed-empty object body ({}) = logged out. Any other shape (a changed
      // unofficial schema) is inconclusive → retried, then fail-closed.
      if (Object.keys(j).length === 0) return { v: false };
      return { v: null };
    } catch {
      return { v: null }; // abort / network error → inconclusive
    } finally {
      clearTimeout(t);
    }
  }, timeoutMs).catch(() => null);

  const settled = await raceDeadline(evaluation, timeoutMs + SESSION_PROBE_DEADLINE_SLACK_MS);
  if (settled === PROBE_DEADLINE) return PROBE_DEADLINE;
  if (!settled || typeof settled !== 'object') return null;
  // Logged once per probe (first attempt only), because this is the line whose absence made
  // the 2026-07-31 outage un-diagnosable from the logs: it took a second browser inside the
  // pod to discover the endpoint was answering 200-with-an-error all along.
  if (settled.err && logErrors) {
    console.log(`[session] /api/auth/session answered 200 but carries error="${settled.err}" — not proof of a live session`);
  }
  return settled.v === undefined ? null : settled.v;
}

/**
 * Tri-state session check: 'in' | 'out' | 'unknown'.
 *
 * `/api/auth/session` is the ONLY authoritative source and is now retried (a single 4 s
 * budget used to fall through to DOM heuristics on any hiccup). The DOM is consulted
 * only to CONFIRM a logout — never to confirm a login. The old "a visible composer means
 * we are logged in" rule is gone: ChatGPT renders the composer for anonymous visitors
 * (verified 2026-07-26 — anonymous page shows "Ask anything" plus Log in / Sign up), and
 * that rule is exactly what reported a dead session as healthy for 34 h.
 */
async function probeSessionState(p, opts = {}) {
  const attempts = opts.attempts || SESSION_PROBE_ATTEMPTS;
  const timeoutMs = opts.timeoutMs || SESSION_PROBE_TIMEOUT_MS;
  const delayMs = opts.delayMs === undefined ? SESSION_PROBE_RETRY_DELAY_MS : opts.delayMs;

  // URL short-circuit: страница auth/login = точно не залогинены
  try {
    const url = p.url();
    if (/\/auth\/(login|signup)|chatgpt\.com\/log-in|auth0\.com|chatgpt\.com\/?$.*[?#]?.*welcome/i.test(url)) {
      return 'out';
    }
  } catch {}

  for (let i = 0; i < attempts; i++) {
    const authed = await fetchSessionState(p, timeoutMs, { logErrors: i === 0 });
    if (authed === true) return 'in';
    if (authed === false) return 'out';
    if (authed === PROBE_DEADLINE) {
      // The renderer did not answer at all. Racing a deadline only bounds *our* wait — the
      // evaluate is still pending on that page, and any later call on the same page would
      // hang the same way (a deferred "reset pending" flag is not enough: whoever calls
      // getPage() next may not consume it). So close the wedged page right here: that
      // rejects the orphaned evaluate, guarantees the next getPage() builds a fresh one,
      // and stops ticks from stacking up hung calls (Codex review).
      console.log('[session] session probe hit its Node-side deadline — renderer wedged, discarding the page');
      markSessionDegraded('session probe deadline');
      closeWedgedPage(p);
      // No DOM fallback: the page we would ask is the one we just threw away.
      return 'unknown';
    }
    if (i < attempts - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Backend never answered conclusively. Look for a DEFINITIVE logged-out marker — the
  // anonymous login modal or the Log in / Sign up CTA. Finding one upgrades 'unknown' to
  // a confirmed 'out'; not finding one leaves us genuinely unsure. Wrapped whole: on a
  // closed/crashed page even building the locator can throw, and a session check must
  // return a verdict rather than blow up the caller.
  const loggedOutMarker = await Promise.resolve()
    .then(() =>
      p
        .locator(
          '#modal-no-auth-login, [data-testid="modal-no-auth-login"], button:has-text("Log in"), ' +
            'a:has-text("Log in"), button:has-text("Sign up"), a:has-text("Sign up for free")',
        )
        .first()
        .waitFor({ state: 'visible', timeout: SESSION_PROBE_DOM_TIMEOUT_MS }),
    )
    .then(() => true)
    .catch(() => false);
  if (loggedOutMarker) {
    console.log('[session] /api/auth/session inconclusive, DOM shows logged-out markers → out');
    return 'out';
  }
  console.log('[session] /api/auth/session inconclusive and no DOM verdict → unknown (treated as logged out)');
  return 'unknown';
}

/**
 * Rebuild the page, waiting for the OLD one to actually close.
 *
 * `resetPage()` fires `page.close()` without awaiting it, which is fine when nothing races
 * the teardown — but here the very next call builds a replacement, and an overlapping close
 * on the same context is exactly the kind of teardown that leaves an orphaned renderer
 * (Codex review). Waiting is cheap next to the page-creation budget we are about to spend.
 */
async function recreatePage(stale) {
  if (page === stale) page = null;
  if (stale && !stale.isClosed()) {
    // Bounded: this runs on the path that handles pages which are ALREADY misbehaving, and
    // close() on a wedged renderer can hang indefinitely (agy review). Waiting is worth a
    // few seconds to avoid an overlapping teardown; it is never worth the request.
    await raceDeadline(stale.close().catch(() => {}), PAGE_CLOSE_DEADLINE_MS);
  }
  const fresh = await getPage();
  await dismissModals(fresh);
  return fresh;
}

/**
 * One session verdict for the REQUEST path, with a single stale-page recovery.
 *
 * Observed 2026-07-29, twice, on two different pods: the startup probe reported 'in' and the
 * first request ~a minute later reported 'unknown' on the SAME page — a page that has been
 * sitting idle gets its in-page XHRs challenged, while a freshly navigated one does not. The
 * startup path is the proof: navigation produces a conclusive verdict from the same cookies.
 *
 * So an inconclusive verdict is not accepted until the page has been rebuilt once and
 * re-probed. This matters because the streak it would otherwise feed escalates, and no
 * amount of "we could not check" should be allowed to act on a session that is in fact live.
 *
 * Rebuilding costs up to the page-creation budget (~90 s), so only the FIRST unknown of a
 * streak pays for it; later ones refuse cheaply until the streak breaks. Dependencies are
 * injected so the policy is testable without a browser.
 */
async function probeSessionWithRecovery(p, {
  probe = probeSessionState,
  renavigate = () => recreatePage(p),
  record = (state, reason) => sessionHealth.recordProbe(state, reason),
  consecutiveUnknown = 0,
} = {}) {
  let state = await probe(p);
  record(state, 'request');
  if (state !== 'unknown' || consecutiveUnknown > 0) {
    return { state, page: p, renavigated: false };
  }

  console.log('[session] inconclusive on the existing page — rebuilding it once before this counts');
  const fresh = await renavigate();
  state = await probe(fresh);
  record(state, 'request_renavigate');
  return { state, page: fresh, renavigated: true };
}

// Boolean gate used everywhere a page is about to be driven. FAIL-CLOSED: anything short
// of a confirmed live session counts as "not logged in", so an unverifiable session gets
// re-established instead of silently serving broken requests.
async function isLoggedIn(p) {
  return (await probeSessionState(p)) === 'in';
}

async function isContentFailed(p) {
  return await p.evaluate(() => /content failed to load/i.test(document.body.innerText || '')).catch(() => false);
}

/**
 * @returns {Promise<false | {response: any}>} false when there was nothing to recover;
 *   otherwise the LAST navigation response, or `{response: null}` if recovery went through
 *   the "Try again" button instead of a reload.
 *
 * The response is returned, not discarded, because the caller's Cloudflare verdict is keyed on
 * navigation headers: a recovery reload that comes back `cf-mitigated: challenge` with an empty
 * title would otherwise be judged by the ORIGINAL goto's headers and never retried (Codex
 * review, round 2).
 */
async function recoverContentFailed(p, { deadline } = {}) {
  if (!await isContentFailed(p)) return false;

  // Each reload is bounded by the caller's deadline when there is one: this runs inside the
  // page-load budget, and two 30 s reloads per iteration would blow through it (Codex review).
  const reloadTimeout = () => (deadline
    ? Math.min(30000, Math.max(0, deadline - Date.now()))
    : 30000);

  // Sleeps are clamped the same way: a recovery that "succeeded" must not keep waiting after
  // the caller's budget is gone (Codex review, round 4).
  const boundedWait = (ms) => p.waitForTimeout(deadline ? Math.min(ms, Math.max(0, deadline - Date.now())) : ms);

  console.log('[load] ChatGPT content failed to load — trying recovery...');
  const tryAgain = p.getByRole('button', { name: /try again/i }).first();
  let response = null;
  try {
    await tryAgain.click({ timeout: 1500 });
    await boundedWait(3000);
  } catch {
    const t = reloadTimeout();
    if (t > 0) response = await p.reload({ waitUntil: 'domcontentloaded', timeout: t }).catch(() => null);
  }

  if (await isContentFailed(p)) {
    const t = reloadTimeout();
    if (t > 0) {
      response = await p.reload({ waitUntil: 'domcontentloaded', timeout: t }).catch(() => null) || response;
    }
  }
  await boundedWait(1500).catch(() => {});
  await dismissModals(p).catch(() => {});
  return { response };
}

// ==== Session degradation recovery (2026-07-10: three incidents in one day) ====
// Degraded-session signatures (stuck pill menu, hidden send button under the Work
// onboarding overlay) used to require a MANUAL pod restart. Instead: failures mark a
// pending page reset; the next operation consumes it (fresh page), a repeat escalates to
// hardResetBrowser(); /health/live (see src/progress.js) is the last-resort pod restart.
// Explicit two-level machine (Codex result-review): 'healthy' → page reset puts us in
// 'probation'; a degradation DURING probation escalates straight to hardResetBrowser().
// Probation ends ONLY on a verified-healthy completion (markHealthyCompletion) — not
// merely on the next request arriving, which used to let repeated menu-fails ping-pong
// on page resets forever without ever escalating.
let recoveryState = 'healthy'; // 'healthy' | 'probation'
let pendingReset = null;       // null | 'page' | 'hard'
let consecutiveMenuFailures = 0;

function markSessionDegraded(reason) {
  pendingReset = recoveryState === 'probation' ? 'hard' : 'page';
  console.log(`[recovery] session degraded (${reason}) — ${pendingReset} reset pending`);
}

// Drop a pending reset that has already been satisfied by a rebuild we just did ourselves.
// Only ever called after a CONFIRMED-live probe on the fresh page, so this cannot swallow a
// degradation that still needs acting on.
function consumePendingReset(reason) {
  if (!pendingReset) return;
  console.log(`[recovery] dropping the pending ${pendingReset} reset — ${reason}`);
  pendingReset = null;
}

// A fully healthy op (verified level switch or clean completion) ends probation.
function markHealthyCompletion() {
  if (recoveryState !== 'healthy') console.log('[recovery] healthy completion — probation over');
  recoveryState = 'healthy';
  consecutiveMenuFailures = 0;
}

// Called at the start of every operation, BEFORE ensureLoggedIn (getPage recreates the page).
async function maybeRecoverSession() {
  if (!pendingReset) return;
  const kind = pendingReset;
  pendingReset = null;
  if (kind === 'hard') {
    console.log('[recovery] degradation during probation — hard browser reset');
    await hardResetBrowser().catch((e) => console.log('[recovery] hard reset failed:', e.message));
    recoveryState = 'probation'; // still on probation until a healthy completion
    return;
  }
  console.log('[recovery] consuming pending page reset (entering probation)');
  recoveryState = 'probation';
  resetPage();
}

// Work-onboarding overlay (rolled out with the Pro/Work update, 2026-07-10): a dialog with
// a Skip button that covers the composer — the send button becomes "invisible" and Enter
// goes nowhere. Dismiss with a REAL click (React/Radix must unmount it properly; raw DOM
// removal leaves a pointer-events lock on <body>), then persist the acknowledged state.
async function dismissWorkOnboarding(p) {
  try {
    // Scoped to the onboarding surface (`button.behavior-btn` / a dialog) — a bare
    // Skip/«Пропустить» text-match could hit the A/B image-variant block in reuseChat.
    const skip = p.locator('button.behavior-btn, [role="dialog"] button')
      .filter({ hasText: /^(пропустить|skip)$/i }).first();
    // NB: locator.isVisible() returns IMMEDIATELY (its timeout option is ignored) — a
    // late-rendering overlay needs a real wait (agy result-review).
    const visible = await skip.waitFor({ state: 'visible', timeout: 800 }).then(() => true).catch(() => false);
    if (!visible) return false;
    await skip.click({ timeout: 1200 });
    await p.waitForTimeout(500).catch(() => {});
    // Clear a possible leftover click-lock, then persist so the overlay doesn't return
    // on the next fresh page from the same session.
    await p.evaluate(() => {
      document.body.style.pointerEvents = 'auto';
      document.documentElement.style.pointerEvents = 'auto';
    }).catch(() => {});
    await saveSession().catch(() => {});
    console.log('[ui-adapter] Work onboarding dismissed (Skip clicked)');
    return true;
  } catch {
    return false;
  }
}

// Unified composer preflight — MUST run before any composer interaction, including
// reuseChat turns: dismiss overlays first, then force the Chat surface, then legacy modals.
async function composerPreflight(p) {
  await dismissWorkOnboarding(p);
  await ensureChatMode(p);
  await dismissModals(p);
}

// 2026-07 UI: a "Chat / Work" segmented switcher sits above the thread (labels are English
// even in the RU UI). The Work surface is a different product: agentic task flows, its
// composer defaults to the TOP effort tier and its pill renders "<model> <level>"
// (e.g. "5.6 Sol Очень высокий"). The API must always drive the classic Chat surface —
// force the Chat segment whenever Work is (or may be) active. Work is the DEFAULT tab on
// the Pro account since 2026-07-10, so this runs on every preflight.
async function ensureChatMode(p) {
  try {
    const seg = await p.evaluate(() => {
      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const btns = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]')).filter(vis);
      const chat = btns.find((b) => norm(b.innerText || b.textContent) === 'chat');
      const work = btns.find((b) => norm(b.innerText || b.textContent) === 'work');
      if (!chat || !work) return { present: false };
      const isActive = (el) =>
        el.getAttribute('aria-selected') === 'true' ||
        el.getAttribute('aria-checked') === 'true' ||
        el.getAttribute('aria-current') != null ||
        ['active', 'checked', 'on'].includes(el.getAttribute('data-state') || '');
      return { present: true, chatActive: isActive(chat), workActive: isActive(work) };
    });
    if (!seg || !seg.present) return;
    if (seg.chatActive && !seg.workActive) return;
    // Work active — or the active marker is unreadable. Clicking Chat is idempotent.
    await p.getByRole('button', { name: /^chat$/i }).first().click({ timeout: 1200 }).catch(() => {});
    await p.waitForTimeout(600).catch(() => {});
    // Verify the switch actually landed on Chat: the Work composer pill carries a model
    // prefix ("5.6 Sol Очень высокий"), the Chat pill is a plain level name. Staying on
    // Work is NOT acceptable (wrong effort tier, agentic behavior) — fail the request
    // fast and let the retry machinery run it on a recovered session.
    const pillNow = await p.locator('.__composer-pill').last().innerText({ timeout: 800 }).catch(() => '');
    const looksWork = PILL_MODEL_PREFIX.test((pillNow || '').trim());
    console.log(`[ui-adapter] Chat/Work switcher: forced Chat (workActive=${seg.workActive}, pill now "${(pillNow || '').trim()}"${looksWork ? ' — STILL LOOKS LIKE WORK' : ''})`);
    if (looksWork) {
      markSessionDegraded('still on Work surface after forced Chat switch');
      const err = new Error('Could not switch composer from Work to Chat');
      err.code = 'page_load_failed';
      throw err;
    }
  } catch (err) {
    if (err && err.code === 'page_load_failed') throw err;
    // best-effort otherwise — switcher may simply be absent
  }
}

async function ensureNewChat(p) {
  const url = p.url();
  if (url !== `${CHATGPT_URL}/` && url !== CHATGPT_URL) {
    await p.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await recoverContentFailed(p);

  for (let i = 0; i < 15; i++) {
    const textarea = await p.$('[id="prompt-textarea"]:visible, textarea:visible');
    if (textarea) break;
    await p.waitForTimeout(1000);
  }

  await composerPreflight(p);
  await clearComposer(p);
  await removePendingAttachments(p);
}

// Multi-turn: open an EXISTING conversation (https://chatgpt.com/c/<uuid>) instead of
// starting a new chat. The id is validated (UUID) both here and at the route layer —
// it is interpolated into a URL, so nothing else may pass. A conversation that does
// not load (deleted, foreign account, bad id) fails fast as page_load_failed.
async function openConversation(p, conversationId) {
  if (!isValidConversationId(conversationId)) {
    const e = new Error(`Invalid conversation_id: ${String(conversationId).slice(0, 64)}`);
    e.code = 'invalid_request';
    throw e;
  }
  const target = `${CHATGPT_URL}/c/${conversationId.toLowerCase()}`;
  if (p.url() !== target) {
    console.log(`[multi-turn] opening existing conversation ${conversationId}`);
    await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await recoverContentFailed(p);

  let composer = null;
  for (let i = 0; i < 15; i++) {
    composer = await p.$('[id="prompt-textarea"]:visible, textarea:visible');
    if (composer) break;
    // A missing/foreign conversation bounces back to the new-chat URL or shows an
    // error state — poll a bit, then fail below if the composer never appeared.
    await p.waitForTimeout(1000);
  }
  // NB: a valid-but-unknown UUID must NOT be classified page_load_failed — that kind
  // is transient/retryable and repeated attempts escalate to a hard browser reset,
  // letting one bad client id burn the whole session (Codex P1). Deterministic
  // failure → dedicated non-retryable kind, HTTP 404.
  if (!composer) {
    const e = new Error(`Conversation ${conversationId} did not load (not found or not accessible from this account)`);
    e.code = 'conversation_not_found';
    throw e;
  }
  // The composer can exist while the SPA silently dropped us on a NEW chat (id not
  // found → redirect to /). Continuing there would fork a fresh conversation while
  // the client believes it continued the old one — fail honestly instead.
  if (conversationIdFromUrl(p.url()) !== conversationId.toLowerCase()) {
    const e = new Error(`Conversation ${conversationId} is not open (redirected to ${p.url()})`);
    e.code = 'conversation_not_found';
    throw e;
  }

  await composerPreflight(p);
  await clearComposer(p);
  await removePendingAttachments(p);
}

// Count visible "Remove …" chips that ChatGPT renders for each pending attachment
// in the composer. Covers Remove file/attachment/image and Russian "Удалить".
async function countAttachmentChips(p) {
  return await p.evaluate(() => {
    const sels = [
      'button[aria-label^="Remove file"]',
      'button[aria-label^="Remove attachment"]',
      'button[aria-label^="Remove image"]',
      'button[aria-label^="Удалить"]',
    ];
    let count = 0;
    for (const sel of sels) count += document.querySelectorAll(sel).length;
    return count;
  }).catch(() => 0);
}

// Upload one or more images to the chat via the native <input type="file"> element.
// imageInputs: single {buffer, mimeType, filename} or array thereof.
// Atomic: a single setInputFiles(array) — appending later would REPLACE the file set.
// Retries the whole set up to UPLOAD_MAX_ATTEMPTS times (default 3) requiring the
// final chip count to be >= files.length before considering the upload confirmed.
// Returns the number of attachment chips visible after the last attempt. Caller
// should compare to files.length to decide whether to fail the request.
async function uploadImage(p, imageInputs) {
  const list = Array.isArray(imageInputs) ? imageInputs : [imageInputs];
  if (list.length === 0) return 0;

  const files = list.map((inp, i) => ({
    name: inp.filename || `upload_${i}.png`,
    mimeType: inp.mimeType || 'image/png',
    buffer: inp.buffer,
  }));
  const totalBytes = files.reduce((sum, f) => sum + (f.buffer ? f.buffer.length : 0), 0);
  const maxAttempts = parseInt(process.env.UPLOAD_MAX_ATTEMPTS, 10) || 3;
  // Per-attempt wait budget. Keep parity with the previous single-shot timing
  // (30+10*(N-1) cap 60) so a slow-but-eventual preview still wins on attempt 1.
  // Retries only trigger when the chip count is truly stuck below files.length.
  const waitIters = Math.min(30 + 10 * (files.length - 1), 60);

  // Prefer the dedicated photos input (id="upload-photos") over the camera one.
  // React on this input ignores Playwright's setInputFiles alone — we must
  // dispatch input/change events ourselves to wake the composer.
  const fileInput = p.locator('#upload-photos, input[type="file"]:not(#upload-camera)').first();
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });

  let lastChipCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // Before wiping anything, double-check that the previous attempt didn't get
      // a late preview chip — if it did, accept success instead of clobbering it.
      const lateCount = await countAttachmentChips(p);
      if (lateCount >= files.length) {
        console.log(`[upload] Attempt ${attempt - 1}: preview confirmed late (${lateCount}/${files.length} chips), skipping retry`);
        await p.waitForTimeout(500 + 200 * Math.max(0, files.length - 1));
        await p.waitForTimeout(1000);
        return lateCount;
      }
      // Clear any leftover chips from the previous failed attempt before retrying.
      console.log(`[upload] Attempt ${attempt}/${maxAttempts}: clearing leftover attachments...`);
      await removePendingAttachments(p);
      // Reset the input file set as well — late chip events from the previous
      // setInputFiles could otherwise arrive after we resubmit.
      await fileInput.setInputFiles([]).catch(() => {});
      for (let i = 0; i < 5; i++) {
        const c = await countAttachmentChips(p);
        if (c === 0) break;
        await p.waitForTimeout(500);
      }
    }

    console.log(`[upload] Attempt ${attempt}/${maxAttempts}: uploading ${files.length} file(s) via setInputFiles (${totalBytes} bytes total)...`);
    await fileInput.setInputFiles(files);
    await fileInput.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});

    let confirmedThisAttempt = 0;
    for (let i = 0; i < waitIters; i++) {
      const chipCount = await countAttachmentChips(p);
      if (chipCount > confirmedThisAttempt) confirmedThisAttempt = chipCount;
      if (chipCount >= files.length) break;
      await p.waitForTimeout(1000);
    }

    lastChipCount = confirmedThisAttempt;
    if (confirmedThisAttempt >= files.length) {
      console.log(`[upload] Attempt ${attempt}: preview confirmed (${confirmedThisAttempt}/${files.length} chips)`);
      // Small settle — ChatGPT React state can flicker between setInputFiles and visible chip
      await p.waitForTimeout(500 + 200 * Math.max(0, files.length - 1));
      await p.waitForTimeout(1000);
      return confirmedThisAttempt;
    }

    console.log(`[upload] Attempt ${attempt}: only ${confirmedThisAttempt}/${files.length} chips visible after ~${waitIters}s`);
  }

  console.log(`[upload] All ${maxAttempts} attempts exhausted — only ${lastChipCount}/${files.length} chips visible`);
  return lastChipCount;
}

async function clearComposer(p) {
  const textareaLocator = p.locator('#prompt-textarea');
  const count = await textareaLocator.count();
  if (!count) return;

  await textareaLocator.first().click();
  await p.waitForTimeout(150);
  await p.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await p.keyboard.press('Backspace');
  await p.waitForTimeout(150);
}

async function removePendingAttachments(p) {
  await p.evaluate(() => {
    const selectors = [
      'button[aria-label^="Remove file"]',
      'button[aria-label^="Remove attachment"]',
      'button[aria-label^="Remove image"]',
      'button[aria-label^="Удалить"]',
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(btn => btn.click());
    }
  }).catch(() => {});
}

async function saveDebugSnapshot(p, label) {
  if (!DEBUG_SNAPSHOTS_ENABLED) return;
  try {
    fs.mkdirSync(DEBUG_SNAPSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${DEBUG_SNAPSHOT_DIR}/${ts}_${label}`;
    await p.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await p.content().catch(() => '');
    if (html) fs.writeFileSync(`${base}.html`, html);
    console.log(`[debug] Snapshot saved: ${base}.{png,html}`);
  } catch (e) {
    console.log('[debug] Snapshot failed:', e.message);
  }
}

async function captureConversationState(p) {
  return await p.evaluate(() => {
    const text = document.body.innerText || '';
    // Keep the filter in sync with imageOutcomePredicate: user-turn images (uploaded
    // attachments rendered in sent messages) are excluded on both sides of the diff.
    const notInUserTurn = (el) => !(el.closest && el.closest('[data-message-author-role="user"]'));
    const imageIds = Array.from(document.querySelectorAll('div[id^="image-"]'))
      .filter(notInUserTurn)
      .map(el => el.id)
      .filter(Boolean);
    const largeImages = Array.from(document.querySelectorAll('img'))
      .filter(img => img.naturalWidth > 200 && img.naturalHeight > 200 && img.src)
      .filter(notInUserTurn)
      .map(img => img.src);

    return {
      imageIds,
      largeImages,
      tailText: text.slice(-500),
    };
  });
}

async function captureTextState(p) {
  return await p.evaluate(() => {
    const getAssistantMessages = () => {
      const explicit = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      const nodes = explicit.length
        ? explicit
        : Array.from(document.querySelectorAll('article, [data-testid*="conversation-turn"]'))
          .filter(el => {
            const text = (el.innerText || '').trim();
            return text && !/^\s*(you|вы)\s*$/i.test(text);
          });
      return nodes
        .map(el => (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim())
        .filter(Boolean);
    };

    const assistantMessages = getAssistantMessages();
    return {
      assistantCount: assistantMessages.length,
      lastAssistantText: assistantMessages[assistantMessages.length - 1] || '',
      bodyTail: (document.body.innerText || '').slice(-1000),
    };
  });
}

// Placeholder text ChatGPT shows in the assistant message bubble WHILE reasoning
// is still in progress (the collapsible "Thinking" block before the actual answer
// is streamed in). If the extractor grabs this and returns early, the caller sees
// {"text":"Thinking"} instead of the real reply. Match the exact placeholder forms
// we have observed; anything longer or substantively different is treated as a
// real answer.
const REASONING_PLACEHOLDER_RE = /^(?:thinking|reasoning|thought for[^\n]*|думаю|размышляю|размышляет|анализирую|анализ)[\s.…]*$/i;
function isReasoningPlaceholder(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;
  return REASONING_PLACEHOLDER_RE.test(trimmed);
}

async function waitAndExtractText(p, beforeState = { assistantCount: 0, lastAssistantText: '', bodyTail: '' }, options = {}) {
  console.log('Waiting for text response...');
  const start = Date.now();
  let bestText = '';
  let stableSince = 0;
  const isThinking = options.thinkingMode && options.thinkingMode !== 'instant';
  // Reasoning streams the answer AFTER an internal "Thinking" placeholder pass —
  // require a longer stable window so we don't snapshot the placeholder by accident.
  const stableMs = isThinking ? 5000 : 2500;

  // Adaptive deadline: starts at the base budget and is extended once if ChatGPT is
  // still actively generating when it elapses (stop-button visible at the boundary).
  const baseBudgetMs = responseBaseBudgetMs(options.inputMs);
  if (baseBudgetMs < CHAT_COMPLETION_TIMEOUT_MS) {
    console.log(`[chat] slow prompt input (${Math.round(options.inputMs / 1000)}s) — response base window ${Math.round(baseBudgetMs / 1000)}s`);
  }
  let deadline = start + baseBudgetMs;
  let extended = false;
  const STOP_BTN_SELECTOR = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Остановить"]';

  // Stuck-generation guard state: any observable change in the assistant text or body tail
  // counts as progress. See CHAT_STALL_WINDOW_MS. Thinking modes get a doubled window —
  // long reasoning can legitimately keep the visible text static for a while, and cutting
  // a live extended run is worse than waiting one extra window on a stuck one.
  const stallWindowMs = isThinking ? CHAT_STALL_WINDOW_MS * 2 : CHAT_STALL_WINDOW_MS;
  let lastSnapshot = null;
  let lastProgressAt = start;
  // Stream-rescue: максимум один reload за turn (флаг взводится ТОЛЬКО при фактическом
  // reload — пропуск из-за URL не /c/ не сжигает попытку; result-ревью Codex+agy).
  let rescueAttempted = false;
  let rescueSkipLogged = false;

  // Backend-api capture (READ_VIA_BACKEND_API=1): preferred source when it delivers a
  // complete answer; DOM scraping below stays untouched as the fallback.
  const capture = options.capture || null;
  let lastBackendLen = 0;
  const emitDelta = (fullText) => {
    if (!options.onDelta || !fullText) return;
    try { options.onDelta(fullText); } catch {}
  };

  while (true) {
    if (capture) {
      const snap = capture.snapshot();
      if (snap.lastAssistantText.length !== lastBackendLen) {
        lastBackendLen = snap.lastAssistantText.length;
        lastProgressAt = Date.now(); // streamed backend deltas are live progress
        emitDelta(snap.lastAssistantText);
      }
      if (snap.isComplete && snap.lastAssistantText) {
        console.log(`[backend-read] answer taken from backend-api stream (${snap.lastAssistantText.length} chars)`);
        return { text: snap.lastAssistantText, conversationId: snap.conversationId || conversationIdFromUrl(p.url()) };
      }
      // Post-reload path (stream-rescue): the conversation GET carries the finished
      // answer. Only trust a fetch made during THIS turn with genuinely new text.
      if (lastConversationFetch && lastConversationFetch.at >= start
          && lastConversationFetch.isComplete && lastConversationFetch.lastAssistantText
          && lastConversationFetch.lastAssistantText !== (beforeState.lastAssistantText || '')) {
        console.log('[backend-read] answer taken from conversation fetch after reload');
        emitDelta(lastConversationFetch.lastAssistantText);
        return {
          text: lastConversationFetch.lastAssistantText,
          conversationId: lastConversationFetch.conversationId || conversationIdFromUrl(p.url()),
        };
      }
    }

    const state = await captureTextState(p).catch(() => null);
    if (state) {
      // Successful page poll = the browser event loop is alive — feed /health/live so a
      // long legitimate wait is never mistaken for a wedged process.
      liveness.touch();
      const snapshot = `${state.assistantCount}\u0000${state.lastAssistantText}\u0000${state.bodyTail}`;
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        lastProgressAt = Date.now();
      }
      if (/content failed to load/i.test(state.bodyTail || '')) {
        await saveDebugSnapshot(p, 'content_failed').catch(() => {});
        const err = new Error('ChatGPT content failed to load');
        err.code = 'page_load_failed';
        throw err;
      }

      // The other way an exhausted Pro quota shows up: the tier stayed selectable, we ran on
      // it, and instead of an answer ChatGPT posts a limit notice. Before this it burned the
      // whole budget and surfaced as a timeout — plus a stall-abort that marked the session
      // degraded, i.e. a page reset over a perfectly healthy session.
      //
      // Only checked while there is no answer yet, and the caller's own prompt is subtracted
      // (it is on the page too). No resend here: the prompt has been submitted, and this
      // failure is reported as a retryable `tier_limit` — the memo below makes the retry land
      // on the fallback tier automatically.
      // Guards, on top of `armedFor` and prompt-subtraction — all three exist because the
      // input is whole-page text:
      //   1. no assistant text yet (DOM), so a model ANSWERING a question about Pro limits
      //      cannot abort its own request mid-stream;
      //   2. no backend delta for THIS turn either — the DOM lags the stream, and aborting
      //      after bytes reached the client is unrecoverable;
      //   3. the notice must be NEW. On a `conversation_id` continuation the page still holds
      //      the previous turn, so a banner from an hour ago would kill every following
      //      request in that conversation (Codex found this).
      const noAnswerYet = !bestText
        && lastBackendLen === 0
        && (!state.lastAssistantText || state.lastAssistantText === beforeState.lastAssistantText);
      if (noAnswerYet) {
        const limit = detectTierLimit(state.bodyTail || '', options.thinkingMode, {
          prompt: options.prompt,
          seen: beforeState.bodyTail,
        });
        if (limit) {
          tierAvailability.noteUnavailable(limit.tier, 'quota-banner', { stickyAfter: 1 });
          await saveDebugSnapshot(p, 'tier_limit').catch(() => {});
          const err = new Error(`ChatGPT reported the ${limit.tier} tier limit for this account`);
          err.code = 'tier_limit';
          err.modelMessage = limit.text;      // ChatGPT's own wording, verbatim
          throw err;
        }
      }

      const hasNewMessage = state.assistantCount > (beforeState.assistantCount || 0);
      const textChanged = state.lastAssistantText && state.lastAssistantText !== beforeState.lastAssistantText;
      let candidate = (hasNewMessage || textChanged) ? state.lastAssistantText : '';
      // In thinking modes the bubble briefly contains just "Thinking" / "Reasoning"
      // before the real answer streams in. Refuse to accept it as the final text.
      if (candidate && isThinking && isReasoningPlaceholder(candidate)) {
        candidate = '';
      }

      if (candidate && candidate !== bestText) {
        bestText = candidate;
        stableSince = Date.now();
        // Stream DOM text only when there is NO backend capture: DOM innerText and
        // backend deltas are different renderings of the answer — interleaving them
        // in one append-only SSE stream corrupts it (Codex P1). With a capture, DOM
        // text reaches the client via finish() if the backend never streamed.
        if (!capture) emitDelta(bestText);
      }

      const stopBtn = await p.$(STOP_BTN_SELECTOR).catch(() => null);
      if (bestText && !stopBtn && stableSince && Date.now() - stableSince >= stableMs) {
        return { text: bestText, conversationId: conversationIdFromUrl(p.url()) };
      }
    }

    // Stream-rescue: сервер уже мог ответить, а стрим в headless не дорисовал текст
    // (2026-07-11, markdown-new-styling: пустой <p> в result-thinking, вечная точка).
    // Один reload — готовый ответ рендерится статически. Гейты против ложных срабатываний:
    //   - таймер от lastProgressAt (живой thinking тикает UI → это прогресс → rescue ждёт);
    //   - stop-button виден = живая генерация, НЕ релоадим (agy: reload оборвал бы её;
    //     в сломанном рендере stop-button отсутствует — проверено по stalled-снапшоту);
    //   - URL ещё не /c/<id> → reload дал бы пустой новый чат; попытку НЕ сжигаем.
    if (!bestText && !rescueAttempted
        && Date.now() - lastProgressAt >= CHAT_STREAM_RESCUE_MS
        && Date.now() - start >= CHAT_STREAM_RESCUE_MS) {
      const generating = await p.$(STOP_BTN_SELECTOR).catch(() => null);
      if (generating) {
        // Живая генерация без прогресса текста — оставляем это stall-guard'у.
      } else if (!/\/c\//.test(p.url())) {
        if (!rescueSkipLogged) {
          rescueSkipLogged = true;
          console.log(`[rescue] page still at ${p.url()} (not /c/) — reload rescue deferred`);
        }
      } else {
        rescueAttempted = true;
        console.log(`[rescue] no rendered text for ${Math.round((Date.now() - lastProgressAt) / 1000)}s after submit — reloading page to fetch server-side result`);
        const reloaded = await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
          .then(() => true)
          .catch(e => { console.log('[rescue] reload failed:', e.message); return false; });
        if (reloaded) {
          // Успешный reload: страница строится заново — свежее окно на рендер готового
          // ответа. При ошибке reload таймеры НЕ трогаем (Codex: иначе неудачный rescue
          // оттягивает stall-abort ещё на целое окно и держит очередь).
          lastProgressAt = Date.now();
          lastSnapshot = null;
        }
        continue;
      }
    }

    // EARLY stall-abort (Codex plan-review 1.2.31): don't wait the full base budget on a
    // frozen page. No observable change for a whole stall window AND no candidate answer
    // yet → the session is degraded; fail fast, release the queue, mark for page reset.
    if (!bestText && Date.now() - lastProgressAt >= stallWindowMs && Date.now() - start >= stallWindowMs) {
      markSessionDegraded(`text turn stalled: no page progress for ${Math.round((Date.now() - lastProgressAt) / 1000)}s`);
      await saveDebugSnapshot(p, 'text_stalled').catch(() => {});
      const err = new Error(`ChatGPT page showed no progress for ${Math.round(stallWindowMs / 1000)}s after submit`);
      err.code = 'timeout';
      throw err;
    }

    if (Date.now() >= deadline) {
      // Re-check live progress at the boundary — don't trust a possibly-stale poll
      // (captureTextState may have returned null). If ChatGPT is still streaming/
      // thinking, grant one extra window instead of cutting an in-progress answer.
      if (!extended) {
        const stillGenerating = await p.$(STOP_BTN_SELECTOR).catch(() => null);
        const progressedRecently = Date.now() - lastProgressAt < stallWindowMs;
        if (stillGenerating && progressedRecently) {
          extended = true;
          deadline = Date.now() + CHAT_COMPLETION_RETRY_TIMEOUT_MS;
          console.log(`[chat] base ${Math.round(CHAT_COMPLETION_TIMEOUT_MS / 1000)}s elapsed, still generating — extending +${Math.round(CHAT_COMPLETION_RETRY_TIMEOUT_MS / 1000)}s`);
          continue;
        }
        if (stillGenerating) {
          // Stop-button visible but the page hasn't changed in a long time — a stuck UI, not
          // a live generation. Don't extend: fail fast and release the queue.
          console.log(`[chat] stop-button visible but no page progress for ${Math.round((Date.now() - lastProgressAt) / 1000)}s — treating as stuck, not extending`);
        }
      }
      break;
    }

    await p.waitForTimeout(1000);
  }

  if (bestText) return { text: bestText, conversationId: conversationIdFromUrl(p.url()) };
  await saveDebugSnapshot(p, 'text_timeout').catch(() => {});
  const err = new Error('ChatGPT did not return a text response in time');
  err.code = 'timeout';
  throw err;
}

// Page-context predicate for waitForFunction. Returns one of:
// 'success' | 'policy' | 'refused' | 'limit' | false (keep polling).
// Lifted out so adaptive retry can reuse the exact same logic.
function imageOutcomePredicate({ previousImageIds, previousLargeImages, previousTailText }) {
  const textRaw = document.body.innerText || '';
  // ChatGPT renders typographic apostrophes ("We’re so sorry", "can’t") — normalize to
  // straight quotes so ASCII patterns below actually match the live UI text.
  const normApos = (s) => (s || '').toLowerCase().replace(/[‘’]/g, "'");
  const text = normApos(textRaw);
  // Images inside USER turns are the just-uploaded edit/reference attachments rendered
  // full-size in the sent message — they must NOT count as a generation result
  // (otherwise an edit request that gets refused looks like instant "success").
  const notInUserTurn = (el) => !(el.closest && el.closest('[data-message-author-role="user"]'));
  const imageIds = Array.from(document.querySelectorAll('div[id^="image-"]'))
    .filter(notInUserTurn)
    .map(el => el.id)
    .filter(Boolean);
  const largeImages = Array.from(document.querySelectorAll('img'))
    .filter(img => img.naturalWidth > 200 && img.naturalHeight > 200 && img.src)
    .filter(notInUserTurn)
    .map(img => img.src);
  const hasNewImageId = imageIds.some(id => !previousImageIds.includes(id));
  const hasNewLargeImage = largeImages.some(src => !previousLargeImages.includes(src));
  const newTail = textRaw.slice(-500);
  const tailChanged = newTail !== previousTailText;
  const prevTextLower = normApos(previousTailText);
  const tailNorm = normApos(newTail);
  // Scope refusal/policy text detection to the LAST ASSISTANT turn when the DOM exposes
  // turn roles — the user's own prompt (which may legitimately contain words like
  // "copyright" or "watermark") must never trigger policy detection. Fall back to the
  // body tail when the turn structure is not readable (old behavior).
  const assistantTurns = document.querySelectorAll('[data-message-author-role="assistant"]');
  const lastAssistantRaw = assistantTurns.length
    ? ((assistantTurns[assistantTurns.length - 1].innerText || ''))
    : '';
  const scanNorm = lastAssistantRaw ? normApos(lastAssistantRaw.slice(-600)) : tailNorm;
  // "New" = present in the scanned text and NOT already present before submit — an old
  // refusal/success from a previous reuseChat turn must not decide the fresh request.
  const isNew = (phrase) => scanNorm.includes(phrase) && !prevTextLower.includes(phrase);
  const tailIsNew = (phrase) => tailNorm.includes(phrase) && !prevTextLower.includes(phrase);

  // --- Refusals FIRST (before any success signal) -------------------------------------
  // System refusal banners (2026-07 UI), verbatim examples from live screenshots:
  //   "We're so sorry, but the image we created may violate our guardrails around
  //    potential fraudulent or scam activity. …"
  //   "We're so sorry, but the prompt may violate our content policies. …"
  //   "We're so sorry, but the image we created may violate our guardrails around
  //    nudity, sexuality, or erotic content. …"
  // Order matters twice: (a) in the edit flow the just-sent user attachment can look like
  // a new large image, (b) ChatGPT can render an image and THEN block it with a banner.
  if (tailChanged) {
    const soSorry = isNew("we're so sorry") || isNew('we are so sorry') || isNew('нам очень жаль');
    if (soSorry) {
      return (scanNorm.includes('violate') || scanNorm.includes('guardrail')
        || scanNorm.includes('polic') || scanNorm.includes('нарушает')) ? 'policy' : 'refused';
    }
    if (isNew('violate our guardrails') || isNew('violate our content polic')
      || isNew('if you think we got it wrong')) return 'policy';
  }

  // --- Success -------------------------------------------------------------------------
  if (tailChanged && (tailIsNew('image created') || tailIsNew('images created'))) return 'success';
  if (tailChanged && (tailIsNew('изображение создано') || tailIsNew('изображения созданы'))) return 'success';
  if (hasNewImageId || hasNewLargeImage) return 'success';

  // Rate-limit banner is rendered as a system notice (not necessarily an assistant
  // turn) — keep the whole-body check.
  if (text.includes('reached your image creation limit') || text.includes('достигли лимита')) return 'limit';

  const policyPatterns = [
    'copyright', 'real person', 'deepfake', 'against our policy', 'against our policies',
    'нарушает', 'авторск', 'реальн', 'дипфейк', 'политик', 'правила', 'guardrail',
  ];
  if (tailChanged && policyPatterns.some(pattern => isNew(pattern))) return 'policy';

  const refusalPatterns = [
    "i'm not able to", 'i am not able to', "i can't", 'i cannot',
    'unable to generate', 'unable to create', 'unable to edit', 'unable to help',
    "can't help", 'cannot help', "i won't", 'i will not',
    'не могу', 'не могу помочь', 'не могу создать', 'не могу отредактировать',
    'не могу выполнить', 'не получится', 'не в состоянии',
  ];
  if (tailChanged && refusalPatterns.some(pattern => isNew(pattern))) return 'refused';

  return false;
}

// Discriminate "ChatGPT silently stuck" vs "still actively thinking/generating"
// vs "already produced a refusal that the main predicate's tail-diff missed".
// Used after the first waitForFunction timeout to decide adaptive retry.
async function readProgressIndicators(p, previousTailText = '') {
  return await p.evaluate((prevTailRaw) => {
    const normApos = (s) => (s || '').toLowerCase().replace(/[‘’]/g, "'");
    const bodyText = document.body.innerText || '';
    const tail = bodyText.slice(-600);
    // Normalize typographic apostrophes ("We’re", "can’t") so ASCII patterns match.
    const tailLower = normApos(tail);
    const prevLower = normApos(prevTailRaw);

    // Prefer the last assistant turn as the verbatim model message — the body tail
    // also contains footer/composer chrome that only confuses the API client.
    const readLastAssistantText = () => {
      const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = turns[turns.length - 1];
      const t = last ? (last.innerText || '').trim() : '';
      return t ? t.slice(0, 600) : '';
    };
    // Scope pattern scan to the last assistant turn when readable (the user's own prompt
    // must not look like a refusal); require the match to be NEW vs the pre-submit tail
    // so a stale refusal from a previous reuseChat turn doesn't fail a fresh request.
    const scanLower = normApos(readLastAssistantText()) || tailLower;
    const isNewMatch = (re) => {
      const m = scanLower.match(re);
      return !!(m && !prevLower.includes(m[0]));
    };

    const soSorry = /we'?re so sorry|we are so sorry|нам очень жаль/i;
    const policy = /violate our guardrails|violate our content polic|if you think we got it wrong|copyright|real person|deepfake|against our polic|нарушает|авторск|реальн|дипфейк|политик|правила|guardrail/i;
    const refusal = /i'm not able to|i am not able to|i can't|i cannot|unable to (generate|create|edit|help)|can't help|cannot help|i won't|i will not|не могу|не получится|не в состоянии/i;
    if (isNewMatch(soSorry)) {
      const kind = /violate|guardrail|polic|нарушает/i.test(scanLower) ? 'policy' : 'refused';
      return { refusalLikely: true, kind, modelMessage: readLastAssistantText() || tail.trim() };
    }
    if (isNewMatch(policy)) return { refusalLikely: true, kind: 'policy', modelMessage: readLastAssistantText() || tail.trim() };
    if (isNewMatch(refusal)) return { refusalLikely: true, kind: 'refused', modelMessage: readLastAssistantText() || tail.trim() };

    const stopBtn = !!document.querySelector(
      'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Остановить"]'
    );
    const activeText = /creating image|creating an image|creating images|generating image|thinking|reasoning|working on|drawing|sketching|создаю изобра|создание изобра|генериру|думаю|размышля|рисую/i.test(tailLower);
    return {
      refusalLikely: false,
      activeGeneration: stopBtn || activeText,
      stopBtn,
      activeText,
      tailSnippet: tail.slice(-200),
    };
  }, previousTailText || '').catch(() => ({ refusalLikely: false, activeGeneration: false }));
}

// Read visible UI error banners/toasts (composer upload failures, "Something went
// wrong" system errors). These render OUTSIDE assistant turns, so the refusal
// detection above never sees them — but their text is exactly what the API client
// needs to understand a failed request. Returns '' when nothing error-like is shown.
async function readUiErrorBanner(p) {
  return await p.evaluate(() => {
    const isVisible = (el) => {
      if (!el || (el.closest && el.closest('[aria-hidden="true"]'))) return false;
      try { return el.getClientRects().length > 0; } catch { return true; }
    };
    const seen = [];
    for (const el of document.querySelectorAll('[role="alert"], [data-testid*="toast"], [class*="toast"]')) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (t && t.length >= 5 && !seen.includes(t)) seen.push(t);
    }
    if (seen.length) return seen.join(' | ').slice(0, 500);
    // Fallback: scan visible text for known composer/upload error phrases.
    const body = (document.body.innerText || '').replace(/[‘’]/g, "'");
    const m = body.match(/[^\n]*(failed to upload|unable to upload|error uploading|upload failed|couldn't upload|can't upload|something went wrong|не удалось загрузить|ошибка загрузки|что-то пошло не так)[^\n]*/i);
    return m ? m[0].trim().slice(0, 300) : '';
  }).catch(() => '');
}

// Verbatim text of the last assistant message — the refusal banner the user sees in
// the UI. Falls back to the body tail when the turn structure is not readable.
async function readLastAssistantMessage(p) {
  return await p.evaluate(() => {
    const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
    const last = turns[turns.length - 1];
    const t = last ? (last.innerText || '').trim() : '';
    return t ? t.slice(0, 600) : (document.body.innerText || '').slice(-400);
  }).catch(() => '');
}

// Wait for image result and extract it.
// context: { prompt, thinkingMode, refs } — used for refusal logging only.
async function waitAndExtractImage(p, beforeState = { imageIds: [], largeImages: [], tailText: '' }, context = {}) {
  console.log('Waiting for image generation...');

  const waitInterval = setInterval(async () => {
    try {
      const bodyText = await p.evaluate(() => {
        const t = document.body.innerText;
        return t.length > 300 ? t.slice(-300) : t;
      });
      console.log('[waiting] Page tail:', bodyText.replace(/\n/g, ' ').substring(0, 200));
    } catch {}
  }, 15000);

  const predicateArgs = {
    previousImageIds: beforeState.imageIds || [],
    previousLargeImages: beforeState.largeImages || [],
    previousTailText: beforeState.tailText || '',
  };

  const logRefusal = (kind, modelMessage) => {
    const promptSnippet = String(context.prompt || '').slice(0, 250);
    const modelSnippet = String(modelMessage || '').slice(-200);
    const mode = context.thinkingMode || 'unknown';
    const refs = Number.isFinite(context.refs) ? context.refs : 0;
    console.log(`[${kind}] prompt="${promptSnippet}" model_message="${modelSnippet}" thinking_mode=${mode} refs=${refs}`);
  };

  const buildError = (kind, message, modelMessage) => {
    const e = new Error(message);
    e.code = kind;                // 'refused' | 'policy_violation' | 'rate_limit' | 'timeout'
    if (modelMessage) e.modelMessage = String(modelMessage).trim();
    return e;
  };

  const waitStart = Date.now();
  let outcomeHandle = null;
  try {
    outcomeHandle = await p.waitForFunction(imageOutcomePredicate, predicateArgs, { timeout: GENERATION_TIMEOUT_MS });
  } catch (err) {
    if (!err || err.name !== 'TimeoutError') {
      clearInterval(waitInterval);
      await saveDebugSnapshot(p, 'wait_error').catch(() => {});
      throw err;
    }

    // Adaptive timeout handling.
    const firstSec = Math.round(GENERATION_TIMEOUT_MS / 1000);
    let progress = await readProgressIndicators(p, beforeState.tailText || '');
    console.log(`[adaptive-timeout] first wait (${firstSec}s) timed out — progress=${JSON.stringify({
      refusalLikely: progress.refusalLikely,
      kind: progress.kind,
      activeGeneration: progress.activeGeneration,
      stopBtn: progress.stopBtn,
      activeText: progress.activeText,
    })}`);

    if (progress.refusalLikely) {
      clearInterval(waitInterval);
      await saveDebugSnapshot(p, progress.kind).catch(() => {});
      logRefusal(progress.kind, progress.modelMessage);
      const message = progress.kind === 'policy'
        ? 'ChatGPT refused: content policy violation (copyright/guardrails)'
        : 'ChatGPT refused to generate this image';
      throw buildError(
        progress.kind === 'policy' ? 'policy_violation' : 'refused',
        message,
        progress.modelMessage
      );
    }

    if (progress.activeGeneration) {
      // Keep extending in RETRY-sized chunks as long as generation stays active,
      // up to GENERATION_MAX_TIMEOUT_MS total. ChatGPT Pro image renders can take
      // several minutes; a single extension is not enough.
      const maxSec = Math.round(GENERATION_MAX_TIMEOUT_MS / 1000);
      let stillActive = true;
      while (stillActive && outcomeHandle === null) {
        const remaining = GENERATION_MAX_TIMEOUT_MS - (Date.now() - waitStart);
        if (remaining <= 0) {
          clearInterval(waitInterval);
          await saveDebugSnapshot(p, 'timeout').catch(() => {});
          throw buildError('timeout', `ChatGPT did not return an image within ${maxSec}s (adaptive max reached, still generating)`, await readUiErrorBanner(p));
        }
        const chunk = Math.min(GENERATION_RETRY_TIMEOUT_MS, remaining);
        liveness.touch(); // chunk boundary — active long generation is not a wedged process
        const elapsedSec = Math.round((Date.now() - waitStart) / 1000);
        console.log(`[adaptive-timeout] generation still active (stopBtn=${progress.stopBtn} text=${progress.activeText}) — extending +${Math.round(chunk / 1000)}s (elapsed ${elapsedSec}s / max ${maxSec}s)`);
        try {
          outcomeHandle = await p.waitForFunction(imageOutcomePredicate, predicateArgs, { timeout: chunk });
        } catch (err2) {
          if (err2 && err2.name === 'TimeoutError') {
            // Re-check progress: only keep waiting while generation is still active.
            progress = await readProgressIndicators(p, beforeState.tailText || '');
            if (progress.refusalLikely) {
              clearInterval(waitInterval);
              await saveDebugSnapshot(p, progress.kind).catch(() => {});
              logRefusal(progress.kind, progress.modelMessage);
              const message = progress.kind === 'policy'
                ? 'ChatGPT refused: content policy violation (copyright/guardrails)'
                : 'ChatGPT refused to generate this image';
              throw buildError(progress.kind === 'policy' ? 'policy_violation' : 'refused', message, progress.modelMessage);
            }
            stillActive = progress.activeGeneration;
            if (!stillActive) {
              clearInterval(waitInterval);
              await saveDebugSnapshot(p, 'timeout').catch(() => {});
              const elapsed = Math.round((Date.now() - waitStart) / 1000);
              throw buildError('timeout', `ChatGPT stopped generating without returning an image after ${elapsed}s`, await readUiErrorBanner(p));
            }
            continue;
          }
          clearInterval(waitInterval);
          await saveDebugSnapshot(p, 'wait_error').catch(() => {});
          throw err2;
        }
      }
    } else {
      clearInterval(waitInterval);
      await saveDebugSnapshot(p, 'timeout').catch(() => {});
      // A UI error banner (broken upload composer, "Something went wrong" toast) is the
      // usual reason for "no progress at all" — surface its text to the API client.
      throw buildError('timeout', `ChatGPT did not return an image within ${firstSec}s (no progress signal)`, await readUiErrorBanner(p));
    }
  }

  clearInterval(waitInterval);
  const result_type = await outcomeHandle.jsonValue();
  if (result_type !== 'success') {
    let limitText = '';
    if (result_type === 'limit') {
      limitText = await p.evaluate(() => {
        const text = document.body.innerText || '';
        const idx = text.toLowerCase().indexOf('limit');
        if (idx >= 0) return text.slice(Math.max(0, idx - 100), idx + 200);
        return text.slice(-300);
      }).catch(() => '');
      console.log('[rate-limit] ChatGPT limit text:', limitText);
    }
    // Capture the verbatim refusal text (last assistant turn preferred, body tail
    // fallback) for logging + the structured error's model_message.
    let tail = '';
    if (result_type === 'policy' || result_type === 'refused') {
      tail = await readLastAssistantMessage(p);
      logRefusal(result_type, tail);
    }
    await saveDebugSnapshot(p, result_type).catch(() => {});
    // A Pro-quota notice matches the broad `достигли лимита` image-limit phrase, and
    // `rate_limit` arms a 30-minute cooldown across EVERY endpoint. One tier being out of
    // quota must not take the whole gateway down with it (Codex review).
    // Must be computed BEFORE `errorMsgs`: an object literal evaluates every property
    // eagerly, so reading `limitKind` there hit the temporal dead zone and threw
    // `Cannot access 'limitKind' before initialization` for EVERY non-success outcome —
    // policy and refused included. Those then surfaced as `server_error` with
    // `should_retry: true`, telling clients to retry prompts that can never succeed.
    let limitKind = 'rate_limit';
    if (result_type === 'limit') {
      const tierLimit = detectTierLimit(limitText || '', context.thinkingMode);
      if (tierLimit) {
        limitKind = 'tier_limit';
        tierAvailability.noteUnavailable(tierLimit.tier, 'quota-banner', { stickyAfter: 1 });
        console.log(`[tiers] image turn hit the ${tierLimit.tier} tier limit — memoized, NOT a global rate limit`);
      }
    }
    const errorMsgs = {
      policy: 'ChatGPT refused: content policy violation (copyright/guardrails)',
      refused: 'ChatGPT refused to generate this image',
      limit: limitKind === 'tier_limit'
        ? `ChatGPT reported the pro tier limit for this account${limitText ? ': ' + limitText.trim() : ''}`
        : `ChatGPT rate limit reached${limitText ? ': ' + limitText.trim() : ', try again later'}`,
    };
    const codeMap = { policy: 'policy_violation', refused: 'refused', limit: limitKind };
    const modelMessageByKind = {
      policy: tail || '',
      refused: tail || '',
      limit: limitText || '',
    };
    throw buildError(
      codeMap[result_type] || 'server_error',
      errorMsgs[result_type] || 'ChatGPT did not generate an image',
      modelMessageByKind[result_type] || ''
    );
  }
  console.log(`Image generation detected. Waiting ${RENDER_WAIT_MS / 1000}s for image to render...`);
  await p.waitForTimeout(RENDER_WAIT_MS).catch(() => console.log('Page navigated during render wait — continuing anyway'));

  // Wait for stop-button to disappear (Image 2.0 may keep streaming partial images)
  // Soft wait — don't fail if page navigates / context destroys mid-loop
  try {
    for (let i = 0; i < 30; i++) {
      const stopBtn = await p.$('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Остановить"]').catch(() => null);
      if (!stopBtn) break;
      await p.waitForTimeout(1000).catch(() => {});
    }
  } catch (e) {
    console.log('[stop-button-wait] soft-wait error (ignored):', e.message);
  }

  // Wait for the set of NEW image containers to stabilize. ChatGPT sometimes streams
  // an A/B comparison block where two images appear sequentially — we want both
  // fully present before picking which to extract.
  const previousImageIds = beforeState.imageIds || [];
  let newImageIds = [];
  {
    let stableTicks = 0;
    const STABLE_TICKS_REQUIRED = 3; // ~3 seconds of no growth
    for (let i = 0; i < 20; i++) {
      const currentNew = await p.evaluate((prevIds) => {
        return Array.from(document.querySelectorAll('div[id^="image-"]'))
          .filter(el => !(el.closest && el.closest('[data-message-author-role="user"]')))
          .map(el => el.id)
          .filter(id => id && !prevIds.includes(id));
      }, previousImageIds);
      if (currentNew.length === newImageIds.length && currentNew.length > 0) {
        stableTicks++;
        if (stableTicks >= STABLE_TICKS_REQUIRED) {
          newImageIds = currentNew;
          break;
        }
      } else {
        stableTicks = 0;
      }
      newImageIds = currentNew;
      await p.waitForTimeout(1000);
    }
  }

  const abVariants = newImageIds.length > 1 ? newImageIds.length : 0;
  let abSelectedIndex = abVariants ? abVariants : null; // 1-based index of picked variant
  if (abVariants) {
    console.log(`[a/b] ChatGPT returned ${abVariants} variants — picking variant ${abSelectedIndex} (last in DOM order).`);

    // Click "Image N is better" / "N изображение лучше" so ChatGPT replaces the
    // tiny A/B thumbnails with a full-resolution rendering of the chosen variant.
    // Without this we extract the small preview, which has natural size ~256-512px.
    const pickedIndex = abSelectedIndex;
    const pickResult = await p.evaluate((idx) => {
      const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
      const wanted = [
        `${idx} изображение лучше`,
        `image ${idx} is better`,
        `изображение ${idx} лучше`,
      ].map(norm);
      const candidates = Array.from(document.querySelectorAll('button, label, [role="button"], [role="radio"]'));
      for (const el of candidates) {
        const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        if (!text) continue;
        if (wanted.some((w) => text.includes(w))) {
          el.click();
          return { ok: true, text: text.slice(0, 80) };
        }
      }
      return { ok: false, seen: candidates.slice(0, 30).map((c) => norm(c.innerText || c.textContent || '').slice(0, 60)).filter(Boolean) };
    }, pickedIndex);

    if (pickResult.ok) {
      console.log(`[a/b] Clicked variant chooser: "${pickResult.text}". Waiting for full-resolution render...`);
      // Give ChatGPT time to swap the thumbnail for the full-size image.
      // After the click, the chosen variant is re-rendered larger (or as a new image-* container).
      await p.waitForTimeout(3000).catch(() => {});

      // Re-snapshot new image-* IDs — ChatGPT may have inserted a new container for the
      // full-res render OR upgraded the natural size of an existing one. Prefer the
      // newest container if a new one appeared.
      const refreshed = await p.evaluate((prevIds) => {
        return Array.from(document.querySelectorAll('div[id^="image-"]'))
          .filter(el => !(el.closest && el.closest('[data-message-author-role="user"]')))
          .map(el => el.id)
          .filter(id => id && !prevIds.includes(id));
      }, previousImageIds);
      if (refreshed.length > newImageIds.length) {
        console.log(`[a/b] After pick: ${refreshed.length} new image containers (was ${newImageIds.length}) — taking newest.`);
        newImageIds = refreshed;
      }

      // Wait again for stop-button (full-res render may stream)
      try {
        for (let i = 0; i < 15; i++) {
          const stopBtn = await p.$('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Остановить"]').catch(() => null);
          if (!stopBtn) break;
          await p.waitForTimeout(1000).catch(() => {});
        }
      } catch {}
    } else {
      console.log(`[a/b] Variant chooser button not found — falling back to thumbnail extraction. Seen: ${JSON.stringify((pickResult.seen || []).slice(0, 10))}`);
    }
  }

  // Pick the newest container (last in DOM order) as the canonical result.
  const newImageId = newImageIds.length > 0
    ? newImageIds[newImageIds.length - 1]
    : await p.evaluate(() => {
        const all = Array.from(document.querySelectorAll('div[id^="image-"]'))
          .filter(el => !(el.closest && el.closest('[data-message-author-role="user"]')))
          .map(el => el.id)
          .filter(Boolean);
        return all.length > 0 ? all[all.length - 1] : null;
      });

  if (newImageId) {
    console.log(`[extract] Targeting new image container: ${newImageId}`);
  } else {
    console.log('[extract] No new image container found vs beforeState — falling back to last in DOM');
  }

  // ChatGPT removed the per-image "Download this image" button (image toolbar
  // now exposes only Edit / Share / Like / Dislike). Try the legacy selector
  // briefly in case it returns; otherwise fall straight through to canvas extraction.
  let download = null;
  if (newImageId) {
    const container = await p.$(`[id="${newImageId}"]`).catch(() => null);
    if (container) await container.hover().catch(() => {});
    await p.waitForTimeout(500);
    try {
      const hasBtn = await p.evaluate((targetId) => {
        const scope = targetId ? document.getElementById(targetId) : null;
        return !!(scope || document).querySelector('button[aria-label="Download this image"]');
      }, newImageId);
      if (hasBtn) {
        const downloadResult = await Promise.all([
          p.waitForEvent('download', { timeout: 5000 }),
          p.evaluate((targetId) => {
            const scope = targetId ? document.getElementById(targetId) : null;
            const btn = (scope || document).querySelector('button[aria-label="Download this image"]');
            if (btn) { btn.click(); return true; }
            return false;
          }, newImageId),
        ]);
        download = downloadResult[0];
      }
    } catch {}
  }

  if (download) {
    console.log('Downloaded via button:', download.suggestedFilename());
    const filePath = await download.path();
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    const ext = download.suggestedFilename().split('.').pop();
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { url: download.url(), b64_json: base64, contentType, ab_variants: abVariants, ab_selected_index: abSelectedIndex };
  }

  // Fallback: canvas extraction with polling until image is fully loaded
  // Prefer img inside the new image container (if known); otherwise pick the LAST
  // large img in the page — newest in DOM order is the freshly generated one.
  const previousLargeImages = beforeState.largeImages || [];
  console.log('Extracting image via canvas...');
  for (let i = 0; i < 12; i++) {
    const result = await p.evaluate(({ targetId, prevSrcs }) => {
      const scope = targetId ? document.getElementById(targetId) : document;
      const imgs = scope ? scope.querySelectorAll('img') : document.querySelectorAll('img');
      // Walk from end → first valid is the newest
      const all = Array.from(imgs);
      // Never extract images from USER turns — those are the caller's own uploaded
      // attachments (an edit request must not "succeed" by returning the input image).
      const inUserTurn = (img) => !!(img.closest && img.closest('[data-message-author-role="user"]'));
      let bestImg = null;
      for (let j = all.length - 1; j >= 0; j--) {
        const img = all[j];
        if (img.naturalWidth <= 200 || img.naturalHeight <= 200 || !img.src) continue;
        if (img.src.startsWith('data:image/svg')) continue;
        if (inUserTurn(img)) continue;
        // Skip images we already saw before submit (avoid stale extraction)
        if (prevSrcs.includes(img.src)) continue;
        bestImg = img;
        break;
      }
      // If no "new" image found, fall back to last large img anywhere
      if (!bestImg) {
        const anyImgs = document.querySelectorAll('img');
        const flat = Array.from(anyImgs);
        for (let j = flat.length - 1; j >= 0; j--) {
          const img = flat[j];
          if (img.naturalWidth <= 200 || img.naturalHeight <= 200 || !img.src) continue;
          if (img.src.startsWith('data:image/svg')) continue;
          if (inUserTurn(img)) continue;
          bestImg = img;
          break;
        }
      }
      if (!bestImg) return { error: 'No large image found' };
      if (!bestImg.complete) return { error: 'Image still loading' };
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bestImg.naturalWidth;
        canvas.height = bestImg.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bestImg, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        return { b64: dataUrl.split(',')[1], contentType: 'image/png', src: bestImg.src };
      } catch (e) {
        return { error: e.message, src: bestImg.src };
      }
    }, { targetId: newImageId, prevSrcs: previousLargeImages });

    if (!result.error) {
      console.log('Canvas extraction successful.');
      return { url: result.src, b64_json: result.b64, contentType: result.contentType, ab_variants: abVariants, ab_selected_index: abSelectedIndex };
    }

    console.log(`Canvas attempt ${i + 1}: ${result.error}. Waiting 5s...`);
    await p.waitForTimeout(5000);
  }

  // Extraction exhausted — do NOT return a fake success (a null b64_json used to travel
  // to the client as HTTP 200). Surface a typed retryable error with any visible UI
  // banner text attached so the caller understands what the page showed.
  await saveDebugSnapshot(p, 'extract_failed').catch(() => {});
  throw buildError(
    'server_error',
    'Image generation was detected but the image could not be extracted from the page',
    await readUiErrorBanner(p)
  );
}

// fill() of a long prompt is one ProseMirror transaction, and ChatGPT's composer handlers
// run over the whole doc: ~30k chars (a 57 KB Cyrillic body) measured at 9-27 s, so
// Playwright's default 30 s action timeout failed prompts of that size at random
// (2026-09-24). The budget grows with the text; the cap keeps a wedged composer from
// eating the client's ~600 s request budget.
const FILL_BASE_TIMEOUT_MS = 30000;
const FILL_MS_PER_CHAR = 2;
const FILL_MAX_TIMEOUT_MS = 120000;
function fillTimeoutMs(text) {
  const extra = (text ? text.length : 0) * FILL_MS_PER_CHAR;
  return Math.min(FILL_BASE_TIMEOUT_MS + extra, FILL_MAX_TIMEOUT_MS);
}
// The per-key fallback types at TYPE_DELAY_MS a character, so its honest budget is linear
// in the text. Past FILL_MAX_TIMEOUT_MS (~9k chars) it cannot finish in any budget a client
// would wait for — such a prompt fails fast instead of typing for minutes.
const TYPE_DELAY_MS = 10;
function typeFallbackTimeoutMs(text) {
  const budget = FILL_BASE_TIMEOUT_MS + (text ? text.length : 0) * TYPE_DELAY_MS;
  return budget > FILL_MAX_TIMEOUT_MS ? null : budget;
}
// Not retried (server_error is not transient for text turns): a fresh page would repeat the
// same long input, so each retry would add up to FILL_MAX_TIMEOUT_MS to the request.
function tooLongToTypeError(text, why) {
  const err = new Error(`Prompt ${why} (${text.length} chars is too long for per-key typing)`);
  err.code = 'server_error';
  return err;
}
// Input time beyond the old flat 30 s comes out of the response wait, so a slow fill of a
// long prompt does not stretch the request past what clients allowed before 2.14.2.
function responseBaseBudgetMs(inputMs) {
  const overrun = Math.max(0, (inputMs || 0) - FILL_BASE_TIMEOUT_MS);
  return Math.max(CHAT_COMPLETION_TIMEOUT_MS - overrun, 0);
}

// Type prompt and submit
// onSubmitted (optional): called the instant the send is CONFIRMED (a new user turn / stop
// button appeared), BEFORE the trailing settle wait. Callers use it to mark the prompt as
// sent so a failure in the settle window is not retried into a duplicate submission.
// timing (optional): gets `inputMs` — time spent putting the prompt into the composer — even
// when the call throws, so a caller retrying the turn can count every attempt's input.
async function typeAndSubmit(p, text, preserveAttachments = false, onSubmitted = null, timing = null) {
  console.log('Typing prompt...');
  await dismissModals(p);
  const textareaLocator = p.locator('#prompt-textarea');
  await textareaLocator.first().waitFor({ state: 'visible', timeout: 30000 });

  // fill() REPLACES the ProseMirror doc — it wipes attachments AND composer system-hint
  // tokens (the 2026-07 web-search pill lives INSIDE the editor). Preserve both by typing.
  const hasSystemHint = await p.locator('#prompt-textarea [data-system-hint-type]').count()
    .then((c) => c > 0).catch(() => false);
  const caretEndKey = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
  const inputStart = Date.now();
  const normText = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const probe = normText((text || '').split('\n')[0]).slice(0, 30);
  try {
    if (preserveAttachments || hasSystemHint) {
      // keyboard.type has no timeout of its own: a long prompt here would hold the queue for
      // as long as typing takes.
      if (typeFallbackTimeoutMs(text) === null) {
        throw tooLongToTypeError(text, `cannot be typed around the ${hasSystemHint ? 'composer token' : 'attachments'}`);
      }
      console.log(`Using keyboard type to preserve ${hasSystemHint ? 'composer token' : 'attachments'}...`);
      await textareaLocator.first().click();
      await p.keyboard.press(caretEndKey).catch(() => {});
      await p.waitForTimeout(300);
      await p.keyboard.type(text, { delay: TYPE_DELAY_MS });
    } else {
      await textareaLocator.first().fill(text, { timeout: fillTimeoutMs(text) });
    }
    await p.waitForTimeout(500);

    // Verify the PROMPT text landed — not just that the editor is non-empty. With a
    // system-hint token in the doc, textContent is truthy even if typing silently failed.
    // Probe with the first line only: ProseMirror textContent concatenates paragraphs
    // without separators, so multi-line probes would false-negative.
    const content = await textareaLocator.first().textContent();
    console.log('Prompt filled:', content ? content.substring(0, 50) + '...' : '(empty)');

    if (!content || (probe && !normText(content).includes(probe))) {
      const typeTimeout = typeFallbackTimeoutMs(text);
      if (typeTimeout === null) throw tooLongToTypeError(text, 'did not land in the composer');
      console.log('Fill failed, trying pressSequentially...');
      await textareaLocator.first().click();
      await p.keyboard.press(caretEndKey).catch(() => {});
      await p.waitForTimeout(300);
      await textareaLocator.first().pressSequentially(text, { delay: TYPE_DELAY_MS, timeout: typeTimeout });
      await p.waitForTimeout(500);
    }
  } finally {
    if (timing) timing.inputMs = Date.now() - inputStart;
  }

  await p.waitForTimeout(1000);
  await dismissModals(p);

  // Baseline BEFORE submitting — verification below works on deltas: a stop-button left
  // over from a previous turn or a composer rerender must not count as "submitted".
  const countUserTurns = () => p.evaluate(
    () => document.querySelectorAll('[data-message-author-role="user"]').length
  ).catch(() => -1);
  const userTurnsBefore = await countUserTurns();
  const STOP_BTN = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Остановить"]';
  // Baseline the stop-button too: a leftover one from the previous turn must not
  // confirm a submit that never happened (delta false→true is the real signal).
  const stopBefore = !!(await p.$(STOP_BTN).catch(() => null));

  // Use locator to avoid "element detached from DOM" errors
  // Image 2.0 UI may rename aria-label — keep multiple fallbacks
  const sendLocator = p.locator(
    'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"], button[aria-label^="Отправить"]'
  );
  try {
    await sendLocator.first().waitFor({ state: 'visible', timeout: 5000 });
    console.log('Send button found. Clicking...');
    await sendLocator.first().click();
  } catch {
    // Enter fallback: refocus the composer and confirm the prompt is still there first —
    // blind Enter into an overlay was how the 2026-07-10 send-button incident burned 360s
    // per request and jammed the queue.
    console.log('Send button not found. Refocusing composer for Enter fallback...');
    await textareaLocator.first().click().catch(() => {});
    const stillThere = await textareaLocator.first().textContent().catch(() => '');
    if (probe && !normText(stillThere).includes(probe)) {
      markSessionDegraded('composer lost the prompt before Enter fallback');
      const err = new Error('Prompt vanished from composer before submit');
      err.code = 'page_load_failed';
      throw err;
    }
    await p.keyboard.press('Enter');
  }

  // Verify the message ACTUALLY left the composer: a new user turn appears, or the typed
  // text is gone while generation started. No confirmation in 12s → fast retriable abort
  // instead of waiting the full response budget on a message that was never sent.
  const submitDeadline = Date.now() + 12000;
  let submitted = false;
  while (Date.now() < submitDeadline) {
    const turnsNow = await countUserTurns();
    if (userTurnsBefore >= 0 && turnsNow > userTurnsBefore) { submitted = true; break; }
    const composerNow = normText(await textareaLocator.first().textContent().catch(() => ''));
    const probeGone = probe && !composerNow.includes(probe);
    if (probeGone) {
      const stopNow = !!(await p.$(STOP_BTN).catch(() => null));
      const stopAppeared = stopNow && !stopBefore;
      if (stopAppeared || (userTurnsBefore >= 0 && (await countUserTurns()) > userTurnsBefore)) { submitted = true; break; }
    }
    await p.waitForTimeout(500).catch(() => {});
  }
  if (!submitted) {
    markSessionDegraded('prompt submit not confirmed in 12s');
    await saveDebugSnapshot(p, 'submit_unconfirmed').catch(() => {});
    // Broken composer often shows an error toast/banner — pass its text to the client.
    const uiError = await readUiErrorBanner(p);
    if (uiError) console.log(`[submit] UI error banner: "${uiError}"`);
    const err = new Error('Prompt submit not confirmed (no new user turn, composer unchanged)');
    err.code = 'page_load_failed';
    if (uiError) err.modelMessage = uiError;
    throw err;
  }
  console.log('Prompt submitted (confirmed).');
  // Signal confirmed-send NOW, before the settle wait — a failure during the wait below must
  // count as "already submitted" so the caller does not retry and resubmit the prompt.
  if (onSubmitted) { try { onSubmitted(); } catch {} }

  await p.waitForTimeout(2000);
}

async function dismissModals(p) {
  await p.evaluate(() => {
    const modalIds = [
      'modal-no-auth-login',
      'modal-fanny-pack',
    ];
    for (const id of modalIds) {
      const modal = document.getElementById(id);
      if (modal) modal.remove();
    }
    // Remove any overlay that blocks clicks
    document.querySelectorAll([
      '[data-state="open"].fixed.inset-0.z-50',
      '[data-testid="modal-fanny-pack"]',
    ].join(',')).forEach(el => el.remove());
  });
}

// ==== Image 2.0 UI capability adapter (toggles in composer toolbar) ====
// Selectors are best-effort; ChatGPT redesigns frequently. Each helper soft-fails
// (returns false) so callers can fall back to prompt-only behavior.

// normalizeThinkingMode now lives in src/params.js (pure, unit-tested) and is imported
// at the top; re-exported below for backward compatibility.

// ChatGPT redesigned the thinking control (~2026-06): the old Instant/Thinking pill +
// Configure-effort modal is gone, replaced by a flat "Интеллект" dropdown.
// 2026-07 revision (verified live + user screenshots): the tier set is PLAN-DEPENDENT —
// Plus shows three levels ("Instant 5.5" / «Средний» / «Высокий»), other plans show five
// (+ «Очень высокий» / «Pro»). All variants have a model submenu ("GPT-5.6 Sol" default;
// GPT-5.5 / GPT-5.4 (until Jul 23) / GPT-5.3 / o3 — we never touch it, account default is
// used). The Chat-tab composer pill shows the PLAIN level name ("Instant", «Высокий»);
// the Work-tab pill renders "<model> <level>" ("5.6 Sol Очень высокий") — see
// PILL_MODEL_PREFIX and ensureChatMode. Every level the UI offers is now reachable:
//   instant    → Instant
//   standard   → Medium
//   extended   → High
//   extra_high → Extra High   (was recognised but unreachable until 2026-07-27)
//   pro        → Pro          (idem)
//
// Before 2026-07-27 the top two were deliberately unmapped, which had a consequence beyond
// "you cannot ask for them": because they were absent from LEVEL_TO_MODE, an account left on
// Extra High or Pro in the UI was read as `extended` and then actively pushed back DOWN to
// High on the next request. Asking for the tier you are paying for now works, and finding it
// already selected no longer silently downgrades it.
//
// Availability is PLAN-DEPENDENT (Plus exposes only the lower three). A tier that is not in
// the menu simply fails to click, `verified` comes back false and `applied.thinking_mode`
// reports what is really active — the same soft-fail every other level already had.
const {
  MODE_TO_LEVEL, LEVEL_TO_MODE, HIGH_EFFORT_MODES, LEVEL_ORDER, levelIndex, levelAtIndex,
  fallbackChainFor, LIMIT_HINT_RE, detectTierLimit, tierAvailability,
} = require('./chatgpt-tiers');
// Per-level matchers for the composer pill / menu item text. In the RU UI "Instant" stays
// English while Medium/High localize («Средний»/«Высокий»). "high" is anchored so it never
// swallows "extra high" / "очень высокий" (kept for backward compat). Menu items may carry
// a model-version suffix ("Instant 5.5") — allow an optional trailing version number.
// NB: \w is ASCII-only in JS regex — Cyrillic suffixes use an explicit [а-яёА-ЯЁ] class.
const LEVEL_MATCH = {
  instant:  /^(instant|мгновенн[а-яёА-ЯЁ]*)( \d[\d.]*)?$/i,
  medium:   /^(medium|средн[а-яёА-ЯЁ]*)( \d[\d.]*)?$/i,
  high:     /^(high|высокий)( \d[\d.]*)?$/i,
  veryhigh: /^(extra high|very high|очень высок[а-яёА-ЯЁ]*)( \d[\d.]*)?$/i,
  pro:      /^pro( расширенн[а-яёА-ЯЁ]*| extended)?( \d[\d.]*)?$/i,
};
// Work-tab pill (and possibly future Chat variants) prefixes the level with the model name:
// "5.6 Sol Очень высокий" / "GPT-5.6 Sol Very high". Strip it before level matching.
const PILL_MODEL_PREFIX = /^(?:gpt-)?\d[\d.]*(?:\s+[a-z]+)?\s+/i;
// Prefix list to CLICK a target level inside the open dropdown (menu items are English).
// NB ordering matters for the fallback prefix clicker: it matches by PREFIX, so 'high' would
// also match "High" when aiming at "Extra High". The veryhigh entry therefore lists only the
// full labels, and `high` is never a prefix of them.
const LEVEL_CLICK_PREFIXES = {
  instant:  ['instant', 'мгновенн'],
  medium:   ['medium', 'средн'],
  high:     ['high', 'высокий'],
  veryhigh: ['extra high', 'very high', 'очень высок'],
  pro:      ['pro расширенн', 'pro extended', 'pro'],
};
// Matches the composer pill at ANY level — used to locate the dropdown trigger. Allows an
// optional leading model token (Work-tab pill: "5.6 Sol Очень высокий").
const ANY_LEVEL_PILL = /^(?:(?:gpt-)?\d[\d.]*(?:\s+[a-z]+)?\s+)?(instant|medium|high|extra high|very high|pro( расширенн[а-яёА-ЯЁ]*| extended)?|мгновенн[а-яёА-ЯЁ]*|средн[а-яёА-ЯЁ]*|высокий|очень высок[а-яёА-ЯЁ]*)( \d[\d.]*)?$/i;

// Read the level currently shown on the composer "Интеллект" pill.
// Returns { level: 'instant'|'medium'|'high'|'veryhigh'|'pro'|null, pillText }.
async function readPillLevel(p) {
  const matchers = Object.entries(LEVEL_MATCH).map(([k, rx]) => [k, rx.source]);
  return await p.evaluate(({ matchers, prefixSrc }) => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const PREFIX = new RegExp(prefixSrc, 'i');
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    // Search from the end — the composer sits below the chat history.
    for (let i = buttons.length - 1; i >= 0; i--) {
      const text = norm(buttons[i].innerText || buttons[i].textContent || '');
      if (!text || text.length > 40) continue;
      // Work-tab pill prefixes the level with the model name ("5.6 sol очень высокий") —
      // try both the raw text and the prefix-stripped variant.
      const candidates = [text, text.replace(PREFIX, '')];
      for (const cand of candidates) {
        for (const [level, src] of matchers) {
          if (new RegExp(src, 'i').test(cand)) return { level, pillText: text };
        }
      }
    }
    return { level: null, pillText: '' };
  }, { matchers, prefixSrc: PILL_MODEL_PREFIX.source }).catch(() => ({ level: null, pillText: '' }));
}

// One Escape closes ONE layer. The tier control nests (popover → Advanced → Effort submenu),
// so a single press can leave the parent popover standing — and a leaked popover swallows the
// next activation, turning one failure into a run of them (Codex review). Press until nothing
// is open, capped: `intelligencePopoverOpen` is defined below and used only at call time.
async function closeOpenMenus(p) {
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(200).catch(() => {});
    if (!await intelligencePopoverOpen(p)) return;
  }
}

// The tier control is a slider (2026-08). Both shapes it can take are covered: a native
// `<input type="range">` and an ARIA widget (`role="slider"`, e.g. a Radix thumb).
const SLIDER_SEL = 'input[type="range"], [role="slider"]';

// Read the tier slider's position. Returns null when no slider is visible — which is also how
// "the popover is not open" is detected, since the track only exists while it is.
//
// `index` is the position on the track, not the raw value: the two differ whenever the widget
// uses a non-unit step (a 0..1 track with step 0.25 is still five tiers).
async function readSliderState(p) {
  return await p.evaluate((sel) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const el = Array.from(document.querySelectorAll(sel)).filter(vis)[0];
    if (!el) return null;
    // Number('') is 0, so an ABSENT attribute must be rejected before conversion — otherwise a
    // range input with no explicit max reads as max=0 and the track collapses to one position.
    const num = (v) => {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const native = el.tagName === 'INPUT';
    const min = num(native ? el.min : el.getAttribute('aria-valuemin')) ?? 0;
    const max = num(native ? el.max : el.getAttribute('aria-valuemax')) ?? 100;
    const step = num(native ? el.step : el.getAttribute('aria-valuestep')) ?? 1;
    const value = num(native ? el.value : el.getAttribute('aria-valuenow'));
    const span = max - min;
    return {
      native, min, max, step, value,
      index: value === null || step <= 0 ? null : Math.round((value - min) / step),
      positions: step > 0 && span >= 0 ? Math.round(span / step) + 1 : 0,
      valueText: (el.getAttribute('aria-valuetext') || '').trim().slice(0, 120),
      label: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
    };
  }, SLIDER_SEL).catch(() => null);
}

// Rows inside the popover, by their visible label. The trailing lookahead replaces `\b`, which
// is ASCII-only in JS: after a Cyrillic letter there is no word boundary, so `расширенн\w*\b`
// matches nothing at all and the RU UI would silently lose the named path (Codex review).
const ROW_END = '(?=$|[\\s:›>])';
const ADVANCED_RE = new RegExp(`^(advanced|расширенн[а-яёА-ЯЁ]*|дополнительн[а-яёА-ЯЁ]*)${ROW_END}`, 'i');
const EFFORT_RE = new RegExp(`^(effort|усили[ея][а-яёА-ЯЁ]*|уровень)${ROW_END}`, 'i');

// What the popover is currently showing. The 2026-08 control has two faces and BOTH have to be
// recognised: collapsed it is a positional slider plus an "Advanced" disclosure; expanded, that
// disclosure reveals Model and Effort rows, and Effort opens a submenu of named levels.
//
// The popover counts as open when any of those is present. Checking for a popover element alone
// would go back to accepting the "+" panel and sidebar menus, which is exactly what made the old
// detector report success and then click nothing.
async function readPopoverShape(p) {
  const slider = await readSliderState(p);
  const rows = await p.evaluate(({ advancedSrc, effortSrc }) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const ADV = new RegExp(advancedSrc, 'i');
    const EFF = new RegExp(effortSrc, 'i');
    // Anchored at BOTH ends (bar an optional model-version suffix, "Instant 5.5"). A loose
    // /^pro/ matches the sidebar's permanently visible "Projects" button, and a loose /^high/
    // would swallow "Extra High" — either one makes a closed popover look open.
    const LEVELISH = /^(instant|medium|high|extra high|very high|pro|мгновенн[а-яёА-ЯЁ]*|средн[а-яёА-ЯЁ]*|высокий|очень высок[а-яёА-ЯЁ]*)( \d[\d.]*)?$/i;
    const nodes = Array.from(document.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="option"], [cmdk-item], button, [role="button"]',
    )).filter(vis)
      // The composer pill shows the CURRENT level, so it matches the level pattern whether or
      // not the popover is open. Counting it would make "closed" look like "one item showing".
      .filter((el) => !el.closest('.__composer-pill'));
    let advanced = false;
    let effort = false;
    let levelItems = 0;
    for (const el of nodes) {
      const t = norm(el.innerText || el.textContent || '');
      if (!t || t.length > 60) continue;
      const first = norm(t.split('\n')[0]);
      if (ADV.test(first)) advanced = true;
      else if (EFF.test(first)) effort = true;
      else if (LEVELISH.test(first)) levelItems++;
    }
    return { advanced, effort, levelItems };
  }, { advancedSrc: ADVANCED_RE.source, effortSrc: EFFORT_RE.source }).catch(() => ({ advanced: false, effort: false, levelItems: 0 }));
  return { slider, ...rows };
}

async function intelligencePopoverOpen(p) {
  const shape = await readPopoverShape(p);
  return (!!shape.slider && shape.slider.positions >= 2)
    || shape.advanced || shape.effort || shape.levelItems >= 2;
}

// Dump whatever the popover actually contains. This runs only on the failure path, and it
// exists because the tier control has now been redesigned three times (effort modal → named
// dropdown → slider) and each time the logs recorded only that the OLD shape was missing,
// never what had replaced it.
//
// Only roots that LOOK like the tier control are dumped — one holding a slider, or a tier/
// Advanced/Effort word. Dumping every visible dialog would sooner or later put an unrelated
// modal's contents (account details, a shared conversation) into the log (Codex review).
async function dumpIntelligencePopover(p) {
  return await p.evaluate((sel) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const attrs = (el) => Object.fromEntries(
      Array.from(el.attributes).map((a) => [a.name, String(a.value).slice(0, 120)]),
    );
    const TIERISH = /(advanced|effort|instant|medium|high|\bpro\b|расширенн|дополнительн|усили|уровень|мгновенн|средн|высок)/i;
    const relevant = (el) => !!el.querySelector(sel) || TIERISH.test(el.innerText || '');
    const roots = Array.from(document.querySelectorAll(
      '[role="menu"], [role="dialog"], [role="listbox"], [data-radix-menu-content], '
      + '[data-radix-popper-content-wrapper], div.popover',
    )).filter((el) => vis(el) && relevant(el)).slice(0, 5).map((el) => ({
      tag: el.tagName.toLowerCase(),
      attrs: attrs(el),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      html: el.outerHTML.slice(0, 1500),
    }));
    const sliders = Array.from(document.querySelectorAll(sel)).map((el) => ({
      tag: el.tagName.toLowerCase(),
      visible: vis(el),
      attrs: attrs(el),
      html: el.outerHTML.slice(0, 500),
    }));
    return { roots, sliders };
  }, SLIDER_SEL).catch((e) => ({ error: String((e && e.message) || e) }));
}

async function openIntelligenceMenu(p) {
  // The composer shows a pill button whose text is the CURRENT level; activating it opens the
  // tier popover. It reacts to REAL pointer events only — a synthetic in-page element.click()
  // does NOT open it. Primary trigger: the composer pill by its stable class (scoped, cannot
  // hit sidebar buttons); text-based locators kept as fallback. Each attempt: close stray
  // menus → activate (click / Enter / Space) → verify the TRACK specifically appeared (not
  // just any popover).
  const pillText = /(instant|medium|high|extra high|very high|pro расширенн|pro extended|\bpro\b|мгновенн|средн|высок|очень высок)/i;
  const triggers = [
    p.locator('.__composer-pill').last(),
    p.locator('button').filter({ hasText: pillText }).last(),
    p.getByRole('button', { name: pillText }).last(),
  ];
  const activations = [
    async (loc) => { await loc.click({ timeout: 1500 }); },
    async (loc) => { await loc.focus(); await p.keyboard.press('Enter'); },
    async (loc) => { await loc.focus(); await p.keyboard.press('Space'); },
  ];
  for (const loc of triggers) {
    if (!await loc.isVisible({ timeout: 400 }).catch(() => false)) continue;
    for (const activate of activations) {
      try {
        await closeOpenMenus(p); // a stray open popover swallows the next activation
        await activate(loc);
        await p.waitForTimeout(400);
        if (await intelligencePopoverOpen(p)) {
          return { ok: true, label: 'intelligence pill' };
        }
      } catch {}
    }
  }
  // Everything below is diagnostics for a control that has been redesigned repeatedly. Reopen
  // once with the primary trigger first: the ladder above ends with an Escape-then-activate
  // cycle, so by now the popover is as likely closed as open and dumping would show nothing.
  await closeOpenMenus(p);
  await p.locator('.__composer-pill').last().click({ timeout: 1500 }).catch(() => {});
  await p.waitForTimeout(400).catch(() => {});
  const labels = await p.evaluate(() => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => norm(b.getAttribute('aria-label') || b.innerText || b.textContent || ''))
      .filter((t) => t && t.length <= 40)
      .slice(-25);
  }).catch(() => []);
  const dump = await dumpIntelligencePopover(p);
  console.log('[ui-adapter] openIntelligenceMenu FAILED — pill activation revealed neither a tier slider nor an Advanced/Effort row. Visible button labels:', JSON.stringify(labels));
  console.log('[ui-adapter] popover dump:', JSON.stringify(dump));
  await closeOpenMenus(p);
  return { ok: false, labels };
}

// Native Playwright click on a level item in the open Интеллект dropdown. Radix menu items
// react to real pointer events, so this is more reliable than an in-page .click(). The name
// regex is anchored so "High" never matches "Extra high" / "Очень высокий".
async function clickLevelNative(p, targetLevel) {
  // `high` stays anchored so it cannot swallow "Extra High"; the two top tiers are anchored
  // for the same reason in reverse — a loose /^pro/ would also match a "Projects" item.
  const nameRx = {
    instant:  /^(instant|мгновенн)/i,
    medium:   /^(medium|средн)/i,
    high:     /^(high|высокий)$/i,
    veryhigh: /^(extra high|very high|очень высок[а-яёА-ЯЁ]*)$/i,
    pro:      /^pro( расширенн[а-яёА-ЯЁ]*| extended)?$/i,
  }[targetLevel];
  if (!nameRx) return { ok: false };
  for (const role of ['menuitemradio', 'menuitem', 'option']) {
    try {
      const loc = p.getByRole(role, { name: nameRx }).first();
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
        await loc.click({ timeout: 1500 });
        return { ok: true, via: role };
      }
    } catch {}
  }
  return { ok: false };
}

// Click a popup item whose visible text STARTS with one of the given prefixes.
// Avoids the composer pill (which contains the mode name but isn't a menu item).
// We restrict to elements that are children of a visible popup root.
async function clickPopupItemByPrefix(p, prefixes) {
  return await p.evaluate(({ prefixes }) => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const popupRoots = Array.from(document.querySelectorAll(
      // A ChatGPT popover is not always an ARIA menu — the composer panels render as a plain
      // `div.popover`, so an items list that omits it silently sees nothing there.
      '[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [role="dialog"], div.popover'
    )).filter(visible);
    if (popupRoots.length === 0) return { ok: false, reason: 'no-popup-root' };
    const candidates = popupRoots.flatMap(r => Array.from(r.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [cmdk-item], button, [role="button"]'
    ))).filter(visible);
    for (const el of candidates) {
      const text = norm(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
      if (!text) continue;
      if (prefixes.some(prefix => text.startsWith(prefix.toLowerCase()))) {
        const clickable = el.closest('button, [role="menuitem"], [role="option"], [role="button"], [tabindex]') || el;
        clickable.click();
        return { ok: true, text };
      }
    }
    return { ok: false, reason: 'no-match', seen: candidates.slice(0, 20).map(el => norm(el.innerText || el.textContent || '').slice(0, 60)) };
  }, { prefixes }).catch(() => ({ ok: false, reason: 'eval-error' }));
}

// Read the state of ONE level item in the open Интеллект dropdown, without clicking it.
// The only thing this adds over the click attempt itself is an explicit disabled marker:
// a tier that is rendered but greyed out (out of quota / not on the plan) must not be
// clicked at all, because Radix swallows the click and the pill silently stays put.
//
// Matching is deliberately strict — the level name must be the item's FIRST LINE (items
// carry a description underneath). An inconclusive read reports found:false, which costs
// nothing: the normal click path runs and decides.
// How much agreeing evidence a failure reason needs before the tier is memoized as
// unavailable (and later requests skip it outright). Anything absent here never memoizes.
const STICKY_AFTER = { quota: 1, disabled: 1, 'not-offered': 2 };

async function readLevelItemState(p, targetLevel) {
  const levelSrc = (LEVEL_MATCH[targetLevel] || /$^/).source;
  const state = await p.evaluate(({ levelSrc, prefixSrc }) => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const LEVEL = new RegExp(levelSrc, 'i');
    const PREFIX = new RegExp(prefixSrc, 'i');
    const roots = Array.from(document.querySelectorAll(
      // A ChatGPT popover is not always an ARIA menu — the composer panels render as a plain
      // `div.popover`, so an items list that omits it silently sees nothing there.
      '[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [role="dialog"], div.popover'
    )).filter(visible);
    const items = roots.flatMap((r) => Array.from(r.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [cmdk-item], button, [role="button"]'
    ))).filter(visible);
    for (const el of items) {
      const raw = el.innerText || el.textContent || '';
      const firstLine = norm((raw.split('\n').find((l) => norm(l)) || ''));
      if (!firstLine) continue;
      if (!LEVEL.test(firstLine) && !LEVEL.test(firstLine.replace(PREFIX, ''))) continue;
      const holder = el.closest('[role="menuitem"], [role="menuitemradio"], [role="option"], button') || el;
      // Radix renders a bare `data-disabled` (empty value) — hasAttribute, not a value check.
      const disabled = holder.getAttribute('aria-disabled') === 'true'
        || holder.hasAttribute('disabled')
        || holder.hasAttribute('data-disabled')
        || holder.getAttribute('data-state') === 'disabled';
      return { found: true, disabled, text: norm(raw).slice(0, 160) };
    }
    return { found: false, disabled: false, text: '' };
  }, { levelSrc, prefixSrc: PILL_MODEL_PREFIX.source }).catch(() => null);
  if (!state) return { found: false, disabled: false, text: '', quotaHint: false };
  // The wording only LABELS the reason (quota vs plain disabled) — never decides a downgrade.
  return { ...state, quotaHint: LIMIT_HINT_RE.test(state.text) };
}

// Click a row in the open popover whose first line matches `re` (the "Advanced" disclosure or
// the "Effort" submenu trigger). Native Playwright click: both react to real pointer events.
async function clickPopoverRow(p, re, what) {
  const loc = p.getByRole('button', { name: re }).last();
  if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
    if (await loc.click({ timeout: 1500 }).then(() => true).catch(() => false)) return true;
  }
  // Not every row is exposed as a button — fall back to a text match over the popover.
  return (await clickPopupItemByPrefix(p, what)).ok;
}

// Poll the popover until `done` holds, up to ~1.2 s. A disclosure animating open takes an
// unknown time; a fixed sleep either reads the pre-click UI or pads every call with a wait it
// usually does not need (agy review).
async function waitForShape(p, done) {
  let shape = await readPopoverShape(p);
  for (let i = 0; i < 6 && !done(shape); i++) {
    await p.waitForTimeout(200).catch(() => {});
    shape = await readPopoverShape(p);
  }
  return shape;
}

// Walk pill-popover → "Advanced" → "Effort" until the named level items are on screen.
// Returns true once at least two of them are visible.
async function openEffortSubmenu(p) {
  let shape = await readPopoverShape(p);
  if (shape.levelItems >= 2) return true;      // already showing (submenu left open)
  // Only expand when Effort is not already exposed — clicking a disclosure that is open
  // collapses it again.
  if (shape.advanced && !shape.effort) {
    await clickPopoverRow(p, ADVANCED_RE, ['advanced', 'расширенн', 'дополнительн']);
    shape = await waitForShape(p, (s) => s.effort || s.levelItems >= 2);
  }
  if (shape.levelItems >= 2) return true;
  if (shape.effort) {
    await clickPopoverRow(p, EFFORT_RE, ['effort', 'усили', 'уровень']);
    shape = await waitForShape(p, (s) => s.levelItems >= 2);
  }
  return shape.levelItems >= 2;
}

// Path 1 — the named Effort submenu. Preferred over the slider because each item carries its
// own name and disabled state, which is what lets the caller tell "this account cannot select
// Pro" (downgrade the tier) from "the click missed" (the adapter is failing). A positional
// slider cannot express that difference at all.
//
// `handled: false` means the named UI was not reachable — the caller then tries the slider.
async function applyLevelViaEffortMenu(p, targetLevel) {
  if (!await openEffortSubmenu(p)) return { handled: false };

  const item = await readLevelItemState(p, targetLevel);
  if (item.found && item.disabled) {
    console.log(`[ui-adapter] Intelligence level "${targetLevel}" is rendered but DISABLED ("${item.text}")`);
    return {
      handled: true,
      result: {
        menuOpened: true, clicked: false, unsupported: true, disabled: true,
        itemText: item.text, quotaHint: item.quotaHint,
      },
    };
  }

  const native = await clickLevelNative(p, targetLevel);
  if (native.ok) {
    console.log(`[ui-adapter] Intelligence → ${targetLevel} (effort menu, native via ${native.via})`);
    return {
      handled: true,
      result: { menuOpened: true, clicked: true, unsupported: false, disabled: false, itemText: item.text, quotaHint: item.quotaHint },
    };
  }
  const pick = await clickPopupItemByPrefix(p, LEVEL_CLICK_PREFIXES[targetLevel]);
  if (pick.ok) {
    console.log(`[ui-adapter] Intelligence → ${targetLevel} (effort menu, clicked "${pick.text}")`);
    return {
      handled: true,
      result: { menuOpened: true, clicked: true, unsupported: false, disabled: false, itemText: item.text, quotaHint: item.quotaHint },
    };
  }
  // The submenu rendered its levels and none of them is the target: this account does not offer
  // the tier. Anything else (an empty/unreadable popup) is not evidence about the tier, so it
  // falls through to the slider rather than being recorded as "not offered".
  const notOffered = pick.reason === 'no-match' && Array.isArray(pick.seen) && pick.seen.length > 0;
  console.log(
    `[ui-adapter] Intelligence level "${targetLevel}" not in effort menu (${pick.reason}`
      + `${notOffered ? ', tier unavailable on this account' : ''}). Seen:`,
    JSON.stringify(pick.seen || []),
  );
  if (!notOffered) return { handled: false };
  return {
    handled: true,
    result: { menuOpened: true, clicked: false, unsupported: true, disabled: false, itemText: item.text, quotaHint: item.quotaHint },
  };
}

// Path 2 — the positional slider, for the collapsed popover. Driven by ARROW KEYS rather than
// by dragging or by writing `.value`: keys work identically for a native `<input type=range>`
// and an ARIA thumb, need no geometry, and go through React's own event path (assigning
// `.value` directly does not, so the app would never see the change).
async function applyLevelViaSlider(p, targetLevel) {
  let s = await readSliderState(p);
  if (!s || s.index === null || s.positions < 2) return { handled: false };
  // One tick per tier is the whole basis for addressing a tier by index. A longer track (a
  // plain 0..100 range, say) is some other control, or the same one rescaled — either way the
  // mapping is unknown, and guessing it would select a tier the caller never asked for. Refuse
  // and log the geometry instead; the named path is primary anyway.
  if (s.positions > LEVEL_ORDER.length) {
    console.log(`[ui-adapter] Intelligence slider has ${s.positions} positions for ${LEVEL_ORDER.length} tiers`
      + ` (min=${s.min} max=${s.max} step=${s.step}) — cannot map index to tier, skipping slider path`);
    return { handled: false };
  }

  const targetIdx = levelIndex(targetLevel, s.positions);
  if (targetIdx === null) {
    // The track is shorter than this tier needs — a Plus account has no Extra High / Pro tick.
    console.log(`[ui-adapter] Intelligence level "${targetLevel}" is beyond the slider (positions=${s.positions}) — tier unavailable on this account`);
    return {
      handled: true,
      result: {
        menuOpened: true, clicked: false, unsupported: true, disabled: false,
        itemText: `slider positions=${s.positions}`, quotaHint: false,
      },
    };
  }

  // `:visible` matters: readSliderState() reads the first VISIBLE slider, while a bare
  // .first() is DOM order and can land on a hidden one — we would then be reading one element
  // and typing at another (Codex review).
  const thumb = p.locator('input[type="range"]:visible, [role="slider"]:visible').first();
  await thumb.focus().catch(() => {});
  // Arrow keys go wherever the focus is. If it never reached the thumb, the loop below reads a
  // motionless track and reports "inconclusive" — true, but not actionable. Say so explicitly.
  const focused = await thumb.evaluate((el) => el === document.activeElement).catch(() => null);
  if (focused === false) console.log('[ui-adapter] WARN: slider thumb did not take focus — arrow keys will not reach it');
  // The level the index MAPS to is logged next to the slider's own aria-valuetext: if the two
  // ever disagree, the LEVEL_ORDER assumption is wrong and this line is what shows it.
  console.log(`[ui-adapter] Intelligence slider: index=${s.index}/${s.positions - 1}`
    + ` (reads as ${levelAtIndex(s.index, s.positions) || '?'}, valueText="${s.valueText}")`
    + ` → ${targetIdx} (${targetLevel})`);

  let moves = 0;
  let guard = s.positions + 2;   // never loop longer than the track is wide
  while (s.index !== targetIdx && guard-- > 0) {
    await p.keyboard.press(s.index < targetIdx ? 'ArrowRight' : 'ArrowLeft').catch(() => {});
    await p.waitForTimeout(150).catch(() => {});
    const next = await readSliderState(p);
    if (!next || next.index === null) break;
    if (next.index === s.index) break;   // refused to move — see below
    s = next;
    moves++;
  }

  if (s.index === targetIdx) {
    return {
      handled: true,
      result: { menuOpened: true, clicked: true, unsupported: false, disabled: false, itemText: s.valueText, quotaHint: LIMIT_HINT_RE.test(s.valueText) },
    };
  }
  // Stuck short of the target — reported as INCONCLUSIVE, never as "the tier is unavailable".
  //
  // Whether the track moved before stopping cannot tell those apart (Codex review): a locked
  // Pro reached from Extra High never moves at all, while the same locked Pro reached from
  // Medium moves three times first. The same reality would then be recorded as an adapter
  // failure in one case and as a missing tier in the other — and those drive different things
  // (session teardown vs. memoizing the tier away for the cooldown).
  //
  // Genuine unavailability has two trustworthy witnesses already: a track too short to hold the
  // tier (levelIndex → null, above) and an explicitly disabled item in the named Effort menu.
  // A slider that merely stopped is not a third one.
  console.log(`[ui-adapter] Intelligence slider stopped at index=${s.index} (target=${targetIdx}, moves=${moves})`
    + ' — inconclusive, not treated as tier unavailability');
  return {
    handled: true,
    result: {
      menuOpened: true, clicked: false, unsupported: false, disabled: false,
      itemText: s.valueText, quotaHint: LIMIT_HINT_RE.test(s.valueText),
    },
  };
}

// One attempt to select `targetLevel`: open the popover, then the named Effort submenu, then
// the slider. Says WHY it failed so the caller can tell "this tier is not available to us" from
// "the adapter is broken", which decide completely different things (downgrade the tier vs.
// count toward session degradation).
async function applyLevel(p, targetLevel) {
  const opened = await openIntelligenceMenu(p);
  if (!opened.ok) {
    console.log('[ui-adapter] Intelligence popover did not open — skipping level set');
    return { menuOpened: false, clicked: false, unsupported: false, disabled: false, itemText: '', quotaHint: false };
  }
  // An open popover must be closed on EVERY path — a stray one swallows the next activation,
  // so leaking it turns a single failure into a run of them.
  try {
    const named = await applyLevelViaEffortMenu(p, targetLevel);
    if (named.handled) return named.result;

    // Reaching for Advanced/Effort may have navigated the popover away from the collapsed face
    // that carries the slider, so reopen before trying it.
    await closeOpenMenus(p);
    if (!(await openIntelligenceMenu(p)).ok) {
      console.log('[ui-adapter] Intelligence popover did not reopen for the slider path');
      return { menuOpened: false, clicked: false, unsupported: false, disabled: false, itemText: '', quotaHint: false };
    }
    const slid = await applyLevelViaSlider(p, targetLevel);
    if (slid.handled) return slid.result;

    console.log('[ui-adapter] Intelligence popover exposed neither a usable effort menu nor a slider');
    return { menuOpened: true, clicked: false, unsupported: false, disabled: false, itemText: '', quotaHint: false };
  } finally {
    await closeOpenMenus(p);
  }
}

// `deps` is a test seam only: production always uses the real page helpers. The tier-chain
// loop below decides both which tier the caller is billed for and whether the session gets
// torn down, and neither can be exercised through a DOM stub — every real step is a
// page.evaluate over ChatGPT's own markup.
async function setThinkingMode(p, modeOrEnabled, deps = {}) {
  const readPill = deps.readPill || readPillLevel;
  const tryLevel = deps.applyLevel || applyLevel;
  const settle = deps.settle || (async (ms) => { await p.waitForTimeout(ms).catch(() => {}); });
  const degrade = deps.markDegraded || markSessionDegraded;
  const env = deps.env || process.env;
  const requestedMode = normalizeThinkingMode(modeOrEnabled);
  // Tiers to try, best first: [pro, extra_high] for a Pro request, [x] for everything else.
  // Pro has its own quota and it runs out; without a downgrade the caller got whatever level
  // the pill happened to show, which is nobody's deliberate choice.
  const chain = fallbackChainFor(requestedMode, env);
  // A tier known to be unavailable is skipped outright — no point paying ~3 s of opening the
  // menu and failing per request for the whole cooldown. The LAST hop is never skipped: there
  // is nothing below it, so it must be attempted even if it just failed.
  let attempts = chain.filter((m, i) => i === chain.length - 1 || !tierAvailability.isCoolingDown(m));
  const cooledDownReason = attempts[0] !== chain[0] ? tierAvailability.reasonFor(chain[0]) : null;

  // After ensureNewChat the composer pill renders asynchronously — poll up to ~2s so we
  // read a real level (and the pill exists for openIntelligenceMenu to click).
  let before = await readPill(p);
  const beforeDeadline = Date.now() + 2000;
  while (!before.level && Date.now() < beforeDeadline) {
    await settle(250);
    before = await readPill(p);
  }

  // The memo must never override what the UI actually shows: if the requested tier is
  // ALREADY selected, use it and forget the memo. Otherwise the adapter would keep pushing a
  // manually restored (or quota-restored) Pro back down to Extra High for the whole cooldown
  // — the memo undoing a real recovery (Codex review).
  if (attempts[0] !== chain[0] && before.level === MODE_TO_LEVEL[chain[0]]) {
    console.log(`[ui-adapter] "${chain[0]}" is memoized as unavailable but the pill already shows it — clearing the memo`);
    tierAvailability.markAvailable(chain[0]);
    attempts = chain;
  } else if (attempts[0] !== chain[0]) {
    console.log(`[ui-adapter] "${chain[0]}" is in cooldown (${cooledDownReason}) — going straight to "${attempts[0]}"`);
  }
  const firstLevel = MODE_TO_LEVEL[attempts[0]];
  console.log(`[ui-adapter] Intelligence pill before: level=${before.level} text="${before.pillText}" (target=${firstLevel})`);

  const startedAt = { level: before.level, pillText: before.pillText };
  let effectiveMode = attempts[0];   // the tier we ended up aiming at
  let targetLevel = firstLevel;
  let clicked = false;
  let verified = false;
  let unsupportedTier = false;       // requested tier is not selectable for this account
  let adapterFailure = false;        // menu never opened — our problem, not the tier's
  let after = before;
  // Why we left the requested tier. 'cooldown' when a previous request already found out.
  let fallbackReason = attempts[0] === chain[0] ? null : `cooldown:${cooledDownReason || 'unavailable'}`;

  for (let i = 0; i < attempts.length; i++) {
    const mode = attempts[i];
    effectiveMode = mode;
    targetLevel = MODE_TO_LEVEL[mode];

    if (before.level === targetLevel) {
      clicked = true;              // already at target — nothing to do
      verified = true;
      after = before;
      console.log(`[ui-adapter] Intelligence already at ${targetLevel}`);
      tierAvailability.markAvailable(mode);
      break;
    }

    const attempt = await tryLevel(p, targetLevel);
    clicked = attempt.clicked;
    await settle(300);
    // Source of truth — what the composer pill shows AFTER our click.
    after = await readPill(p);
    console.log(`[ui-adapter] Intelligence pill after:  level=${after.level} text="${after.pillText}"`);
    if (after.level === targetLevel) {
      verified = true;
      // Proof the tier is back — clear any memo rather than sitting out the cooldown.
      tierAvailability.markAvailable(mode);
      break;
    }

    if (!attempt.menuOpened) {
      // A different tier lives in the same menu, so retrying one cannot help.
      adapterFailure = true;
      break;
    }
    // The menu was there and we still are not on the tier: treat it as unavailable to us.
    // A click Radix accepted but that left the pill unmoved is exactly how an out-of-quota
    // tier behaves (an upsell dialog eats it), so it counts here too.
    const reason = attempt.disabled
      ? (attempt.quotaHint ? 'quota' : 'disabled')
      : attempt.unsupported
        ? 'not-offered'
        : 'click-not-applied';
    if (mode === requestedMode) unsupportedTier = attempt.unsupported || attempt.disabled;
    const isLast = i === attempts.length - 1;
    console.log(
      `[ui-adapter] "${mode}" not applied (${reason})` +
        `${isLast ? ' — no lower tier configured' : ` — falling back to "${attempts[i + 1]}"`}`,
    );
    // Downgrading THIS request is cheap and always safe; memoizing the tier as gone is not,
    // so the two decisions use different evidence bars (Codex review):
    //   quota/disabled  — the UI said so explicitly: believe it at once;
    //   not-offered     — could be a half-rendered menu (it counts as "open" at two items),
    //                     so require two consecutive agreeing observations;
    //   click-not-applied — a routine Playwright/UI transient: never memoize.
    const strikesNeeded = STICKY_AFTER[reason] ?? Infinity;
    tierAvailability.noteUnavailable(mode, reason, { stickyAfter: strikesNeeded, env });
    if (isLast) break;
    fallbackReason = reason;
    before = after;               // next hop compares against what the pill shows now
  }

  const fellBack = effectiveMode !== requestedMode;
  if (verified) {
    consecutiveMenuFailures = 0;
  } else if (unsupportedTier && !fellBack) {
    // A tier this account cannot select is a caller problem, not a broken adapter. Reset the
    // streak so a run of such requests can never tear the session down.
    consecutiveMenuFailures = 0;
    console.log(`[ui-adapter] "${targetLevel}" is not selectable on this account — not counting as degradation`);
  } else if (startedAt.level !== targetLevel) {
    // A real switch attempt that did NOT verify (menu didn't open / item click missed /
    // pill unchanged) counts toward degradation regardless of which step failed. Counted
    // ONCE per call, not once per tier in the chain — a downgrade must not double-charge
    // the streak that triggers a session reset.
    consecutiveMenuFailures++;
    if (consecutiveMenuFailures >= 2) {
      degrade(`intelligence switch unverified ${consecutiveMenuFailures}x in a row`);
      consecutiveMenuFailures = 0;
    }
  }
  if (adapterFailure) {
    // The menu itself is broken — that says nothing about tier availability, and a stale
    // memo would keep downgrading Pro requests long after the UI recovered.
    tierAvailability.markAvailable(effectiveMode);
  }

  // appliedMode reflects what's REALLY active. Prefer the post-click pill read; if that
  // failed, trust the click (target) when we clicked, else fall back to the pre-click level
  // (UI unchanged) and only as a last resort 'instant'. Every level the UI shows is mapped
  // since 2026-07-27, so the `|| 'extended'` below is now only a guard against a level name
  // we have never seen — not the routine downgrade of a top tier it used to be. Never
  // falsely claim 'instant' on a read miss.
  let appliedMode;
  if (after.level) {
    appliedMode = LEVEL_TO_MODE[after.level] || 'extended';
  } else if (clicked) {
    appliedMode = effectiveMode;
  } else if (startedAt.level) {
    appliedMode = LEVEL_TO_MODE[startedAt.level] || 'extended';
  } else {
    appliedMode = 'instant';
  }

  if (after.level && after.level !== targetLevel) {
    console.log(`[ui-adapter] NOTE: requested ${requestedMode}→${targetLevel}, pill shows ${after.level} (applied=${appliedMode})`);
  } else if (!after.level) {
    console.log('[ui-adapter] WARN: could not read pill after set — falling back to click flag');
  }

  // Non-null only when the requested tier was NOT the one applied. `reason` is our own
  // observation, not ChatGPT's wording: quota / disabled / not-offered / click-not-applied /
  // cooldown:<earlier reason>.
  let fallback = null;
  if (fellBack) {
    fallback = { from: requestedMode, to: effectiveMode, reason: fallbackReason || 'unavailable', verified };
    // Counted only when the downgrade actually took effect — the metric means "requests
    // SERVED one tier down", and a failed downgrade is already visible as thinking_verified
    // false plus the degradation counter (Codex review).
    if (verified) tierAvailability.recordFallback(requestedMode, effectiveMode);
    console.log(`[ui-adapter] TIER FALLBACK ${requestedMode} → ${effectiveMode} (${fallback.reason}, verified=${verified})`);
  }

  return {
    applied: appliedMode !== 'instant',
    mode: appliedMode,
    // "High effort" means the strong tiers, not literally `extended` — leaving this as an
    // equality check would report effort:false for Extra High and Pro, i.e. the two highest
    // settings the product has.
    effort: HIGH_EFFORT_MODES.has(appliedMode),
    requested: requestedMode,
    // Refers to `mode` (what we ended up aiming at), not to `requested`: after a downgrade,
    // verified:true means "Extra High really is active" and `fallback` carries the deviation.
    verified,
    // Unambiguous answer to "did we get the tier I asked for?" — `verified` alone said yes
    // after a successful downgrade, which a client could read as "Pro confirmed".
    requestedVerified: verified && !fellBack,
    // True when the menu rendered but this account cannot select the REQUESTED tier. Lets a
    // caller tell "your account cannot do Pro" apart from "the adapter failed to switch",
    // which `verified: false` alone cannot express.
    unsupported: unsupportedTier,
    fallback,
  };
}

// Web search UI automation REMOVED 2026-07-10: GPT-5.6 auto-searches the web whenever a
// question needs fresh data (verified live), so forcing the search token via the "+" panel
// became redundant. The `web_search` API field is accepted-and-ignored at the routes layer.
// History (removed code: openToolsMenu / setWebSearch / token arming) — see git a45ead3.

// Helper: combine primary + references into a single setInputFiles call.
// IMPORTANT: ChatGPT's <input type="file"> is "replace-only" — every setInputFiles
// REPLACES the file set, not append. So primary + refs must go in ONE call.
// Returns the number of files for which upload was confirmed (0 if none).
async function uploadPrimaryAndRefs(p, primary, references) {
  const list = [];
  if (primary) list.push(primary);
  if (references && references.length > 0) {
    references.forEach((ref, i) => {
      list.push({
        buffer: ref.buffer,
        mimeType: ref.mimeType || 'image/png',
        filename: ref.filename || `reference_${i}.png`,
      });
    });
  }
  if (list.length === 0) return 0;
  const confirmed = await uploadImage(p, list);
  return confirmed;
}

function appendAspectRatioHint(prompt, aspectRatio) {
  if (!aspectRatio) return prompt;
  const valid = /^\d+:\d+$/.test(aspectRatio);
  if (!valid) return prompt;
  // ChatGPT does not have a native aspect-ratio control in image mode;
  // appending a hint is the only reliable way.
  return `${prompt}\n\nAspect ratio: ${aspectRatio}.`;
}

// Capability probe: check which Image 2.0 toggles are visible in current UI.
// Used by /v1/images/capabilities — does NOT click anything.
async function probeCapabilities() {
  let p;
  try {
    p = await getPage();
  } catch {
    return { thinking: false, web_search: false, reference_images: false, error: 'no-session' };
  }
  await dismissModals(p);
  return await p.evaluate((anyLevelSrc) => {
    const ANY = new RegExp(anyLevelSrc, 'i');
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const has = (rxList) => buttons.some((b) => {
      const label = norm(b.getAttribute('aria-label') || b.textContent || '');
      return rxList.some((rx) => new RegExp(rx, 'i').test(label));
    });
    // Intelligence control present if a composer pill shows any level (Instant/Medium/High/
    // Очень высокий/Pro расширенный) — the new flat "Интеллект" dropdown trigger.
    const thinkingMode = buttons.some((b) => {
      const t = norm(b.innerText || b.textContent || b.getAttribute('aria-label') || '');
      return t.length <= 40 && ANY.test(t);
    });
    return {
      thinking: thinkingMode,
      thinking_mode: thinkingMode,
      // Forced web search REMOVED 2026-07-10 (GPT-5.6 auto-searches on its own) — the API
      // accepts-and-ignores the web_search field, so capabilities always reports false.
      web_search: false,
      reference_images: !!document.querySelector('input[type="file"]'),
    };
  }, ANY_LEVEL_PILL.source).catch(() => ({ thinking: false, web_search: false, reference_images: false, error: 'probe-failed' }));
}

// ==== Core generate / edit ====

// Single-flight guard over the ENTIRE ensureLoggedIn: the startup warm-up and the first
// request can otherwise interleave — one caller's resetPage()/autoLogin() closing the page
// out from under another caller mid-isLoggedIn, or two concurrent clearSession()+login runs
// corrupting one context. Real API requests are already serialized by the routes queue, so
// the only concurrency here is startup-vs-first-request; sharing one promise makes them wait
// for a single login instead of racing (Codex review). Cleared in `finally` so a later
// session expiry re-runs the flow.
let ensureLoggedInPromise = null;

function ensureLoggedIn() {
  if (ensureLoggedInPromise) return ensureLoggedInPromise;
  const promise = _ensureLoggedIn();
  ensureLoggedInPromise = promise;
  // Clear the guard once settled. Use then(clear, clear) rather than .finally() on an
  // otherwise-unhandled derived promise — the caller handles `promise`'s rejection; a bare
  // .finally() would leave the derived promise's rejection unhandled on login failure.
  const clear = () => { if (ensureLoggedInPromise === promise) ensureLoggedInPromise = null; };
  promise.then(clear, clear);
  return promise;
}

// Consecutive inconclusive session checks on the REQUEST path. An unreachable
// /api/auth/session is not evidence of a logout, and re-logging-in is destructive
// (autoLogin → clearSession wipes the cookies), so we refuse to serve but keep the
// session — until it stays unverifiable, which is itself a symptom worth acting on.
let consecutiveUnknownChecks = 0;

// Non-destructive context rebuilds are rate-limited: a session that stays unverifiable
// keeps qualifying for one, and rebuilding the browser per request would be a spin loop.
const CONTEXT_RESET_COOLDOWN_MS = safePositiveInt(process.env.CONTEXT_RESET_COOLDOWN_SEC, 60) * 1000;
const SESSION_SAVE_DEADLINE_MS = safePositiveInt(process.env.SESSION_SAVE_DEADLINE_MS, 5000);
let lastContextResetAt = 0;

async function _ensureLoggedIn() {
  // The watchdog and a request must never drive the page at the same time. The watchdog
  // skips its tick while work is queued, but that check happens before its own await, so
  // a request arriving right after it would still overlap — wait out an in-flight probe
  // before touching the page (Codex review). Capped: a request must never be able to hang
  // on a background timer.
  if (sessionProbeInFlight) {
    const lease = await raceDeadline(sessionProbeInFlight.catch(() => {}), SESSION_LEASE_WAIT_MS);
    if (lease === PROBE_DEADLINE) {
      // The watchdog is still holding a page that will not answer. Don't start working on
      // it — discard it (which also unblocks the watchdog's own pending call) and rebuild.
      console.log('[chatgpt] watchdog probe did not release the page within the lease budget — discarding it');
      markSessionDegraded('session probe lease timeout');
      closeWedgedPage(page);
      sessionProbeInFlight = null;
    }
  }

  let p = await getPage();
  await dismissModals(p);
  const probed = await probeSessionWithRecovery(p, { consecutiveUnknown: consecutiveUnknownChecks });
  const state = probed.state;
  p = probed.page;
  if (state === 'in') {
    if (probed.renavigated) {
      // The rebuild we just did IS the recovery any pending reset was asking for, and the
      // page it would destroy is the freshly verified one. Leaving the flag set makes the
      // next operation throw away a known-good page for nothing (Codex review) — and a
      // probe deadline sets it on exactly the path that lands us here.
      consumePendingReset('session recovered by re-navigation');
    }
    consecutiveUnknownChecks = 0;
    // A confirmed live session means whatever the last login attempt did, we are fine now
    // (it may have failed *after* actually authenticating, or a human fixed it via /login).
    // Leaving a stale cooldown in place would suppress a genuinely needed re-login later.
    loginThrottle.recordSuccess();
    await maybeDisableMemory(p);
    return p;
  }
  if (state === 'unknown') consecutiveUnknownChecks++;
  const action = decideSessionAction({
    state,
    consecutiveUnknown: consecutiveUnknownChecks,
    escalateAt: SESSION_UNKNOWN_ESCALATE,
  });
  if (action === 'refuse') {
    // Fail closed WITHOUT destroying anything: refuse the request (typed, retryable) and
    // leave the cookies alone.
    const e = new Error(
      `session state could not be verified (${consecutiveUnknownChecks}/${SESSION_UNKNOWN_ESCALATE} inconclusive checks) — ` +
        'not serving on an unverified session; cookies left intact',
    );
    e.code = 'login_failed';
    throw e;
  }
  if (action === 'reset') {
    // A streak of inconclusive checks is a symptom worth acting on, but it is NOT evidence
    // of a logout — so the strongest thing it may justify is a non-destructive context
    // rebuild: hardResetBrowser() relaunches from session.json rather than clearing it.
    // Escalating to autoLogin here (the pre-2.10.2 behaviour) wiped a live session and then
    // could not log back in, because a clean login is what Turnstile blocks.
    //
    // Rate-limited: a permanently unverifiable session keeps satisfying this branch, and
    // rebuilding the whole browser on every request would be a spin loop (Codex review).
    // Between rebuilds we refuse cheaply — the alert is what brings a human.
    const now = Date.now();
    if (!shouldRebuildContext({ lastResetAt: lastContextResetAt, now, cooldownMs: CONTEXT_RESET_COOLDOWN_MS })) {
      const e = new Error(
        'session still unverifiable after a browser-context rebuild ' +
          `${Math.round((now - lastContextResetAt) / 1000)}s ago — ` +
          'not serving on an unverified session; cookies left intact',
      );
      e.code = 'login_failed';
      throw e;
    }
    console.log(
      `[chatgpt] ${consecutiveUnknownChecks} inconclusive session checks in a row — ` +
        'rebuilding the browser context (cookies are NOT cleared)',
    );
    lastContextResetAt = now;
    // Persist whatever the live context has before tearing it down: hardResetBrowser()
    // reloads the last session.json snapshot, so cookies refreshed since the previous save
    // would otherwise be silently rolled back (Codex review). Best-effort and bounded — a
    // failed save must not block the recovery it is protecting.
    await raceDeadline(saveSession().catch(() => {}), SESSION_SAVE_DEADLINE_MS);
    await hardResetBrowser().catch((e) => console.log('[chatgpt] context rebuild failed:', e.message));
    const rebuilt = await getPage();
    await dismissModals(rebuilt);
    const after = await probeSessionState(rebuilt);
    sessionHealth.recordProbe(after, 'context_reset');
    if (after === 'in') {
      // A full context rebuild satisfies ANY reset that was pending, and the page it would
      // otherwise discard is the one we just confirmed live (Codex review).
      consumePendingReset('browser context rebuilt and session confirmed');
      consecutiveUnknownChecks = 0;
      loginThrottle.recordSuccess();
      await maybeDisableMemory(rebuilt);
      return rebuilt;
    }
    if (after === 'unknown') {
      // Still unverifiable after a full rebuild. Refuse (typed, retryable) and let
      // GptWebGatewayLoginFailed bring a human — better than destroying working cookies.
      // The streak is deliberately NOT cleared: zeroing it here would make the next request
      // look like a fresh series and pay for another re-navigation, then another rebuild.
      const e = new Error(
        'session still unverifiable after a full browser-context rebuild — ' +
          'not serving on an unverified session; cookies left intact',
      );
      e.code = 'login_failed';
      throw e;
    }
    // 'out' — now CONFIRMED logged out, so the destructive path below is justified.
  }
  consecutiveUnknownChecks = 0;

  // Checked HERE and not earlier: without credentials there is no auto-login to fall back
  // on, but the non-destructive paths above (refuse / context rebuild) are still the right
  // behaviour for a `/login`-managed session. Throwing before them left the streak frozen
  // at 0, so every request paid for a fresh re-navigation and the rebuild never ran.
  if (!process.env.CHATGPT_EMAIL || !process.env.CHATGPT_PASSWORD) {
    const e = new Error('Not logged in. Set CHATGPT_EMAIL and CHATGPT_PASSWORD for auto-login.');
    e.code = 'login_failed';
    throw e;
  }

  // A login that just failed on a blocking screen will fail the same way one second later;
  // retrying per request only burns attempts (and "too many attempts" is itself one of the
  // screens we get blocked by). Re-surface the previous, already-diagnosed reason instead.
  const blockedFor = loginThrottle.blockedForMs();
  if (blockedFor > 0) {
    const prev = loginThrottle.lastError();
    const reason = prev ? prev.message : 'previous auto-login failed';
    const e = new Error(
      `auto-login on cooldown for ${Math.ceil(blockedFor / 1000)}s after a failed attempt — ${reason}`,
    );
    e.code = 'login_failed';
    if (prev && prev.loginBlocker) e.loginBlocker = prev.loginBlocker;
    if (prev && prev.loginStep) e.loginStep = prev.loginStep;
    if (prev && prev.modelMessage) e.modelMessage = prev.modelMessage;
    throw e;
  }

  console.log(`[chatgpt] Session check returned "${state}" — triggering auto-login...`);
  // From here on the old session is being destroyed (autoLogin → clearSession), so the
  // gauge must drop immediately and without hysteresis: if the login then fails there is
  // no page left to probe, and every later watchdog tick would be an inconclusive
  // 'unknown' that deliberately never lowers the gauge (Codex review).
  sessionHealth.invalidate(`relogin:${state}`);
  try {
    resetPage();
    const ctx = await getContext();
    await autoLogin(ctx);
  } catch (e) {
    // Any failure of the login flow (blocked screen, bad creds, TOTP, Cloudflare, timeout,
    // or a Node system error like EACCES/ENOSPC/network) is a login failure — classify it as
    // such for metrics/alerting. System errors carry their OWN `.code` (EACCES…), so a
    // conditional `if (!e.code)` would misclassify them as server_error; wrap unconditionally,
    // keeping the original as `cause` for the logs.
    const err = new Error(`auto-login failed: ${e.message}`);
    err.code = 'login_failed';
    // Carry the diagnosed blocker outward: it lands in the API error body, the log line and
    // the gpt_web_gateway_login_failures_total{blocker=…} counter.
    err.loginBlocker = e.loginBlocker || 'unknown';
    err.loginStep = e.loginStep;
    if (e.modelMessage) err.modelMessage = e.modelMessage;
    err.cause = e;
    recordLoginFailure(err.loginBlocker);
    loginThrottle.recordFailure(err);
    sessionHealth.invalidate(`login_failed:${err.loginBlocker}`);
    throw err;
  }
  const fresh = await getPage();
  // Authoritative post-login check: autoLogin() declares success on a visible textarea, which
  // is the same false-positive class we fixed in isLoggedIn — so verify via the session
  // endpoint before handing the page to a request. If it's still not logged in, surface a
  // typed login_failed instead of proceeding into an operation that will fail confusingly.
  const after = await probeSessionState(fresh);
  if (after !== 'in') {
    const e = new Error(`auto-login completed but session is still not authenticated (check="${after}")`);
    e.code = 'login_failed';
    e.loginBlocker = 'unknown';
    recordLoginFailure('unknown');
    loginThrottle.recordFailure(e);
    // The cookies were just cleared and the login did not take — this is a hard "no
    // session", regardless of whether the post-check was 'out' or merely 'unknown'.
    sessionHealth.invalidate(`post_login:${after}`);
    throw e;
  }
  sessionHealth.recordProbe(after, 'post_login');
  loginThrottle.recordSuccess();
  await maybeDisableMemory(fresh);
  return fresh;
}

// ==== Traffic-independent session watchdog ====
// The failure this closes: pod Running, /health + /health/live 200, blackbox probe green,
// and the session dead for 34 h because nothing checks it unless a request arrives.
//
// Safety rules (it must never become the thing that breaks the session):
//   - never navigates, clicks or clears cookies — a single GET /api/auth/session issued
//     from the page that is already open, i.e. exactly what the browser does anyway;
//   - skips while a job is queued/running, so it cannot interleave with an operation;
//   - skips while a login is in flight (ensureLoggedIn single-flight guard);
//   - skips when real traffic already proved the session valid within the interval;
//   - never triggers auto-login itself. It only reports; recovery stays on the request
//     path (and on the owner, for a session that needs a manual /login).
//
// The queue check alone is a TOCTOU (a request can enqueue right after it), so an
// in-flight probe is published as `sessionProbeInFlight` and _ensureLoggedIn awaits it —
// the two never drive the page concurrently (Codex review).
let watchdogTimer = null;
let sessionProbeInFlight = null;

async function checkSessionOnce({ force = false } = {}) {
  if (sessionProbeInFlight) {
    // Single-flight: a slow tick must not stack up behind the next one.
    sessionHealth.recordSkip('probe_in_flight');
    return 'skipped';
  }
  if (!force && liveness.snapshot().queue_size > 0) {
    sessionHealth.recordSkip('queue_busy');
    return 'skipped';
  }
  if (ensureLoggedInPromise) {
    sessionHealth.recordSkip('login_in_flight');
    return 'skipped';
  }
  if (pendingReset) {
    // The page is already known-suspect and is about to be rebuilt by the next operation;
    // probing it would only risk another hung call (Codex review).
    sessionHealth.recordSkip('reset_pending');
    return 'skipped';
  }
  if (!force && sessionHealth.isFreshlyValid(SESSION_WATCHDOG_INTERVAL_MS)) {
    sessionHealth.recordSkip('recent_traffic');
    return 'skipped';
  }
  const p = page;
  if (!p || p.isClosed()) {
    // No page = nothing to ask. Deliberately does NOT open one: booting a browser from a
    // timer could race the request path. Stays 'unknown', which keeps the gauge at its
    // last value and ages session_check_age_seconds.
    sessionHealth.recordProbe('unknown', 'no_page');
    return 'unknown';
  }
  // Fewer attempts than the request path: this is a background poll, and the request path
  // may be waiting on this exact promise.
  const probe = probeSessionState(p, { attempts: Math.min(2, SESSION_PROBE_ATTEMPTS) });
  sessionProbeInFlight = probe;
  let state = 'unknown';
  try {
    state = await probe;
  } catch (e) {
    console.log('[session-watchdog] probe error:', e.message);
    state = 'unknown';
  } finally {
    if (sessionProbeInFlight === probe) sessionProbeInFlight = null;
  }
  sessionHealth.recordProbe(state, 'watchdog');
  if (state !== 'in') {
    console.log(`[session-watchdog] session check = ${state} (gauge session_valid=${sessionHealth.snapshot().session_valid})`);
  }
  return state;
}

function startSessionWatchdog() {
  if (!SESSION_WATCHDOG_ENABLED || watchdogTimer) return null;
  watchdogTimer = setInterval(() => {
    checkSessionOnce().catch((e) => console.log('[session-watchdog] tick failed:', e.message));
  }, SESSION_WATCHDOG_INTERVAL_MS);
  // Don't hold the event loop open (tests, CLI entry points).
  if (watchdogTimer.unref) watchdogTimer.unref();
  console.log(`[session-watchdog] enabled — every ${Math.round(SESSION_WATCHDOG_INTERVAL_MS / 1000)}s`);
  return watchdogTimer;
}

function stopSessionWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

// Proactive session warm-up, called once at boot (see server.js). Establishes/validates the
// ChatGPT session BEFORE any traffic arrives instead of lazily on the first request — so a
// fresh pod (or one whose session.json expired while it was down) re-logs-in immediately
// rather than failing the first caller. Best-effort: any failure is logged and swallowed;
// the normal per-request ensureLoggedIn still runs as the safety net.
async function ensureSessionReady() {
  try {
    const p = await ensureLoggedIn();
    const state = await probeSessionState(p);
    sessionHealth.recordProbe(state, 'startup');
    console.log(`[startup] session ready — state=${state}`);
    return state === 'in';
  } catch (e) {
    // A failed warm-up used to leave zero externally visible trace — the gauge now shows it.
    sessionHealth.recordProbe('out', 'startup_failed');
    console.log('[startup] session warm-up failed (will retry on first request):', e.message);
    if (e.loginBlocker && e.loginBlocker !== 'unknown') {
      console.log(`[startup] login blocker = ${e.loginBlocker} — manual /login may be required`);
    }
    return false;
  }
}

// One attempt per process — the setting persists server-side on the account, so
// repeating it per request would only add noise (and extra unofficial API calls).
let memoryDisableAttempted = false;

async function maybeDisableMemory(p) {
  if (!DISABLE_CHATGPT_MEMORY || memoryDisableAttempted) return;
  memoryDisableAttempted = true;
  try {
    const results = await p.evaluate(async (features) => {
      const out = [];
      let token = null;
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (r.ok) token = (((await r.json()) || {}).accessToken) || null;
      } catch {}
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      for (const feature of features) {
        try {
          const url = `/backend-api/settings/account_user_setting?feature=${encodeURIComponent(feature)}&value=false`;
          const resp = await fetch(url, { method: 'PATCH', headers, credentials: 'include' });
          out.push({ feature, ok: resp.ok, status: resp.status });
        } catch (e) {
          out.push({ feature, ok: false, error: String((e && e.message) || e) });
        }
      }
      return out;
    }, MEMORY_DISABLE_FEATURES);
    const failed = results.filter((r) => !r.ok);
    console.log(`[memory] disable ChatGPT memory (best-effort): ${JSON.stringify(results)}`);
    if (failed.length) {
      console.log('[memory] some settings PATCHes failed — account memory may still be active. '
        + 'Best-effort feature: the endpoint/feature names are unofficial and may have changed.');
    }
  } catch (e) {
    console.log('[memory] disable attempt failed (best-effort, continuing):', e.message);
  }
}

// options: { thinking/thinkingMode, aspectRatio, quality, references: [{buffer,mimeType,filename}], reuseChat }
// Returns { url, b64_json, contentType, applied: { thinking, references_attached } }
async function generateImage(prompt, options = {}) {
  await maybeRecoverSession();
  let p = await ensureLoggedIn();

  if (!options.reuseChat) await ensureNewChat(p);
  else await composerPreflight(p); // reuseChat skips ensureNewChat — overlays still must die

  const isFirstTurn = !options.reuseChat;

  // Thinking level BEFORE upload (Codex plan-review): if the pill flow degrades and forces
  // a session recovery, no uploaded attachments are lost — they aren't there yet.
  const thinkingMode = normalizeThinkingMode(options.thinkingMode ?? options.thinking);
  // setThinkingMode reports the REAL applied state so the API can't lie in `applied`.
  const thinkingState = await setThinkingMode(p, thinkingMode);

  let referencesAttached = 0;
  if (isFirstTurn && options.references && options.references.length > 0) {
    // Bug #6 (Opus): use confirmed count, not requested count.
    // If preview never showed, treat as 0 attached — applied won't lie.
    referencesAttached = await uploadPrimaryAndRefs(p, null, options.references);
  }

  const qualityHint = options.quality ? `\n\nQuality: ${options.quality}.` : '';
  const finalPrompt = appendAspectRatioHint(`Generate an image: ${prompt}${qualityHint}`, options.aspectRatio);
  const beforeState = await captureConversationState(p);
  const preserveAttachments = isFirstTurn && referencesAttached > 0;
  await typeAndSubmit(p, finalPrompt, preserveAttachments);
  const result = await waitAndExtractImage(p, beforeState, {
    prompt,
    thinkingMode: thinkingState.mode || thinkingMode,
    refs: referencesAttached,
  });
  if (thinkingState.verified) markHealthyCompletion();
  return {
    ...result,
    applied: {
      thinking: thinkingState.mode !== 'instant',
      thinking_mode: thinkingState.mode || 'instant',
      thinking_verified: !!thinkingState.verified,
      requested_verified: !!thinkingState.requestedVerified,
      thinking_fallback: thinkingState.fallback || null,
      references_attached: referencesAttached,
      ab_variants: result.ab_variants || 0,
      ab_selected_index: result.ab_selected_index || null,
    },
  };
}

async function editImage(prompt, imageInput, options = {}) {
  await maybeRecoverSession();
  let p = await ensureLoggedIn();

  if (!options.reuseChat) await ensureNewChat(p);
  else await composerPreflight(p);

  // Thinking level BEFORE upload — a pill-flow recovery must not cost uploaded files.
  const thinkingMode = normalizeThinkingMode(options.thinkingMode ?? options.thinking);
  const thinkingState = await setThinkingMode(p, thinkingMode);

  // Single setInputFiles for primary + references — appending would REPLACE the file set
  console.log('Uploading image (+ references if any)...');
  const refs = options.references || [];
  const totalFilesConfirmed = await uploadPrimaryAndRefs(p, imageInput, refs);
  // Primary is REQUIRED for an edit. If no chips at all are visible after retries,
  // ChatGPT would otherwise generate a brand-new image from prompt text only —
  // surface as a retryable error instead of silently lying with a mismatched result.
  if (imageInput && totalFilesConfirmed === 0) {
    // Grab the visible UI error (broken upload composer shows a toast/banner) BEFORE
    // cleaning up — its text tells the API client exactly what ChatGPT displayed.
    const uiError = await readUiErrorBanner(p);
    await removePendingAttachments(p).catch(() => {});
    if (uiError) console.log(`[upload] UI error banner: "${uiError}"`);
    const err = new Error('Image upload to ChatGPT failed: no attachment preview after retries');
    err.code = 'upload_failed';
    if (uiError) err.modelMessage = uiError;
    throw err;
  }
  // confirmed count includes primary; refs_attached = max(0, confirmed - 1)
  const referencesConfirmed = Math.max(0, totalFilesConfirmed - 1);

  const qualityHint = options.quality ? `\n\nQuality: ${options.quality}.` : '';
  const finalPrompt = appendAspectRatioHint(`Edit this image: ${prompt}${qualityHint}`, options.aspectRatio);
  const beforeState = await captureConversationState(p);
  await typeAndSubmit(p, finalPrompt, true);
  const result = await waitAndExtractImage(p, beforeState, {
    prompt,
    thinkingMode: thinkingState.mode || thinkingMode,
    refs: referencesConfirmed,
  });
  if (thinkingState.verified) markHealthyCompletion();
  return {
    ...result,
    applied: {
      thinking: thinkingState.mode !== 'instant',
      thinking_mode: thinkingState.mode || 'instant',
      thinking_verified: !!thinkingState.verified,
      requested_verified: !!thinkingState.requestedVerified,
      thinking_fallback: thinkingState.fallback || null,
      references_attached: referencesConfirmed,
      ab_variants: result.ab_variants || 0,
      ab_selected_index: result.ab_selected_index || null,
    },
  };
}

async function completeText(prompt, options = {}) {
  // Page-load failures on chatgpt.com tend to come in bursts (CF challenge,
  // empty SPA boot, transient 5xx from OpenAI). One in-process retry leaves a
  // visible failure rate on the caller; multiple attempts with a fresh page each
  // time keep the public success ratio close to UI reality. A second consecutive
  // page_load_failed escalates to a full browser-context rebuild (see catch block).
  const maxAttempts = CHATGPT_TEXT_RETRY_ATTEMPTS;
  let lastError;
  let pageLoadFailures = 0;
  // Streaming guard: once onDelta has fired, bytes of THIS attempt's answer are already
  // on the client's wire. A retry would start a different answer that can never be
  // reconciled with the streamed prefix — so after the first delta, failures are final.
  let anyDeltaEmitted = false;
  const onDelta = options.onDelta
    ? (fullText) => { anyDeltaEmitted = true; options.onDelta(fullText); }
    : undefined;
  // Input time across ALL attempts — a retried turn already spent it once.
  let inputSpentMs = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Becomes true once THIS attempt has actually sent the prompt. A logout/navigation error
    // AFTER submit must not retry — a fresh chat would re-send the same prompt (duplicate
    // generation / side effects). Before submit, retrying is safe.
    let submitted = false;
    try {
      // Prep is INSIDE the try — ensureNewChat/setThinkingMode can also die on a broken
      // page, and those failures must ride the same retry/hard-reset machinery.
      await maybeRecoverSession();
      const p = await ensureLoggedIn();

      if (options.conversationId) await openConversation(p, options.conversationId);
      else if (!options.reuseChat || attempt > 0) await ensureNewChat(p);
      else await composerPreflight(p);

      const thinkingMode = normalizeThinkingMode(options.thinkingMode ?? options.thinking);
      const thinkingState = await setThinkingMode(p, thinkingMode);

      const beforeState = await captureTextState(p);
      // Prime BEFORE opening the capture, and the order is load-bearing twice over.
      //
      // (a) `page.on('load')` covers real document navigations, but ChatGPT is an SPA and a
      //     client-side route change fires no 'load' — so a turn could start on a main world
      //     Node has never touched, leaving every chunk stranded in the page buffer (agy).
      // (b) Draining AFTER `beginBackendCapture()` would feed the previous navigation's
      //     leftover chunks into the NEW capture: those stream ids predate it but are not in
      //     `staleStreams`, so the first one would win `boundStream` and the real answer would
      //     then be ignored as belonging to a different stream (Codex). Draining first lets
      //     them land while `currentCapture` is still null, which is exactly what marks them
      //     stale.
      await primeMainWorld(p);
      const capture = beginBackendCapture(); // null unless READ_VIA_BACKEND_API=1
      // Mark submitted at the confirmed-send instant (inside typeAndSubmit), not just on
      // return — a failure in its trailing settle wait must still count as submitted so we
      // never retry into a duplicate send. The post-call assignment is a backstop.
      const timing = {};
      try {
        await typeAndSubmit(p, prompt, false, () => { submitted = true; }, timing);
      } finally {
        inputSpentMs += timing.inputMs || 0;
      }
      submitted = true;
      // Use the APPLIED mode (what the composer really shows), not the requested one — if the
      // UI stayed on a thinking level the reasoning-placeholder guard must stay armed.
      const result = await waitAndExtractText(p, beforeState, {
        thinkingMode: thinkingState.mode || thinkingMode,
        capture,
        onDelta,
        prompt,      // subtracted from the tier-limit scan: it is rendered on the page too
        inputMs: inputSpentMs, // every attempt's input, not just this one's
      });

      if (thinkingState.verified) markHealthyCompletion();
      // conversation_id sources, best first: backend-api capture → chat URL after the
      // answer → the id the caller asked to continue. May stay null (e.g. the answer
      // finished before the SPA navigated to /c/<id>).
      const conversationId = result.conversationId
        || conversationIdFromUrl(p.url())
        || (options.conversationId ? options.conversationId.toLowerCase() : null);
      return {
        text: result.text,
        conversation_id: conversationId,
        applied: {
          thinking: thinkingState.mode !== 'instant',
          thinking_mode: thinkingState.mode || 'instant',
          thinking_verified: !!thinkingState.verified,
          requested_verified: !!thinkingState.requestedVerified,
          thinking_fallback: thinkingState.fallback || null,
        },
      };
    } catch (err) {
      lastError = err;
      const isPageLoad =
        err.code === 'page_load_failed' || /content failed to load/i.test(err.message || '');
      // Session died MID-turn: ChatGPT redirected to /auth/login while we were driving the
      // composer/menu, so Playwright's execution context vanished under us. "Execution context
      // was destroyed" ALSO fires on benign SPA navigation (/ → /c/<id>).
      const isLogout =
        err.code === 'logged_out' ||
        /execution context was destroyed|because of a navigation/i.test(err.message || '');
      const transient =
        isPageLoad || isLogout || /target page, context or browser has been closed/i.test(err.message || '');
      // Only a genuine page_load_failed (not a normal close race) counts toward the
      // hard-reset escalation: a repeated one means the context's service-worker cache
      // is serving a broken app-shell, so a fresh page in the same context won't help.
      if (isPageLoad) pageLoadFailures++;
      const needsHardReset = isPageLoad && pageLoadFailures >= 2 && TEXT_HARD_RESET_ENABLED;
      const lastAttempt = attempt >= maxAttempts - 1;

      // Once the prompt is submitted, NO transient error is retried — a fresh page + a fresh
      // chat would re-issue the same prompt (duplicate generation / side effects). This
      // subsumes the streaming guard for non-streaming turns. Retries only ever recover
      // PRE-submit failures (login / new-chat / thinking-mode / page load during boot).
      if (!transient || lastAttempt || anyDeltaEmitted || submitted) {
        if (submitted && transient && !lastAttempt && !anyDeltaEmitted) {
          console.log('[chatgpt] transient failure AFTER submit — not retrying (would resubmit the prompt)');
        }
        if (anyDeltaEmitted && transient && !lastAttempt) {
          console.log('[chatgpt] transient failure AFTER streaming started — not retrying (streamed prefix cannot be reconciled)');
        }
        // Giving up — but still clear a poisoned context so the NEXT request starts clean.
        if (needsHardReset) await hardResetBrowser();
        throw err;
      }

      console.log(`[chatgpt] Text turn failed (${err.code || 'page_load'}) — ${needsHardReset ? 'hard browser reset' : 'fresh page'}, retry ${attempt + 2}/${maxAttempts}...`);
      if (needsHardReset) {
        await hardResetBrowser();
      } else {
        resetPage();
      }
      // Light backoff so we don't slam ChatGPT during a wider outage.
      await new Promise(r => setTimeout(r, 1500 + 1000 * attempt));
    } finally {
      // Stop feeding this turn's accumulator — a late/leaked SSE body from an aborted
      // attempt must never bleed into the next turn's capture.
      endBackendCapture();
    }
  }
  throw lastError;
}

function resetPage() {
  if (page && !page.isClosed()) page.close().catch(() => {});
  page = null;
}

// Full browser-context rebuild: closes the browser so the next getContext() relaunches a
// clean context (new service-worker scope, fresh storageState from session.json). Recovers
// from a poisoned app-shell cache that survives plain page resets. Login is preserved —
// getContext reloads session.json and ensureLoggedIn re-triggers auto-login if expired.
async function hardResetBrowser() {
  resetPage();
  await closeBrowser().catch(() => {});
}

module.exports = {
  generateImage,
  editImage,
  completeText,
  getPage,
  isLoggedIn,
  probeSessionState,
  probeSessionWithRecovery,
  ensureSessionReady,
  startSessionWatchdog,
  stopSessionWatchdog,
  checkSessionOnce,
  resetPage,
  probeCapabilities,
  normalizeThinkingMode,
  READ_VIA_BACKEND_API,
  // Test-only: pure page-context predicate (reads the global `document`). Exported so
  // scripts/test-refusal-detect.js can exercise refusal/success detection with a DOM stub.
  // setThinkingMode is exported with its dependency seam so scripts/test-tiers.js can drive
  // the tier-fallback loop (chain walking, cooldown, degradation accounting) without a browser.
  // waitAndExtractImage is exported so scripts/test-refusal-detect.js can assert what a
  // non-success outcome turns INTO (error code + retryability), not just that the DOM
  // predicate spotted it. That half was untested, which is how the 2.10.0 temporal-dead-zone
  // regression shipped: it threw for every refusal, and `node --check` plus the whole suite
  // stayed green. A page double is enough — the throw happens long before any image work.
  _test: {
    fillTimeoutMs,
    typeFallbackTimeoutMs,
    responseBaseBudgetMs,
    CHAT_COMPLETION_TIMEOUT_MS,
    waitAndExtractText,
    typeAndSubmit,
    imageOutcomePredicate,
    setThinkingMode,
    waitAndExtractImage,
    menuFailures: () => consecutiveMenuFailures,
    resetMenuFailures: () => { consecutiveMenuFailures = 0; },
  },
};
