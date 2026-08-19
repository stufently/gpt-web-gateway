const { Router } = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
// READ_VIA_BACKEND_API is imported (not re-parsed) so the streaming gate can never
// disagree with the actual interception layer about the flag's default.
const {
  generateImage, editImage, completeText, probeCapabilities, READ_VIA_BACKEND_API,
} = require('../chatgpt');
const { parseBool, normalizeThinkingMode, parseThinkingMode, parseWebSearchRequested } = require('../params');
const { isValidConversationId } = require('../lib/conversation-read');
const { createStreamEmitter } = require('../lib/sse-transform');
const { progress } = require('../progress');
const { createPacer } = require('../pacer');
const {
  incRequests, incGenerations, incEdits, incError, classifyError, incQueueFull,
  observeDuration, shouldRetryKind,
} = require('../metrics');

// Build a structured failure body that augments — but does not break — the legacy
// `{ error: { message, type, retry_after? } }` contract that skill scripts parse.
function buildErrorBody({ kind, message, modelMessage, retryAfter, loginBlocker, loginStep }) {
  const errObj = { message, type: kind === 'rate_limit' ? 'rate_limit_error' : 'server_error' };
  if (Number.isFinite(retryAfter)) errObj.retry_after = retryAfter;
  const body = {
    ok: false,
    error_kind: kind,
    should_retry: shouldRetryKind(kind),
    model_message: modelMessage || null,
    error: errObj,
  };
  // Machine-readable cause of a login failure, so a caller (or an on-call human) knows in
  // one field whether we are stuck behind Cloudflare, a captcha, a device-verification
  // screen or an attempt lockout — instead of grepping it out of `message`.
  if (loginBlocker) body.login_blocker = loginBlocker;
  if (loginStep) body.login_step = loginStep;
  return body;
}

const router = Router();
const IMAGES_DIR = path.join(__dirname, '..', '..', 'public', 'images');

// One-line summary of an incoming request after payload has been parsed.
// Helps trace which client/pipeline submitted a given prompt+image combination.
function logRequestDetails(req, kind, details) {
  const id = req.id || '????????';
  const parts = [`[req ${id}] ${kind}`];
  if (details.prompt) {
    const p = String(details.prompt).replace(/\s+/g, ' ').slice(0, 200);
    parts.push(`prompt="${p}"`);
  }
  if (Number.isFinite(details.promptLen)) parts.push(`prompt_len=${details.promptLen}`);
  if (details.hasImage !== undefined) parts.push(`image=${details.hasImage ? 'yes' : 'no'}`);
  if (Number.isFinite(details.references)) parts.push(`refs=${details.references}`);
  if (details.thinkingMode) parts.push(`thinking_mode=${details.thinkingMode}`);
  if (details.webSearch !== undefined) parts.push(`web_search=${details.webSearch}`);
  if (Number.isFinite(details.n)) parts.push(`n=${details.n}`);
  if (details.aspectRatio) parts.push(`aspect_ratio=${details.aspectRatio}`);
  console.log(parts.join(' '));
}

// multipart/form-data uploads — kept in memory, capped at 50 MB to match JSON limit
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 50 * 1024 * 1024;
// Image 2.0 supports up to 10 batch images and multi-reference editing → allow up to 11 files
// (1 primary "image" field + up to 10 "reference_images")
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 11 },
});

// Image 2.0 supports n=1..10 with character/object continuity within one chat
const MAX_BATCH_N = parseInt(process.env.MAX_BATCH_N, 10) || 10;

function clampN(n) {
  const parsed = parseInt(n, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_BATCH_N);
}

function normalizeQuality(q) {
  if (!q) return null;
  const s = String(q).toLowerCase().trim();
  if (['low', 'medium', 'high'].includes(s)) return s;
  return null;
}

// web_search is DEPRECATED (removed 2026-07-10): GPT-5.6 auto-searches the web whenever a
// question needs fresh data, so the forced toggle became redundant and the UI-automation
// for it was removed. The field (snake_case and camelCase) is still ACCEPTED and ignored —
// tolerant to older clients. `applied.web_search` is always false ("no forced search";
// the model may still browse on its own). Key removal from responses: next major cleanup.
function parseDeprecatedWebSearch(req, kind) {
  const requested = parseWebSearchRequested(req.body);
  if (requested) console.log(`[deprecated] ${kind}: web_search=true received — ignored (GPT-5.6 auto-search)`);
  return requested;
}

function thinkingRequested(mode) {
  return mode !== 'instant';
}

function normalizeAspectRatio(input, size) {
  if (input && /^\d+:\d+$/.test(String(input))) return String(input);
  // Fallback: derive from size string like "1536x1024"
  if (size && /^\d+x\d+$/.test(String(size))) {
    const [w, h] = String(size).split('x').map(Number);
    if (w && h) {
      const g = (a, b) => (b ? g(b, a % b) : a);
      const d = g(w, h);
      return `${w / d}:${h / d}`;
    }
  }
  return null;
}

// Token-usage counter (best-effort; ChatGPT web does not expose per-call billing)
let totalGenerationsByN = { 1: 0 };
function bumpBatchMetric(n) {
  totalGenerationsByN[n] = (totalGenerationsByN[n] || 0) + 1;
}

// --- Concurrency & rate-limit settings ---
// Image 2.0: ~10-25s/image (vs 60-120s for 1.5) → can hold larger queue without timeouts
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE, 10) || 5;
const RATE_LIMIT_COOLDOWN_MS = (parseInt(process.env.RATE_LIMIT_COOLDOWN_MINUTES, 10) || 30) * 60 * 1000;
const QUEUE_FULL_RETRY_AFTER = parseInt(process.env.QUEUE_FULL_RETRY_AFTER_SEC, 10) || 60;

