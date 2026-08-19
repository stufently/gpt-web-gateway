// Simple Prometheus metrics — no external dependencies
const counters = {
  requests_total: 0,
  errors_total: {
    server_error: 0,
    rate_limit: 0,
    policy_violation: 0,
    login_failed: 0,
    refused: 0,
    queue_full: 0,
    timeout: 0,
    upload_failed: 0,
    // ChatGPT SPA failed to render (CF challenge, empty boot, transient 5xx).
    // Tracked separately so alerting can distinguish "their site is flaky"
    // from "our adapter timed out waiting for a response".
    page_load_failed: 0,
    // Multi-turn: requested conversation_id does not exist / is not accessible
    // from this account. Deterministic client error (404), never retried.
    conversation_not_found: 0,
    // The account's quota for the REQUESTED intelligence tier (Pro) is exhausted and
    // ChatGPT only said so after the prompt was sent. Deliberately NOT `rate_limit`:
    // that kind arms a global cooldown that blocks every endpoint for 30 min, while this
    // affects exactly one tier — a retry succeeds immediately on the fallback tier.
    tier_limit: 0,
  },
  generations_total: 0,
  edits_total: 0,
};

// Duration histogram: gpt_web_gateway_duration_seconds{result="..."}
// Buckets in seconds — last "+Inf" bucket is implicit.
const DURATION_BUCKETS = [5, 10, 20, 30, 60, 90, 120, 180, 240, 300];
// Stable label set so /metrics always emits the full series (good for Grafana templating).
const DURATION_LABELS = [
  'success', 'refused', 'policy_violation', 'rate_limit', 'login_failed',
  'timeout', 'server_error', 'queue_full', 'upload_failed', 'page_load_failed',
  'conversation_not_found', 'tier_limit',
];

function makeHistogramSeries() {
  return { buckets: new Array(DURATION_BUCKETS.length).fill(0), inf: 0, sum: 0, count: 0 };
}

const histograms = {
  duration_seconds: Object.fromEntries(DURATION_LABELS.map((l) => [l, makeHistogramSeries()])),
};

function incRequests() { counters.requests_total++; }
function incGenerations() { counters.generations_total++; }
function incEdits() { counters.edits_total++; }

function incError(type) {
  if (counters.errors_total[type] !== undefined) {
    counters.errors_total[type]++;
  } else {
    counters.errors_total.server_error++;
  }
}

function incQueueFull() { counters.errors_total.queue_full++; }

function classifyError(message, code) {
  // err.code is the authoritative path (set by chatgpt.js when it raises a known
  // failure mode). Falls back to message-substring matching for legacy callers.
  if (code && counters.errors_total[code] !== undefined) return code;
  const msg = (message || '').toLowerCase();
  // Check page-load failure BEFORE the generic timeout heuristic — its message
  // doesn't include "timeout" but a stale legacy caller may surface it.
  if (msg.includes('content failed to load')) return 'page_load_failed';
  if (msg.includes('rate limit') || msg.includes('лимит')) return 'rate_limit';
  if (msg.includes('policy') || msg.includes('guardrail') || msg.includes('copyright')) return 'policy_violation';
  if (msg.includes('not logged in') || msg.includes('auto-login') || msg.includes('session expired')) return 'login_failed';
  if (msg.includes('refused')) return 'refused';
  // Distinguish Playwright timeout from generic server errors so alerts can be tuned.
  // Catches "Timeout 180000ms exceeded", "did not return ... in time",
  // "did not return an image within Ns", "adaptive retry exhausted".
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('did not return') ||
    msg.includes('adaptive retry exhausted')
  ) return 'timeout';
  return 'server_error';
}

// Map error_kind → whether the caller should retry the same prompt.
// Refusal/policy/rate-limit are deterministic — same input yields the same outcome.
// queue_full is transient capacity pressure — caller should retry after Retry-After.
function shouldRetryKind(kind) {
  switch (kind) {
    case 'server_error':
    case 'timeout':
    case 'login_failed':
    case 'queue_full':
    case 'upload_failed':
    case 'page_load_failed':
    // Retryable on purpose: the tier is memoized as unavailable the moment this fires, so
    // the very next attempt is served one tier down instead of hitting the same wall.
    case 'tier_limit':
      return true;
    default:
      return false; // refused, policy_violation, rate_limit, invalid_request, unknown
  }
}

