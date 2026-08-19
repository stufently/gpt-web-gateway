// Pure parsing of ChatGPT backend-api conversation payloads — no Playwright, no DOM.
//
// ChatGPT's web app talks to https://chatgpt.com/backend-api/*:
//   - GET  /backend-api/conversation/{id}  → full conversation tree: `mapping`
//     (id → node with parent/children/message) plus `current_node`.
//   - POST /backend-api/conversation (and /backend-api/f/conversation) → SSE stream
//     of the assistant answer. Two wire formats exist:
//       * legacy: every `data:` event is a full message object (parts hold the whole
//         text so far — replace semantics), terminated by `data: [DONE]`;
//       * delta (2024+): `{p, o, v}` JSON-patch-like events — an `add` carries the
//         initial message, bare `{"v":"..."}` / `{"o":"append"}` events append text,
//         `{"o":"patch"}` bundles several operations, and
//         `{"type":"message_stream_complete"}` closes the turn.
//
// Reading the answer from these payloads is far more robust than scraping innerText
// out of a redesign-prone DOM. This module turns either payload shape into a simple
//   { conversationId, lastAssistantText, isComplete }
// snapshot. Integration (interception, feeding chunks) lives in src/chatgpt.js.

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ChatGPT conversation ids are UUIDs. Anything else is rejected — the id is later
// interpolated into a chatgpt.com URL, so this doubles as injection protection.
function isValidConversationId(id) {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id);
}

function messageText(message) {
  const c = message && message.content;
  if (!c) return '';
  if (Array.isArray(c.parts)) {
    return c.parts
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof c.text === 'string') return c.text;
  return '';
}

// Is this message the user-facing final answer? Assistant text addressed to "all" on
// the "final" channel. Tool calls use content_type "code"/plugin recipients; reasoning
// uses "thoughts"/"reasoning_recap" — all excluded.
function isFinalAssistantMessage(message) {
  if (!message) return false;
  const role = message.author && message.author.role;
  if (role !== 'assistant') return false;
  if (message.recipient && message.recipient !== 'all') return false;
  const ct = message.content && message.content.content_type;
  if (ct !== 'text') return false;
  if (message.channel && message.channel !== 'final') return false;
  return true;
}

function isMessageComplete(message) {
  if (!message) return false;
  const meta = message.metadata || {};
  return message.status === 'finished_successfully' || message.end_turn === true || meta.is_complete === true;
}

// GET /backend-api/conversation/{id} payload → snapshot of the latest final assistant
// answer on the ACTIVE branch (walk parents from current_node; side branches ignored).
function extractAssistantFromMapping(data) {
  if (!data || typeof data !== 'object') return null;
  const mapping = data.mapping;
  if (!mapping || typeof mapping !== 'object' || !data.current_node) return null;

  const seen = new Set();
  let id = data.current_node;
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id];
    const message = node && node.message;
    if (isFinalAssistantMessage(message)) {
      const text = messageText(message).trim();
      if (text) {
        return {
          conversationId: data.conversation_id || null,
          lastAssistantText: text,
          isComplete: isMessageComplete(message),
        };
      }
    }
    id = node.parent;
  }
  return { conversationId: data.conversation_id || null, lastAssistantText: '', isComplete: false };
}

// Incremental SSE accumulator. feed() raw chunk text as it arrives (chunks may split
// lines/events arbitrarily); snapshot() at any time.
class SseAccumulator {
  constructor() {
    this.conversationId = null;
    this.text = '';
    this.complete = false;
    this._lineBuffer = '';
    this._dataLines = [];
    // Whether the current append target is a final assistant message. Bare append
    // events carry no addressing — they apply to the last added message, so we must
    // ignore them while a non-final message (thoughts, tool output) is streaming.
    this._tracking = false;
  }

  feed(chunk) {
    if (typeof chunk !== 'string' || !chunk) return;
    this._lineBuffer += chunk;
    let idx;
    while ((idx = this._lineBuffer.indexOf('\n')) !== -1) {
      const line = this._lineBuffer.slice(0, idx).replace(/\r$/, '');
      this._lineBuffer = this._lineBuffer.slice(idx + 1);
      this._handleLine(line);
    }
  }

  // Flush any trailing event that was not terminated by a blank line (stream cut off).
  end() {
    if (this._lineBuffer) {
      this._handleLine(this._lineBuffer.replace(/\r$/, ''));
      this._lineBuffer = '';
    }
    this._flushEvent();
  }

  snapshot() {
    return {
      conversationId: this.conversationId,
      lastAssistantText: this.text.trim(),
      isComplete: this.complete,
    };
  }