// Queue for sequential processing (one browser = one request at a time)
let queue = Promise.resolve();
let queueSize = 0;
let rateLimitedUntil = 0; // timestamp when cooldown expires

// Proactive gap between upstream turns. RATE_LIMIT_COOLDOWN_MS above is the
// reactive half — it arms after ChatGPT refuses; this one keeps us from getting
// there. Details and the reasoning live in src/pacer.js.
//
// The heartbeat is what makes a deliberate pause legible to the liveness
// detector: a waiting job holds a queue slot, and without a touch the detector
// would read "queued work, no progress" and restart the container.
const pacer = createPacer({ heartbeat: () => progress.touch() });

// A cooldown armed while this job was already in line must still stop it.
// checkRateLimit() runs before enqueue() and nothing re-checked afterwards, so
// after ChatGPT refused, every job already accepted marched on with a 60s gap
// instead of the 30-minute cooldown — precisely the traffic the cooldown
// exists to stop. Found by codex.
function assertNotRateLimited() {
  const remainingMs = rateLimitedUntil - Date.now();
  if (remainingMs <= 0) return;
  const err = new Error(
    `ChatGPT rate limit is in effect for another ${Math.ceil(remainingMs / 1000)}s — not sending`,
  );
  err.code = 'rate_limit';
  // This refusal is ours, not ChatGPT's — see handleRateLimitError().
  err.armsCooldown = false;
  throw err;
}

// One upstream turn: refuse outright if a cooldown is already armed, otherwise
// wait out the gap, re-check (one may have been armed while we waited), then
// send — and stamp the finish whatever happened. The check runs on both sides
// of the wait on purpose: sitting out 60s only to refuse afterwards makes the
// caller pay for a send that was never going to happen. Found by agy.
async function upstreamTurn(send) {
  assertNotRateLimited();
  const waited = await pacer.gate();
  if (waited > 0) console.log(`[pacer] waited ${Math.round(waited / 1000)}s before an upstream turn`);
  assertNotRateLimited();
  try {
    return await send();
  } finally {
    pacer.finished();
  }
}

function enqueue(fn) {
  queueSize++;
  progress.jobStarted();
  // Exactly-once liveness accounting per job: success → streak reset; error → classified
  // kind feeds the consecutive-infra-failure detector (see src/progress.js).
  //
  // The pacing gate sits INSIDE the queue slot, after the previous job released
  // it: the job keeps its place in line while waiting, so callers see ordinary
  // queue backpressure and never a silent reordering. pacer.finished() runs in
  // finally, because a refused or timed-out request reached ChatGPT exactly as
  // a successful one did — pacing is about the account, not our success rate.
  // fn() paces its own upstream turns through upstreamTurn(), so enqueue does
  // NOT gate here: a job that sends nothing (or is abandoned before it sends)
  // should not burn a gap, and a job that sends ten times needs ten gaps, not
  // one. Everything the queue owes the liveness detector stays here, inside the
  // try — a gate that rejected outside it would have left the job counted as
  // started and never finished.
  const wrapped = async () => {
    try {
      const value = await fn();
      progress.jobFinished(null);
      return value;
    } catch (err) {
      progress.jobFinished(classifyError(err.message, err.code));
      throw err;
    }
  };
  const p = queue.then(wrapped, wrapped).finally(() => { queueSize--; });
  queue = p.catch(() => {});
  return p;
}

function elapsedSec(startedAt) {
  return Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : 0;
}