function observeDuration(resultLabel, seconds) {
  const label = histograms.duration_seconds[resultLabel] ? resultLabel : 'server_error';
  const series = histograms.duration_seconds[label];
  if (!Number.isFinite(seconds) || seconds < 0) return;
  series.sum += seconds;
  series.count += 1;
  let placed = false;
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (seconds <= DURATION_BUCKETS[i]) {
      series.buckets[i] += 1;
      placed = true;
      // Note: Prometheus convention is cumulative buckets — we render them cumulatively at emit time.
      // Storing per-bucket counts here keeps the increment O(1).
      break;
    }
  }
  if (!placed) series.inf += 1;
}

// Fallback counters with a guaranteed zero-baseline for the configured pro fallback.
function renderFallbackSeries(recorded, env = process.env) {
  const { fallbackFor } = require('./chatgpt-tiers');
  const series = new Map();
  const proFallback = fallbackFor('pro', env);
  if (proFallback) series.set(`pro|${proFallback}`, 0);
  for (const { from, to, count } of recorded) series.set(`${from}|${to}`, count);
  return [...series.entries()].map(([key, count]) => {
    const [from, to] = key.split('|');
    return `gpt_web_gateway_tier_fallbacks_total{from="${from}",to="${to}"} ${count}`;
  });
}