  // Adopt a snapshot parsed from another source (e.g. the full response body once the
  // stream finished) when it is strictly better than what incremental feeding got.
  merge(snap) {
    if (!snap || !snap.lastAssistantText) return;
    const better = snap.lastAssistantText.length > this.text.trim().length
      || (snap.isComplete && !this.complete);
    if (!better) return;
    if (snap.lastAssistantText.length >= this.text.trim().length) this.text = snap.lastAssistantText;
    if (snap.isComplete) this.complete = true;
    if (snap.conversationId) this.conversationId = snap.conversationId;
  }

  _handleLine(line) {
    if (line === '') return this._flushEvent();
    if (line.startsWith('data:')) this._dataLines.push(line.slice(5).replace(/^ /, ''));
    // `event:`/`id:`/comment lines are irrelevant for us.
  }

  _flushEvent() {
    if (!this._dataLines.length) return;
    const payload = this._dataLines.join('\n');
    this._dataLines = [];
    if (payload === '[DONE]') {
      this.complete = true;
      return;
    }
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return; // partial/garbled event — ignore
    }
    this.handleEventObject(obj);
  }

  // One decoded SSE event (or a synthetic one). Public so callers holding an already
  // parsed object can push it through the same logic.
  handleEventObject(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.type === 'message_stream_complete') {
      this.complete = true;
      if (obj.conversation_id) this.conversationId = obj.conversation_id;
      return;
    }

    // Legacy format: full message object per event (replace semantics).
    if (obj.message && typeof obj.message === 'object') {
      this._handleMessage(obj.message, obj.conversation_id);
      return;
    }

    // Delta format.
    const { p, o, v } = obj;
    if ((o === 'add' || o === undefined) && v && typeof v === 'object' && !Array.isArray(v) && v.message) {
      this._handleMessage(v.message, v.conversation_id);
      return;
    }
    // Patch list: explicit `o:"patch"` or a bare array `v` (ChatGPT omits the
    // operation on some batched-delta events — an array value implies a patch list).
    if (Array.isArray(v) && (o === 'patch' || o === undefined)) {
      for (const entry of v) this._handlePatchEntry(entry);
      return;
    }
    if (typeof v === 'string' && (o === 'append' || o === undefined)) {
      // Bare string append (p omitted = same target as the previous append).
      if (p === undefined || /^\/message\/content\/parts\/\d+$/.test(p)) {
        if (this._tracking) this.text += v;
      }
    }
  }

  _handlePatchEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    const { p, o, v } = entry;
    if (typeof p !== 'string') return;
    if (/^\/message\/content\/parts\/\d+$/.test(p) && o === 'append' && typeof v === 'string') {
      if (this._tracking) this.text += v;
      return;
    }
    if (p === '/message/status' && v === 'finished_successfully') {
      if (this._tracking) this.complete = true;
      return;
    }
    if (p === '/message/end_turn' && v === true) {
      if (this._tracking) this.complete = true;
    }
  }

  _handleMessage(message, conversationId) {
    if (conversationId) this.conversationId = conversationId;
    if (isFinalAssistantMessage(message)) {
      this._tracking = true;
      const text = messageText(message);
      // Replace semantics: legacy events repeat the whole text so far. Never shrink —
      // an empty in_progress shell must not wipe already-accumulated delta text.
      if (text.length >= this.text.length) this.text = text;
      if (isMessageComplete(message)) this.complete = true;
    } else {
      // Reasoning/tool/user message became the append target — stop tracking until
      // the next final assistant message starts.
      this._tracking = false;
    }
  }
}

// Whole SSE body (string) → snapshot.
function parseSseBody(body) {
  const acc = new SseAccumulator();
  acc.feed(String(body || ''));
  acc.end();
  return acc.snapshot();
}

// Convenience: accept a conversation object, an SSE body, or a JSON string.
function parseConversationPayload(input) {
  if (input == null) return null;
  if (typeof input === 'object') {
    if (input.mapping) return extractAssistantFromMapping(input);
    const acc = new SseAccumulator();
    acc.handleEventObject(input);
    return acc.snapshot();
  }
  const s = String(input).trim();
  if (!s) return null;
  if (/^data:/m.test(s)) return parseSseBody(s);
  try {
    return parseConversationPayload(JSON.parse(s));
  } catch {
    return null;
  }
}

module.exports = {
  isValidConversationId,
  extractAssistantFromMapping,
  SseAccumulator,
  parseSseBody,
  parseConversationPayload,
  // exported for tests
  isFinalAssistantMessage,
  messageText,
};