function checkRateLimit(res, startedAt) {
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const retryAfterSec = Math.ceil((rateLimitedUntil - now) / 1000);
    incError('rate_limit');
    observeDuration('rate_limit', elapsedSec(startedAt));
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json(buildErrorBody({
      kind: 'rate_limit',
      message: `ChatGPT image generation limit reached. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
      retryAfter: retryAfterSec,
    }));
    return true;
  }
  return false;
}

// How long a client turned away for a full queue should wait. The queued jobs
// themselves PLUS the pacing gap before each of them: quoting the bare
// QUEUE_FULL_RETRY_AFTER once pacing is on sends the client back too early, it
// gets 429 again, and every such probe is another request against the account
// this limit exists to protect. Found by agy.
//
// It is an ESTIMATE and cannot be better than one here: a queued batch owes a
// gap per image, not per job, and only the running job knows how many turns it
// has left. It errs low for batches and high for single turns; Math.ceil keeps
// it a whole number of seconds, which is all Retry-After may carry. Found by codex.
function queueFullRetryAfterSec(queued) {
  return Math.ceil(QUEUE_FULL_RETRY_AFTER + queued * pacer.status().min_gap_sec);
}

function checkQueueFull(res, startedAt) {
  if (queueSize >= MAX_QUEUE_SIZE) {
    const retryAfterSec = queueFullRetryAfterSec(queueSize);
    incQueueFull();
    observeDuration('queue_full', elapsedSec(startedAt));
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json(buildErrorBody({
      kind: 'queue_full',
      message: `Server busy: ${queueSize} requests in queue (max ${MAX_QUEUE_SIZE}). Try again in ~${Math.ceil(retryAfterSec / 60)} min.`,
      retryAfter: retryAfterSec,
    }));
    return true;
  }
  return false;
}

// Single source of truth for error responses: classifies err, increments counters,
// observes duration, and emits the structured error body with the right HTTP code.
function respondWithError(res, startedAt, err) {
  handleRateLimitError(err);
  const errorType = classifyError(err.message, err.code);
  incError(errorType);
  observeDuration(errorType, elapsedSec(startedAt));

  if (errorType === 'rate_limit') {
    const retryAfterSec = rateLimitedUntil > Date.now()
      ? Math.ceil((rateLimitedUntil - Date.now()) / 1000)
      : Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json(buildErrorBody({
      kind: 'rate_limit',
      message: err.message,
      modelMessage: err.modelMessage,
      retryAfter: retryAfterSec,
    }));
  }

  // 422 — input rejected by content policy / refused (semantically not a server bug)
  // 503 — transient browser/upload/session failure, retry recommended
  // 504 — generation took longer than configured budget
  // 500 — anything else
  const statusByKind = {
    refused: 422,
    policy_violation: 422,
    conversation_not_found: 404,
    login_failed: 503,
    upload_failed: 503,
    // Not 429: that is the global-cooldown path. One tier is out of quota, the service is fine.
    tier_limit: 503,
    page_load_failed: 503,
    timeout: 504,
    server_error: 500,
  };
  const status = statusByKind[errorType] || 500;
  return res.status(status).json(buildErrorBody({
    kind: errorType,
    message: err.message,
    modelMessage: err.modelMessage,
    loginBlocker: err.loginBlocker,
    loginStep: err.loginStep,
  }));
}

function parseResetTime(message) {
  const msg = message.toLowerCase();

  // "try again after 3:45 PM" / "после 15:45"
  const timeMatch = msg.match(/(?:after|после)\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3];
    if (ampm) {
      if (ampm.toLowerCase() === 'pm' && hours < 12) hours += 12;
      if (ampm.toLowerCase() === 'am' && hours === 12) hours = 0;
    }
    const now = new Date();
    const reset = new Date(now);
    reset.setHours(hours, minutes, 0, 0);
    if (reset <= now) reset.setDate(reset.getDate() + 1);
    return reset.getTime() - now.getTime();
  }

  // "in 2 hours" / "через 2 часа"
  const hoursMatch = msg.match(/(?:in|через)\s+(\d+)\s*(?:hour|час)/i);
  if (hoursMatch) return parseInt(hoursMatch[1], 10) * 60 * 60 * 1000;

  // "in 30 minutes" / "через 30 минут"
  const minsMatch = msg.match(/(?:in|через)\s+(\d+)\s*(?:minute|минут)/i);
  if (minsMatch) return parseInt(minsMatch[1], 10) * 60 * 1000;

  return null;
}

function handleRateLimitError(err) {
  // A refusal WE raised because a cooldown is already running never reached
  // ChatGPT, and its message says "rate limit" — which this function matches on.
  // Arming for it would push the deadline out by another full cooldown FROM NOW,
  // so a client that keeps retrying would hold its own service shut indefinitely,
  // logging a limit ChatGPT never sent each time. Found by codex.
  if (err.armsCooldown === false) return;
  if (err.message && err.message.includes('rate limit')) {
    const parsedMs = parseResetTime(err.message);
    const cooldownMs = parsedMs || RATE_LIMIT_COOLDOWN_MS;
    // Cap at 24 hours max to avoid 720h lockout blocking the API forever
    const cappedMs = Math.min(cooldownMs, 24 * 60 * 60 * 1000);
    rateLimitedUntil = Date.now() + cappedMs;
    const source = parsedMs ? 'parsed from ChatGPT' : `default ${RATE_LIMIT_COOLDOWN_MS / 60000}min`;
    const isMonthlyLock = cooldownMs > 24 * 60 * 60 * 1000;
    if (isMonthlyLock) {
      console.error(`[rate-limit] CRITICAL: ChatGPT monthly limit hit! Original cooldown: ${Math.ceil(cooldownMs / 3600000)}h. Capped to 24h. Manual intervention may be needed.`);
    } else {
      console.log(`[rate-limit] ChatGPT limit hit. Cooldown ${Math.ceil(cappedMs / 60000)}min (${source}). Until ${new Date(rateLimitedUntil).toISOString()}`);
    }
  }
}

function saveImage(b64, contentType, requestedFormat) {
  // Honor caller's preferred output_format if it matches what ChatGPT returned.
  // We do NOT transcode here (no native deps) — only file-extension override when safe.
  const fromCT = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const allowed = ['png', 'webp', 'jpg', 'jpeg'];
  const ext = requestedFormat && allowed.includes(String(requestedFormat).toLowerCase())
    ? (String(requestedFormat).toLowerCase() === 'jpeg' ? 'jpg' : String(requestedFormat).toLowerCase())
    : fromCT;
  // If requested format does not match ChatGPT output, keep ChatGPT's actual extension
  // to avoid lying about the file content
  const safeExt = (ext === fromCT || (ext === 'jpg' && fromCT === 'jpg')) ? ext : fromCT;
  const filename = `${randomUUID()}.${safeExt}`;
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(b64, 'base64'));
  return filename;
}

// Conditional middleware for /generations: supports both JSON and multipart
// (multipart needed when caller passes reference_images[] files)
function maybeMultipartGen(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.toLowerCase().includes('multipart/form-data')) {
    // Up to 10 reference_images for style/brand transfer
    return upload.array('reference_images', 10)(req, res, (err) => {
      if (err) {
        const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(code).json({
          error: { message: err.message, type: 'invalid_request_error' },
        });
      }
      next();
    });
  }
  next();
}

// JSON-array reference_images: hard caps to prevent DoS via huge arrays.
// multipart path is already capped by multer (files: 11, 50 MB each).
const MAX_JSON_REFERENCES = 10;
const MAX_JSON_REFERENCES_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB combined
const MAX_SINGLE_REFERENCE_BYTES = 50 * 1024 * 1024;     // 50 MB per item

// Length of base64 string for B bytes is ~4*ceil(B/3). To avoid OOM on Buffer.from,
// REJECT items whose b64 length already exceeds the per-item cap before decoding.
function decodeRefsFromJson(refsArray) {
  const limited = refsArray.slice(0, MAX_JSON_REFERENCES);
  const out = [];
  let totalBytes = 0;
  for (const ref of limited) {
    if (typeof ref !== 'string') continue;
    const m = ref.match(/^data:(image\/[\w+]+);base64,(.+)$/);
    if (!m) continue;
    const b64 = m[2];
    // Cheap pre-check: estimate decoded size from b64 length, refuse if > per-item cap.
    // This avoids allocating Buffer for malicious payloads (Bug #5 from Gemini review).
    const estBytes = Math.floor(b64.length * 0.75);
    if (estBytes > MAX_SINGLE_REFERENCE_BYTES) {
      console.warn(`[refs] item ~${(estBytes / 1e6).toFixed(1)} MB exceeds per-item cap, skipping`);
      continue;
    }
    if (totalBytes + estBytes > MAX_JSON_REFERENCES_TOTAL_BYTES) {
      console.warn(`[refs] would exceed total cap ${MAX_JSON_REFERENCES_TOTAL_BYTES / 1e6} MB, truncating`);
      break;
    }
    const buf = Buffer.from(b64, 'base64');
    totalBytes += buf.length;
    out.push({
      buffer: buf,
      mimeType: m[1],
      filename: `reference.${m[1].split('/')[1] || 'png'}`,
    });
  }
  return out;
}

function extractReferenceImages(req) {
  // multipart files (multer already capped)
  if (Array.isArray(req.files) && req.files.length > 0) {
    return req.files.map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype || 'image/png',
      filename: f.originalname || 'reference.png',
    }));
  }
  const refs = req.body && req.body.reference_images;
  if (Array.isArray(refs)) return decodeRefsFromJson(refs);
  return [];
}

// POST /v1/images/generations — OpenAI-compatible endpoint
// Image 2.0 additions: n up to 10, thinking, aspect_ratio, reference_images, (web_search deprecated/ignored)
// output_format, quality, conversation_id (ack only — wrapper passes prompt-only conversation context).
router.post('/v1/images/generations', maybeMultipartGen, async (req, res) => {
  const {
    prompt,
    response_format = 'url',
    output_format,
    size,
  } = req.body;

  const n = clampN(req.body.n);
  const webSearch = parseDeprecatedWebSearch(req, 'generations');
  const thinkingMode = parseThinkingMode(req.body);
  const aspectRatio = normalizeAspectRatio(req.body.aspect_ratio, size);
  const quality = normalizeQuality(req.body.quality);
  const references = extractReferenceImages(req);
  const conversationId = req.body.conversation_id || null;
  const startedAt = Date.now();

  incRequests();

  if (!prompt) {
    return res.status(400).json({
      ok: false,
      error_kind: 'invalid_request',
      should_retry: false,
      model_message: null,
      error: { message: 'prompt is required', type: 'invalid_request_error' },
    });
  }

  logRequestDetails(req, 'generations', {
    prompt, promptLen: prompt.length, hasImage: false, references: references.length,
    thinkingMode, webSearch, n, aspectRatio,
  });

  if (checkRateLimit(res, startedAt)) return;
  if (checkQueueFull(res, startedAt)) return;

  const host = `${req.protocol}://${req.get('host')}`;
  const requestGroupId = randomUUID();

  try {
    // Run the whole batch as a single queued job so all n images share the same chat
    // → maximum character/object consistency between them.
    // Track applied state from FIRST turn (refs are attached only on turn 1; later turns
    // legitimately have references=[] but they STILL benefit from refs in chat history).
    // Reporting last-turn's references_attached=0 was lying (Codex+Cursor+Opus review).
    let firstApplied = null;
    // Per-turn tier state. Only the FIRST turn's `applied` is kept for references, but the
    // tier can change mid-batch: if Pro runs out on image 3, images 1-2 really were Pro and
    // 3+ really were Extra High. Reporting the first turn for all of them would claim a
    // confirmed Pro batch that never happened (Codex review).
    const turnTiers = [];
    let maxAbVariants = 0;
    let abSelectedIndex = null;
    const errors = [];
    const results = await enqueue(async () => {
      const out = [];
      for (let i = 0; i < n; i++) {
        try {
          const result = await upstreamTurn(() => generateImage(prompt, {
            thinkingMode,
            aspectRatio,
            quality,
            references: i === 0 ? references : [],
            reuseChat: i > 0,
          }));
          progress.touch(); // per-image heartbeat — long legit batches must not look stuck
          if (i === 0 && result.applied) firstApplied = result.applied;
          if (result.applied) turnTiers.push(result.applied);
          if (result.applied && result.applied.ab_variants > maxAbVariants) {
            maxAbVariants = result.applied.ab_variants;
            abSelectedIndex = result.applied.ab_selected_index || null;
          }

          const item = {};
          if (response_format === 'b64_json') {
            item.b64_json = result.b64_json;
          } else if (result.b64_json) {
            const filename = saveImage(result.b64_json, result.contentType, output_format);
            item.url = `${host}/images/${filename}`;
          } else {
            item.url = result.url;
          }
          out.push(item);
        } catch (turnErr) {
          // Bug #4 (Opus): partial batch failure used to throw out of enqueue and lose
          // every already-saved image (disk leak + lost results). Now we record the
          // error per-turn and continue, returning `partial: true` if some succeeded.
          console.error(`[batch ${i + 1}/${n}] failed:`, turnErr.message);
          // A rate limit on turn 2+ used to be swallowed as a partial batch:
          // respondWithError() never ran, so the cooldown never armed and the
          // next request walked straight back into the same wall. Found by codex.
          handleRateLimitError(turnErr);
          errors.push({ index: i, message: turnErr.message, kind: classifyError(turnErr.message, turnErr.code) });
          // If the FIRST turn fails, abort entirely — same chat is unusable
          if (i === 0) throw turnErr;
          // Otherwise stop the loop but keep what we have
          break;
        }
      }
      return out;
    });

    incGenerations();
    bumpBatchMetric(n);
    observeDuration('success', elapsedSec(startedAt));
    const applied = firstApplied || { thinking: false, thinking_mode: 'instant', references_attached: 0 };
    const batchTiers = summarizeBatchTiers(turnTiers);
    const partial = results.length < n;
    // Partial batch resolved as a successful job (streak was reset) — re-count an infra
    // tail failure so repeated degraded partials still trip /health/live eventually.
    if (partial) {
      const infraKind = errors.map((e) => e.kind).find(Boolean);
      if (infraKind) progress.recordInfraFailure(infraKind);
    } else {
      progress.clearPartialInfra();
    }
    res.json({
      ok: true,
      created: Math.floor(Date.now() / 1000),
      data: results,
      applied: {
        n: results.length,
        n_requested: n,
        thinking: applied.thinking,
        thinking_mode: applied.thinking_mode || (applied.thinking ? thinkingMode : 'instant'),
        // Batch-wide, not first-turn: every image must have confirmed the tier for the batch
        // to claim it, and a downgrade on ANY image is reported.
        thinking_verified: batchTiers.thinking_verified,
        requested_verified: batchTiers.requested_verified,
        thinking_fallback: batchTiers.thinking_fallback,
        // True when the turns did not all run on the same tier (Pro ran out mid-batch), so
        // `thinking_mode` above describes the first image only.
        thinking_mode_mixed: batchTiers.mixed,
        web_search: false, // deprecated — forced search removed, model auto-searches
        aspect_ratio: aspectRatio,
        quality,
        references_attached: applied.references_attached,
        ab_variants: maxAbVariants,
        ab_selected_index: abSelectedIndex,
        request_group_id: requestGroupId,
        conversation_id: conversationId,
      },
      requested: { thinking: thinkingRequested(thinkingMode), thinking_mode: thinkingMode, web_search: webSearch },
      ...(partial && { partial: true, errors }),
    });
  } catch (err) {
    console.error('Image generation error:', err.message);
    respondWithError(res, startedAt, err);
  }
});

// Conditional middleware for /edits: primary "image" + optional "reference_images[]"
function maybeMultipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.toLowerCase().includes('multipart/form-data')) {
    return upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'reference_images', maxCount: 10 },
    ])(req, res, (err) => {
      if (err) {
        const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(code).json({
          error: { message: err.message, type: 'invalid_request_error' },
        });
      }
      next();
    });
  }
  next();
}

