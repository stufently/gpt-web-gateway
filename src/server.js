require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const imagesRouter = require('./routes/images');
const loginRouter = require('./routes/login');
const { metricsHandler } = require('./metrics');
const { progress } = require('./progress');
const { createAuthMiddleware } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

// Per-request access log: short request id + open/close lines. Helps trace which
// payload caused a downstream issue without grepping for prompt fragments.
// Skipped for noisy/uninteresting paths (static, health, metrics).
const ACCESS_LOG_SKIP = /^\/(health|metrics|favicon\.ico|images\/|index\.html|css\/|js\/)/;
app.use((req, res, next) => {
  if (ACCESS_LOG_SKIP.test(req.path)) return next();
  req.id = crypto.randomBytes(4).toString('hex');
  req.startedAt = Date.now();
  const ct = (req.headers['content-type'] || '').split(';')[0];
  const cl = req.headers['content-length'] || '?';
  console.log(`[req ${req.id}] > ${req.method} ${req.path} ct=${ct} cl=${cl}`);
  res.on('finish', () => {
    const ms = Date.now() - req.startedAt;
    console.log(`[req ${req.id}] < ${res.statusCode} duration=${(ms / 1000).toFixed(2)}s`);
  });
  next();
});

// Optional app-level auth: set API_KEY to require credentials on all /v1/* and
// /login/* routes. Accepts either `Authorization: Bearer <API_KEY>` or Basic auth
// with any username and the API_KEY as password (so OpenAI SDKs, browsers and
// curl -u all work). When API_KEY is unset the gateway is open, matching the
// historical deployment where auth lives on the ingress (htpasswd). /health,
// /health/live and /metrics stay unauthenticated on purpose — probes and
// Prometheus scrapers should not need credentials. Registered BEFORE the body
// parser so unauthenticated clients cannot make us parse 50 MB payloads.
const API_KEY = process.env.API_KEY || '';
if (API_KEY) {
  const requireAuth = createAuthMiddleware(API_KEY);
  app.use('/v1', requireAuth);
  // /login streams browser screenshots and accepts keyboard/navigation input —
  // as sensitive as the API itself.
  app.use('/login', requireAuth);
}

app.use(express.json({ limit: '50mb' }));

// Serve static files (frontend + generated images)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(imagesRouter);
app.use(loginRouter);

// Readiness: process is up and can serve HTTP. Deliberately does NOT depend on the
// browser session — a degraded session must not remove the (single) replica from the
// Service; that is the liveness endpoint's job.
app.get('/health', (req, res) => res.json({ status: 'ok' }));
// Liveness: 503 when the browser layer is wedged (no progress with queued work) or the
// last N jobs all died with infra errors — k8s restarts the pod (automates the manual
// restarts that cured the 2026-07-10 degraded-session incidents). See src/progress.js.
app.get('/health/live', (req, res) => {
  const verdict = progress.liveness();
  const body = { status: verdict.alive ? 'ok' : 'stuck', reason: verdict.reason, ...progress.snapshot() };
  res.status(verdict.alive ? 200 : 503).json(body);
});
app.get('/metrics', metricsHandler);

// Error handler — no stack traces
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
  }
  res.status(500).json({ error: { message: err.message, type: 'server_error' } });
});

app.listen(PORT, () => {
  console.log(`gpt-web-gateway running on http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/v1/images/generations`);
  // Proactively warm up the ChatGPT session at boot (non-blocking, best-effort) instead of
  // lazily on the first request — a fresh pod re-logs-in before any traffic arrives. The
  // per-request ensureLoggedIn remains the safety net if this fails.
  const { ensureSessionReady, startSessionWatchdog } = require('./chatgpt');
  ensureSessionReady()
    .catch((e) => console.log('[startup] session warm-up error:', e.message))
    // Traffic-independent session watchdog — keeps gpt_web_gateway_session_valid fresh even
    // when nobody calls the API, so a dead session is visible in minutes instead of after
    // the next failed request (or, as in the 2026-07-25 incident, 34 hours later).
    .finally(() => startSessionWatchdog());
});
