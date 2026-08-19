// Unit tests for the pure backend-api conversation reader (src/lib/conversation-read.js).
// Run via `npm test` (node:test — plain `node scripts/test-conversation-read.js` works).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidConversationId,
  extractAssistantFromMapping,
  SseAccumulator,
  parseSseBody,
  parseConversationPayload,
  isFinalAssistantMessage,
} = require('../src/lib/conversation-read');
const { makeConversation, msgNode } = require('./fixtures/conversation');

const CONV_ID = '01234567-89ab-4cde-8f01-23456789abcd';

function sse(events) {
  return events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
}

// ---- conversation id validation ----------------------------------------------------

test('isValidConversationId accepts UUIDs only', () => {
  assert.equal(isValidConversationId(CONV_ID), true);
  assert.equal(isValidConversationId(CONV_ID.toUpperCase()), true);
  assert.equal(isValidConversationId('not-a-uuid'), false);
  assert.equal(isValidConversationId(''), false);
  assert.equal(isValidConversationId(null), false);
  assert.equal(isValidConversationId(42), false);
  // URL-injection attempts must fail
  assert.equal(isValidConversationId('../../settings'), false);
  assert.equal(isValidConversationId(`${CONV_ID}/../x`), false);
  assert.equal(isValidConversationId(`${CONV_ID}?x=1`), false);
});

// ---- mapping (GET /backend-api/conversation/{id}) ----------------------------------

test('extractAssistantFromMapping returns the latest answer on the active branch', () => {
  const data = makeConversation(5);
  const snap = extractAssistantFromMapping(data);
  assert.equal(snap.lastAssistantText, 'answer 4');
  assert.equal(snap.conversationId, CONV_ID);
  assert.equal(snap.isComplete, true);
});

test('extractAssistantFromMapping ignores abandoned side branches', () => {
  const data = makeConversation(5, { branchAt: 2 });
  const snap = extractAssistantFromMapping(data);
  assert.equal(snap.lastAssistantText, 'answer 4');
});

test('extractAssistantFromMapping skips reasoning/tool messages', () => {
  const data = makeConversation(2);
  // Append a thoughts message after the last answer — must not be returned.
  const t = msgNode('thoughts', 'a1', 'assistant', 'internal reasoning');
  t.message.content = { content_type: 'thoughts', thoughts: [] };
  data.mapping.thoughts = t;
  data.mapping.a1.children.push('thoughts');
  data.current_node = 'thoughts';
  const snap = extractAssistantFromMapping(data);
  assert.equal(snap.lastAssistantText, 'answer 1');
});

test('extractAssistantFromMapping reports in-progress answers as incomplete', () => {
  const data = makeConversation(3);
  data.mapping.a2.message.status = 'in_progress';
  const snap = extractAssistantFromMapping(data);
  assert.equal(snap.lastAssistantText, 'answer 2');
  assert.equal(snap.isComplete, false);
});

test('extractAssistantFromMapping guards against bad input', () => {
  assert.equal(extractAssistantFromMapping(null), null);
  assert.equal(extractAssistantFromMapping({}), null);
  assert.equal(extractAssistantFromMapping({ mapping: {} }), null);
});

test('isFinalAssistantMessage excludes tool recipients and non-final channels', () => {
  const base = msgNode('x', 'root', 'assistant', 'hi').message;
  assert.equal(isFinalAssistantMessage(base), true);
  assert.equal(isFinalAssistantMessage({ ...base, recipient: 'browser' }), false);
  assert.equal(isFinalAssistantMessage({ ...base, channel: 'analysis' }), false);
  assert.equal(isFinalAssistantMessage({ ...base, author: { role: 'user' } }), false);
});

// ---- SSE legacy format --------------------------------------------------------------

function legacyMessage(text, status = 'in_progress') {
  return {
    message: {
      id: 'm1',
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: [text] },
      status,
      metadata: {},
    },
    conversation_id: CONV_ID,
    error: null,
  };
}

test('legacy SSE: full-message events with replace semantics', () => {
  const body = sse([
    legacyMessage('Hel'),
    legacyMessage('Hello wor'),
    legacyMessage('Hello world', 'finished_successfully'),
    '[DONE]',
  ]);
  const snap = parseSseBody(body);
  assert.equal(snap.lastAssistantText, 'Hello world');
  assert.equal(snap.conversationId, CONV_ID);
  assert.equal(snap.isComplete, true);
});

test('legacy SSE: [DONE] alone marks the stream complete', () => {
  const snap = parseSseBody(sse([legacyMessage('answer'), '[DONE]']));
  assert.equal(snap.isComplete, true);
});

// ---- SSE delta format ---------------------------------------------------------------

function deltaAdd(message) {
  return { v: { message, conversation_id: CONV_ID, error: null }, c: 0 };
}
function assistantShell() {
  return {
    id: 'm2',
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [''] },
    status: 'in_progress',
    metadata: {},
  };
}