// Coerce request into { prompt, imageInput, references } regardless of transport.
function extractEditPayload(req) {
  // multipart path: req.files["image"][0], req.files["reference_images"]
  const filesObj = req.files || {};
  const primaryFile = (filesObj.image && filesObj.image[0]) || null;
  const refFiles = filesObj.reference_images || [];

  if (primaryFile) {
    const refs = refFiles.map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype || 'image/png',
      filename: f.originalname || 'reference.png',
    }));
    return {
      prompt: req.body.prompt,
      response_format: req.body.response_format || 'url',
      imageInput: {
        buffer: primaryFile.buffer,
        mimeType: primaryFile.mimetype || 'image/png',
        filename: primaryFile.originalname || `upload.${(primaryFile.mimetype || 'image/png').split('/')[1] || 'png'}`,
      },
      references: refs,
    };
  }
  // Legacy JSON path: data URL string for primary, array for references.
  // Reuses decodeRefsFromJson() so the same caps (count + total + per-item) apply.
  const { prompt, image, response_format = 'url', reference_images } = req.body;
  if (!image) return { prompt, response_format, imageInput: null, references: [] };
  // Opus review fix: `image` may be non-string (null after JSON.parse, number, object)
  // → `image.match` throws TypeError → 500. Reject early.
  if (typeof image !== 'string') {
    return { prompt, response_format, imageInput: null, references: [], _error: 'image must be a data URL string' };
  }
  const m = image.match(/^data:(image\/[\w+]+);base64,(.+)$/);
  if (!m) return { prompt, response_format, imageInput: null, references: [] };
  // Apply the per-item cap to the primary image too
  const primaryB64 = m[2];
  if (Math.floor(primaryB64.length * 0.75) > MAX_SINGLE_REFERENCE_BYTES) {
    return { prompt, response_format, imageInput: null, references: [], _error: 'primary image too large' };
  }
  const mimeType = m[1];
  const ext = mimeType.split('/')[1] || 'png';
  const refs = Array.isArray(reference_images) ? decodeRefsFromJson(reference_images) : [];
  return {
    prompt,
    response_format,
    imageInput: {
      buffer: Buffer.from(primaryB64, 'base64'),
      mimeType,
      filename: `upload.${ext}`,
    },
    references: refs,
  };
}