function metricsHandler(req, res) {
  // Queue/session-health gauges — the degraded-session detectors behind /health/live.
  const { progress } = require('./progress');
  const { sessionHealth, loginFailures } = require('./session-health');
  // Lazily required (like the two above) to keep metrics.js free of a require cycle and to
  // avoid pulling the Playwright stack into processes that only render metrics.
  const { browserFingerprint } = require('./browser');
  // Pure module (no Playwright) — safe to require here as well as from the adapter.
  const { tierAvailability } = require('./chatgpt-tiers');
  const health = progress.snapshot();
  const session = sessionHealth.snapshot();
  const tiers = tierAvailability.snapshot();
  const lines = [
    // 1 = a real page reported a user agent with no headless token; 0 = it still advertises a
    // headless build, OR nothing has been verified yet (same "0 until confirmed" convention
    // as session_valid — an unverified browser must not read as healthy).
    // Deliberately named after what it measures: this is ONE observable, not a verdict on the
    // whole fingerprint. A 0 is strong evidence the stealth evasions stopped applying (with
    // them the gateway is served HTTP 200, without them `403 cf-mitigated: challenge` from the
    // same host). A 1 is not a clean bill of health — in the configuration that passes today,
    // `userAgentData` high-entropy hints still report HeadlessChrome.
    '# HELP gpt_web_gateway_browser_ua_evasion_ok Effective user agent carries no headless token: 1 = yes, 0 = leaking or not yet verified',
    '# TYPE gpt_web_gateway_browser_ua_evasion_ok gauge',
    `gpt_web_gateway_browser_ua_evasion_ok ${browserFingerprint.ua_evasion_ok}`,
    '',
    // Rising while ua_evasion_ok is 1 points at the egress IP rather than the fingerprint.
    '# HELP gpt_web_gateway_cloudflare_challenges_total Page loads abandoned on an uncleared Cloudflare challenge',
    '# TYPE gpt_web_gateway_cloudflare_challenges_total counter',
    `gpt_web_gateway_cloudflare_challenges_total ${browserFingerprint.cloudflare_challenges}`,
    '',
    // THE gauge an alert is built on: 1 = the last conclusive check said "logged in",
    // 0 = confirmed logged out (or never confirmed since boot). Green /health with
    // session_valid=0 is precisely the 34 h silent outage of 2026-07-25.
    '# HELP gpt_web_gateway_session_valid ChatGPT session validity: 1 = logged in, 0 = logged out or unconfirmed',
    '# TYPE gpt_web_gateway_session_valid gauge',
    `gpt_web_gateway_session_valid ${session.session_valid}`,
    '',
    '# HELP gpt_web_gateway_session_check_age_seconds Seconds since the last conclusive session check',
    '# TYPE gpt_web_gateway_session_check_age_seconds gauge',
    `gpt_web_gateway_session_check_age_seconds ${Math.round(session.check_age_ms / 1000)}`,
    '',
    '# HELP gpt_web_gateway_session_checks_total Session checks by outcome (in/out/unknown)',
    '# TYPE gpt_web_gateway_session_checks_total counter',
    `gpt_web_gateway_session_checks_total{result="in"} ${session.probes.in}`,
    `gpt_web_gateway_session_checks_total{result="out"} ${session.probes.out}`,
    `gpt_web_gateway_session_checks_total{result="unknown"} ${session.probes.unknown}`,
    '',
    '# HELP gpt_web_gateway_login_failures_total Auto-login failures by the screen that blocked them',
    '# TYPE gpt_web_gateway_login_failures_total counter',
    ...Object.entries(loginFailures).map(
      ([blocker, count]) => `gpt_web_gateway_login_failures_total{blocker="${blocker}"} ${count}`,
    ),
    '',
    // Rising = the account is out of Pro quota (or the tier stopped being selectable) and
    // requests are being served one tier down. Nothing is failing, so no error counter moves;
    // without this series the downgrade is invisible outside the pod log.
    '# HELP gpt_web_gateway_tier_fallbacks_total Requests served on a lower intelligence tier than asked for',
    '# TYPE gpt_web_gateway_tier_fallbacks_total counter',
    // The configured pro→X series is ALWAYS emitted, at 0 if it never fired: a series that
    // only appears once something goes wrong is invisible to a dashboard until it is too
    // late, and it vanished entirely as soon as a differently-configured pair was recorded.
    ...renderFallbackSeries(tiers.fallbacks),
    '',
    // 1 while we remember a tier as unavailable and skip straight to the fallback. Expires by
    // itself (TIER_UNAVAILABLE_COOLDOWN_SEC) or the moment the tier is selected successfully.
    '# HELP gpt_web_gateway_tier_cooldown_active Intelligence tier currently memoized as unavailable',
    '# TYPE gpt_web_gateway_tier_cooldown_active gauge',
    `gpt_web_gateway_tier_cooldown_active{tier="pro"} ${tiers.cooldowns.some((c) => c.mode === 'pro') ? 1 : 0}`,
    '',
    '# HELP gpt_web_gateway_queue_size Jobs queued or running',
    '# TYPE gpt_web_gateway_queue_size gauge',
    `gpt_web_gateway_queue_size ${health.queue_size}`,
    '',
    '# HELP gpt_web_gateway_seconds_since_progress Seconds since last liveness heartbeat',
    '# TYPE gpt_web_gateway_seconds_since_progress gauge',
    `gpt_web_gateway_seconds_since_progress ${Math.round(health.ms_since_progress / 1000)}`,
    '',
    '# HELP gpt_web_gateway_consecutive_infra_failures Consecutive jobs failed with infra errors',
    '# TYPE gpt_web_gateway_consecutive_infra_failures gauge',
    `gpt_web_gateway_consecutive_infra_failures ${health.consecutive_infra_failures}`,
    '',
    '# HELP gpt_web_gateway_requests_total Total API requests',
    '# TYPE gpt_web_gateway_requests_total counter',
    `gpt_web_gateway_requests_total ${counters.requests_total}`,
    '',
    '# HELP gpt_web_gateway_generations_total Successful image generations',
    '# TYPE gpt_web_gateway_generations_total counter',
    `gpt_web_gateway_generations_total ${counters.generations_total}`,
    '',
    '# HELP gpt_web_gateway_edits_total Successful image edits',
    '# TYPE gpt_web_gateway_edits_total counter',
    `gpt_web_gateway_edits_total ${counters.edits_total}`,
    '',
    '# HELP gpt_web_gateway_errors_total Total errors by type',
    '# TYPE gpt_web_gateway_errors_total counter',
  ];

  for (const [type, count] of Object.entries(counters.errors_total)) {
    lines.push(`gpt_web_gateway_errors_total{type="${type}"} ${count}`);
  }

  lines.push('');
  lines.push('# HELP gpt_web_gateway_duration_seconds Request duration in seconds by terminal result');
  lines.push('# TYPE gpt_web_gateway_duration_seconds histogram');

  for (const label of DURATION_LABELS) {
    const series = histograms.duration_seconds[label];
    let cumulative = 0;
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      cumulative += series.buckets[i];
      lines.push(`gpt_web_gateway_duration_seconds_bucket{result="${label}",le="${DURATION_BUCKETS[i]}"} ${cumulative}`);
    }
    cumulative += series.inf;
    lines.push(`gpt_web_gateway_duration_seconds_bucket{result="${label}",le="+Inf"} ${cumulative}`);
    // Use toFixed only to avoid scientific notation; Prometheus accepts plain decimals.
    lines.push(`gpt_web_gateway_duration_seconds_sum{result="${label}"} ${series.sum.toFixed(3)}`);
    lines.push(`gpt_web_gateway_duration_seconds_count{result="${label}"} ${series.count}`);
  }

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n') + '\n');
}

module.exports = {
  incRequests,
  incGenerations,
  incEdits,
  incError,
  incQueueFull,
  classifyError,
  shouldRetryKind,
  observeDuration,
  metricsHandler,
  // exported for tests / introspection
  _internal: { counters, histograms, DURATION_BUCKETS, DURATION_LABELS },
};