test('delta SSE: add + appends + patch completion', () => {
  const body = sse([
    deltaAdd(assistantShell()),
    { v: 'Hello' },
    { p: '/message/content/parts/0', o: 'append', v: ' world' },
    { o: 'patch', v: [
      { p: '/message/status', o: 'replace', v: 'finished_successfully' },
      { p: '/message/end_turn', o: 'replace', v: true },
    ] },
    { type: 'message_stream_complete', conversation_id: CONV_ID },
    '[DONE]',
  ]);
  const snap = parseSseBody(body);
  assert.equal(snap.lastAssistantText, 'Hello world');
  assert.equal(snap.conversationId, CONV_ID);
  assert.equal(snap.isComplete, true);
});

test('delta SSE: bare-array v implies a patch list', () => {
  const body = sse([
    deltaAdd(assistantShell()),
    { v: [
      { p: '/message/content/parts/0', o: 'append', v: 'batched ' },
      { p: '/message/content/parts/0', o: 'append', v: 'text' },
      { p: '/message/status', o: 'replace', v: 'finished_successfully' },
    ] },
    { type: 'message_stream_complete', conversation_id: CONV_ID },
    '[DONE]',
  ]);
  const snap = parseSseBody(body);
  assert.equal(snap.lastAssistantText, 'batched text');
  assert.equal(snap.isComplete, true);
});

test('delta SSE: appends to a reasoning message are ignored', () => {
  const thoughts = assistantShell();
  thoughts.content = { content_type: 'thoughts', thoughts: [] };
  const body = sse([
    deltaAdd(thoughts),
    { v: 'secret reasoning' },
    deltaAdd(assistantShell()),
    { v: 'Real answer' },
    { o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] },
  ]);
  const snap = parseSseBody(body);
  assert.equal(snap.lastAssistantText, 'Real answer');
  assert.equal(snap.isComplete, true);
});

test('delta SSE: user echo message does not become the answer', () => {
  const userMsg = assistantShell();
  userMsg.author = { role: 'user' };
  userMsg.content = { content_type: 'text', parts: ['my question'] };
  const body = sse([
    deltaAdd(userMsg),
    { v: ' ignored' },
    deltaAdd(assistantShell()),
    { v: 'answer text' },
  ]);
  const snap = parseSseBody(body);
  assert.equal(snap.lastAssistantText, 'answer text');
  assert.equal(snap.isComplete, false);
});

// ---- incremental feeding ------------------------------------------------------------

test('SseAccumulator handles chunks split mid-line and mid-event', () => {
  const body = sse([
    deltaAdd(assistantShell()),
    { v: 'Hello' },
    { v: ' world' },
    '[DONE]',
  ]);
  for (const size of [1, 3, 7, 1000]) {
    const acc = new SseAccumulator();
    for (let i = 0; i < body.length; i += size) acc.feed(body.slice(i, i + size));
    acc.end();
    const snap = acc.snapshot();
    assert.equal(snap.lastAssistantText, 'Hello world', `chunk size ${size}`);
    assert.equal(snap.isComplete, true, `chunk size ${size}`);
  }
});

test('SseAccumulator.end flushes a truncated trailing event', () => {
  const acc = new SseAccumulator();
  acc.feed(sse([deltaAdd(assistantShell())]));
  acc.feed('data: {"v":"partial text"}'); // no trailing newline / blank line
  acc.end();
  assert.equal(acc.snapshot().lastAssistantText, 'partial text');
  assert.equal(acc.snapshot().isComplete, false);
});

test('SseAccumulator ignores garbage events without dying', () => {
  const acc = new SseAccumulator();
  acc.feed('data: {broken json\n\n');
  acc.feed('event: ping\n\n');
  acc.feed(sse([deltaAdd(assistantShell()), { v: 'ok' }]));
  acc.end();
  assert.equal(acc.snapshot().lastAssistantText, 'ok');
});

test('SseAccumulator.merge adopts a better snapshot only', () => {
  const acc = new SseAccumulator();
  acc.feed(sse([deltaAdd(assistantShell()), { v: 'partial ans' }]));
  acc.merge({ conversationId: CONV_ID, lastAssistantText: 'partial answer, full', isComplete: true });
  assert.equal(acc.snapshot().lastAssistantText, 'partial answer, full');
  assert.equal(acc.snapshot().isComplete, true);
  // A worse merge must not shrink the text
  acc.merge({ conversationId: null, lastAssistantText: 'x', isComplete: false });
  assert.equal(acc.snapshot().lastAssistantText, 'partial answer, full');
});

// ---- parseConversationPayload dispatch ----------------------------------------------

test('parseConversationPayload dispatches on payload shape', () => {
  const mappingSnap = parseConversationPayload(makeConversation(2));
  assert.equal(mappingSnap.lastAssistantText, 'answer 1');

  const jsonSnap = parseConversationPayload(JSON.stringify(makeConversation(3)));
  assert.equal(jsonSnap.lastAssistantText, 'answer 2');

  const sseSnap = parseConversationPayload(sse([legacyMessage('hi', 'finished_successfully')]));
  assert.equal(sseSnap.lastAssistantText, 'hi');

  assert.equal(parseConversationPayload(null), null);
  assert.equal(parseConversationPayload('not json at all'), null);
});
