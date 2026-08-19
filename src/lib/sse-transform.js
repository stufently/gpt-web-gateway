// Pure OpenAI-compatible SSE chunk formatting — no Express, no Playwright.
//
// The gateway observes the assistant answer as a GROWING FULL TEXT (backend-api
// deltas accumulated, or the DOM fallback re-read every poll). OpenAI streaming
// clients expect incremental `chat.completion.chunk` events:
//   data: {"choices":[{"delta":{"role":"assistant"}, ...}]}
//   data: {"choices":[{"delta":{"content":"Hel"}, ...}]}
//   ...
//   data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
//   data: [DONE]
// createStreamEmitter() bridges the two: push(fullText) diffs against what has
// already been sent and returns the wire-ready chunk strings.

const DONE_EVENT = 'data: [DONE]\n\n';

function formatSseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunkEnvelope({ id, created, model }, delta, finishReason = null, extra = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    ...(extra || {}),
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function formatRoleChunk(meta) {
  return formatSseData(chunkEnvelope(meta, { role: 'assistant' }));
}

function formatContentChunk(meta, content) {
  return formatSseData(chunkEnvelope(meta, { content }));
}

function formatFinishChunk(meta, finishReason = 'stop', extra = null) {
  return formatSseData(chunkEnvelope(meta, {}, finishReason, extra));
}

// Incremental suffix between what was already sent and the latest full text.
// Non-append changes (DOM re-render shrank or rewrote the text) yield '' — we can
// never retract streamed bytes, so we wait until the text grows past `sent` again.
function computeDelta(sent, next) {
  if (typeof next !== 'string' || !next) return '';
  if (!sent) return next;
  if (next === sent) return '';
  if (next.startsWith(sent)) return next.slice(sent.length);
  return '';
}

/**
 * Stateful emitter for one streamed completion.
 * @param {{id: string, created: number, model: string}} meta
 */
function createStreamEmitter(meta) {
  let sent = '';
  let started = false;
  return {
    /** First chunk: the assistant role announcement. Idempotent. */
    start() {
      if (started) return '';
      started = true;
      return formatRoleChunk(meta);
    },
    /** Latest observed FULL text → array of chunk strings to write (possibly empty). */
    push(fullText) {
      const delta = computeDelta(sent, fullText);
      if (!delta) return [];
      sent += delta;
      return [formatContentChunk(meta, delta)];
    },
    /**
     * Final text (authoritative) → remaining content chunk (if the final text extends
     * what was streamed), then the finish chunk and [DONE]. When the final text
     * CONTRADICTS what was streamed (non-append), nothing can be retracted — the
     * streamed prefix stays, and only finish/[DONE] are emitted.
     * @param {string} finalText
     * @param {object} [extra] merged into the finish chunk (e.g. conversation_id)
     */
    finish(finalText, extra = null) {
      const out = [];
      const delta = computeDelta(sent, finalText);
      if (delta) {
        sent += delta;
        out.push(formatContentChunk(meta, delta));
      } else if (!sent && typeof finalText === 'string' && finalText) {
        // Defensive: computeDelta with empty `sent` always returns finalText, so this
        // branch is unreachable — kept as documentation of the invariant.
        sent = finalText;
        out.push(formatContentChunk(meta, finalText));
      }
      out.push(formatFinishChunk(meta, 'stop', extra));
      out.push(DONE_EVENT);
      return out;
    },
    /** What has been streamed so far (for tests/logging). */
    sentText() {
      return sent;
    },
  };
}

module.exports = {
  DONE_EVENT,
  formatSseData,
  formatRoleChunk,
  formatContentChunk,
  formatFinishChunk,
  computeDelta,
  createStreamEmitter,
};