// POST /v1/images/edits — edit image with prompt
// Image 2.0 additions: reference_images[] for multi-reference editing,
// thinking, aspect_ratio (web_search deprecated/ignored)
router.post('/v1/images/edits', maybeMultipart, async (req, res) => {
  const payload = extractEditPayload(req);
  const { prompt, response_format, imageInput, references } = payload;
  if (payload._error) {
    return res.status(413).json({
      error: { message: payload._error, type: 'invalid_request_error' },
    });
  }

  const webSearch = parseDeprecatedWebSearch(req, 'edits');
  const thinkingMode = parseThinkingMode(req.body);
  const aspectRatio = normalizeAspectRatio(req.body.aspect_ratio, req.body.size);
  const quality = normalizeQuality(req.body.quality);
  const outputFormat = req.body.output_format;
  const startedAt = Date.now();

  incRequests();

  if (!prompt || !imageInput) {
    return res.status(400).json({
      ok: false,
      error_kind: 'invalid_request',
      should_retry: false,
      model_message: null,
      error: {
        message: 'prompt and image are required (send multipart/form-data with file field "image", or JSON with base64 data URL)',
        type: 'invalid_request_error',
      },
    });
  }

  logRequestDetails(req, 'edits', {
    prompt, promptLen: prompt.length, hasImage: !!imageInput, references: references.length,
    thinkingMode, webSearch, aspectRatio,
  });

  if (checkRateLimit(res, startedAt)) return;
  if (checkQueueFull(res, startedAt)) return;

  const host = `${req.protocol}://${req.get('host')}`;

  try {
    const result = await enqueue(() => upstreamTurn(() => editImage(prompt, imageInput, {
      thinkingMode,
      aspectRatio,
      quality,
      references,
    })));

    let data;
    if (response_format === 'b64_json') {
      data = { b64_json: result.b64_json };
    } else if (result.b64_json) {
      const filename = saveImage(result.b64_json, result.contentType, outputFormat);
      data = { url: `${host}/images/${filename}` };
    } else {
      data = { url: result.url };
    }

    const applied = result.applied || { thinking: false, thinking_mode: 'instant', references_attached: references.length };
    progress.clearPartialInfra(); // any full success proves the session alive
    incEdits();
    observeDuration('success', elapsedSec(startedAt));
    res.json({
      ok: true,
      created: Math.floor(Date.now() / 1000),
      data: [data],
      applied: {
        thinking: applied.thinking,
        thinking_mode: applied.thinking_mode || (applied.thinking ? thinkingMode : 'instant'),
        thinking_verified: applied.thinking_verified ?? false,
        // Did we get the tier the caller ASKED for? `thinking_verified` refers to
        // `thinking_mode`, which after a downgrade is the fallback tier — reading it as
        // "Pro confirmed" would be wrong.
        requested_verified: applied.requested_verified ?? false,
        // Non-null when the REQUESTED tier was not the one applied (e.g. Pro out of quota →
        // Extra High). `requested.thinking_mode` still shows what the caller asked for.
        thinking_fallback: applied.thinking_fallback ?? null,
        web_search: false, // deprecated — forced search removed, model auto-searches
        aspect_ratio: aspectRatio,
        quality,
        references_attached: applied.references_attached,
        ab_variants: applied.ab_variants || 0,
        ab_selected_index: applied.ab_selected_index || null,
      },
      requested: { thinking: thinkingRequested(thinkingMode), thinking_mode: thinkingMode, web_search: webSearch },
    });
  } catch (err) {
    console.error('Image edit error:', err.message);
    respondWithError(res, startedAt, err);
  }
});

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'text' && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function promptFromMessages(messages, fallbackInput) {
  if (typeof fallbackInput === 'string') return fallbackInput;
  if (Array.isArray(fallbackInput)) return promptFromMessages(fallbackInput);
  if (!Array.isArray(messages) || messages.length === 0) return '';

  return messages
    .map((msg) => {
      const role = msg && msg.role ? String(msg.role) : 'user';
      const text = normalizeMessageContent(msg && msg.content).trim();
      if (!text) return '';
      if (role === 'system') return `System instructions:\n${text}`;
      if (role === 'assistant') return `Previous assistant message:\n${text}`;
      return `User:\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

async function handleTextCompletion(req, res, prompt) {
  const webSearch = parseDeprecatedWebSearch(req, 'chat');
  const thinkingMode = parseThinkingMode(req.body);
  const startedAt = Date.now();

  incRequests();

  if (!prompt) {
    return res.status(400).json({
      ok: false,
      error_kind: 'invalid_request',
      should_retry: false,
      model_message: null,
      error: { message: 'messages or input is required', type: 'invalid_request_error' },
    });
  }

  // Multi-turn: optional conversation_id continues an existing ChatGPT conversation
  // (the id lives inside the logged-in account — ids from other accounts won't open).
  // Strict UUID validation: the id is interpolated into a chatgpt.com URL.
  const conversationId = req.body.conversation_id ?? null;
  if (conversationId !== null && !isValidConversationId(conversationId)) {
    return res.status(400).json({
      ok: false,
      error_kind: 'invalid_request',
      should_retry: false,
      model_message: null,
      error: {
        message: 'conversation_id must be a UUID (as returned in a previous response), e.g. "1f0e4b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b"',
        type: 'invalid_request_error',
      },
    });
  }

  // SSE streaming (stream:true): OpenAI-compatible chat.completion.chunk
  // events. Requires the server to intercept backend-api deltas — with pure DOM
  // scraping there is no reliable incremental source, so reject honestly instead of
  // faking a stream.
  const stream = parseBool(req.body.stream);
  if (stream && !READ_VIA_BACKEND_API) {
    return res.status(400).json({
      ok: false,
      error_kind: 'invalid_request',
      should_retry: false,
      model_message: null,
      error: {
        message: 'stream:true requires backend-api interception (the streaming delta '
          + 'source), but this server was started with READ_VIA_BACKEND_API=0. '
          + 'Re-enable it (the default) or omit "stream".',
        type: 'invalid_request_error',
      },
    });
  }

  logRequestDetails(req, 'text', {
    prompt, promptLen: prompt.length, hasImage: false, thinkingMode, webSearch,
  });

  if (checkRateLimit(res, startedAt)) return;
  if (checkQueueFull(res, startedAt)) return;

  if (stream) {
    return streamTextCompletion(res, prompt, { thinkingMode, webSearch, conversationId, startedAt });
  }

  try {
    const result = await enqueue(() => upstreamTurn(() => completeText(prompt, {
      thinkingMode,
      conversationId,
    })));

    const applied = result.applied || { thinking: false, thinking_mode: 'instant' };
    progress.clearPartialInfra(); // any full success proves the session alive
    observeDuration('success', elapsedSec(startedAt));
    res.json({
      ok: true,
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'chatgpt-web',
      conversation_id: result.conversation_id || null,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: 'stop',
        },
      ],
      ...textEcho(applied, thinkingMode, webSearch),
    });
  } catch (err) {
    console.error('Text completion error:', err.message);
    respondWithError(res, startedAt, err);
  }
}

// Collapse the per-image tier states of a batch into one honest summary. A batch counts as
// verified only if every turn was, as requested_verified only if every turn got the tier the
// caller asked for, and it surfaces the first downgrade plus whether the turns disagreed.
function summarizeBatchTiers(turns) {
  if (!turns.length) {
    return { thinking_verified: false, requested_verified: false, thinking_fallback: null, mixed: false };
  }
  const modes = new Set(turns.map((t) => t.thinking_mode || 'instant'));
  return {
    thinking_verified: turns.every((t) => t.thinking_verified === true),
    requested_verified: turns.every((t) => t.requested_verified === true),
    thinking_fallback: turns.map((t) => t.thinking_fallback).find(Boolean) || null,
    mixed: modes.size > 1,
  };
}

// The `applied`/`requested` echo for a text turn. Shared by the JSON and the SSE legs so a
// streaming client is not told less than a blocking one — the tier that actually ran is the
// same fact either way, and it now differs from the request whenever Pro is out of quota.
function textEcho(applied, thinkingMode, webSearch) {
  return {
    applied: {
      thinking: applied.thinking,
      thinking_mode: applied.thinking_mode || (applied.thinking ? thinkingMode : 'instant'),
      thinking_verified: applied.thinking_verified ?? false,
      // Did we get the tier the caller ASKED for? `thinking_verified` refers to
      // `thinking_mode`, which after a downgrade is the fallback tier — reading it as
      // "Pro confirmed" would be wrong.
      requested_verified: applied.requested_verified ?? false,
      // Non-null when the REQUESTED tier was not the one applied (e.g. Pro out of quota →
      // Extra High). `requested.thinking_mode` still shows what the caller asked for.
      thinking_fallback: applied.thinking_fallback ?? null,
      web_search: false, // deprecated — forced search removed, model auto-searches
    },
    requested: {
      thinking: thinkingRequested(thinkingMode),
      thinking_mode: thinkingMode,
      web_search: webSearch,
    },
  };
}

// SSE streaming leg of a text completion. Headers are sent lazily on the first delta
// (or at completion), so queue-full / rate-limit / pre-flight errors above still go
// out as plain JSON. Once the stream started, errors become an SSE error event.
async function streamTextCompletion(res, prompt, { thinkingMode, webSearch, conversationId, startedAt }) {
  const meta = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: 'chatgpt-web' };
  const emitter = createStreamEmitter(meta);
  let streamingStarted = false;

  const ensureStreamStarted = () => {
    if (streamingStarted || res.writableEnded) return;
    streamingStarted = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: do not buffer SSE
    res.flushHeaders();
    const role = emitter.start();
    if (role) res.write(role);
  };

  try {
    const result = await enqueue(() => upstreamTurn(() => completeText(prompt, {
      thinkingMode,
      conversationId,
      // Called with the latest FULL text; the emitter turns it into append-only deltas.
      onDelta: (fullText) => {
        try {
          ensureStreamStarted();
          for (const chunk of emitter.push(fullText)) res.write(chunk);
        } catch {}
      },
    })));

    ensureStreamStarted();
    for (const chunk of emitter.finish(result.text, {
      conversation_id: result.conversation_id || null,
      ...textEcho(result.applied || { thinking: false, thinking_mode: 'instant' }, thinkingMode, webSearch),
    })) {
      res.write(chunk);
    }
    res.end();
    progress.clearPartialInfra();
    observeDuration('success', elapsedSec(startedAt));
  } catch (err) {
    console.error('Streaming completion error:', err.message);
    if (!streamingStarted) return respondWithError(res, startedAt, err);
    // Headers are gone — emit an OpenAI-style terminal error event instead.
    handleRateLimitError(err);
    const errorType = classifyError(err.message, err.code);
    incError(errorType);
    observeDuration(errorType, elapsedSec(startedAt));
    res.write(`data: ${JSON.stringify({
      error: { message: err.message, type: errorType },
      error_kind: errorType,
      should_retry: shouldRetryKind(errorType),
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// POST /v1/chat/completions — text chat through ChatGPT Web.
// `model` is accepted but ignored: callers choose only thinking_mode.
router.post('/v1/chat/completions', async (req, res) => {
  const prompt = promptFromMessages(req.body.messages, req.body.input);
  await handleTextCompletion(req, res, prompt);
});

// POST /v1/responses — minimal Responses-style text endpoint without model versions.
router.post('/v1/responses', async (req, res) => {
  if (parseBool(req.body.stream)) {
    return res.status(400).json({
      ok: false,
      error_kind: 'invalid_request',
      should_retry: false,
      model_message: null,
      error: {
        message: 'stream is not supported on /v1/responses — use /v1/chat/completions with stream:true',
        type: 'invalid_request_error',
      },
    });
  }
  const prompt = promptFromMessages(req.body.messages, req.body.input);
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (payload && payload.choices && payload.choices[0]) {
      const text = payload.choices[0].message.content;
      return originalJson({
        ok: payload.ok !== undefined ? payload.ok : true,
        id: payload.id.replace('chatcmpl-', 'resp-'),
        object: 'response',
        created_at: payload.created,
        model: 'chatgpt-web',
        conversation_id: payload.conversation_id ?? null,
        output_text: text,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        ],
        applied: payload.applied,
        requested: payload.requested,
      });
    }
    return originalJson(payload);
  };
  await handleTextCompletion(req, res, prompt);
});

// GET /v1/images/status
router.get('/v1/images/status', (req, res) => {
  const now = Date.now();
  const rateLimited = rateLimitedUntil > now;
  res.json({
    status: rateLimited ? 'rate_limited' : 'ok',
    queue_size: queueSize,
    max_queue_size: MAX_QUEUE_SIZE,
    // An invisible limit reads as a broken service: without this the caller
    // only sees response times growing and concludes the gateway is wedged.
    pacing: pacer.status(),
    max_batch_n: MAX_BATCH_N,
    batch_metric: totalGenerationsByN,
    ...(rateLimited && {
      rate_limited_until: new Date(rateLimitedUntil).toISOString(),
      retry_after_seconds: Math.ceil((rateLimitedUntil - now) / 1000),
    }),
  });
});

// GET /v1/images/capabilities — probe which Image 2.0 toggles are visible right now.
// Cached 60s + single-flight. probe is a read-only page.evaluate (no clicks),
// so it does NOT need to share the generation queue — using enqueue() would deadlock
// /capabilities behind a 3-min batch (Opus review #3).
const CAPABILITIES_CACHE_TTL_MS = parseInt(process.env.CAPABILITIES_CACHE_TTL_MS, 10) || 60 * 1000;
let capsCache = { at: 0, value: null };
let capsInFlight = null;

async function getCapabilitiesSingleflight() {
  const now = Date.now();
  // Serve fresh cache
  if (capsCache.value && now - capsCache.at < CAPABILITIES_CACHE_TTL_MS) {
    return { value: capsCache.value, cached: true };
  }
  // If queue is busy, serve stale cache instead of probing the live page
  // (avoids racing with active generation and avoids long client waits).
  if (queueSize > 0 && capsCache.value) {
    return { value: capsCache.value, cached: true, stale: true };
  }
  if (capsInFlight) return await capsInFlight;
  capsInFlight = (async () => {
    try {
      const caps = await probeCapabilities();
      const payload = {
        model: 'gpt-image-2-via-chatgpt-web',
        supported: {
          n_max: MAX_BATCH_N,
          thinking: caps.thinking || caps.thinking_mode,
          thinking_mode: caps.thinking_mode || caps.thinking,
          web_search: caps.web_search,
          reference_images: caps.reference_images,
          aspect_ratio: true,
          output_format: ['png', 'webp', 'jpg'],
          quality: ['low', 'medium', 'high'],
        },
        probe_error: caps.error || null,
      };
      // Bug #5 (Opus): don't poison the cache with probe errors. If we couldn't
      // log in or page is broken, the toggles will all read `false` and stick
      // for 60s even after auto-login fixes things. Skip caching on error.
      if (!caps.error) {
        capsCache = { at: Date.now(), value: payload };
      }
      return { value: payload, cached: false };
    } finally {
      capsInFlight = null;
    }
  })();
  return await capsInFlight;
}

router.get('/v1/images/capabilities', async (req, res) => {
  try {
    const result = await getCapabilitiesSingleflight();
    res.json({ ...result.value, cached: result.cached, stale: result.stale || false });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
});

module.exports = router;

// Test-only surface for scripts/test-cooldown.js. The cooldown deadline and the
// queue-full estimate are module state, and the pacing release shipped a defect
// in exactly that state (a local refusal re-arming the cooldown) which unit tests
// on pacer.js alone could not see. Nothing in the service reads this.
module.exports._internals = {
  assertNotRateLimited,
  handleRateLimitError,
  queueFullRetryAfterSec,
  getRateLimitedUntil: () => rateLimitedUntil,
  setRateLimitedUntil: (value) => { rateLimitedUntil = value; },
};
