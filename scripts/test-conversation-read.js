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

// ---- the production "empty turn" shape (2026-10-29/30) -------------------------------
// assistant/thoughts in_progress < assistant/thoughts finished < user: reasoning only.
const { extractTurnAnswer, describeTurn, turnFingerprint } = require('../src/lib/conversation-read');
const T0 = 1_800_000_000;
function turnBranch(extra = []) {
  const mapping = {
    root: { id: 'root', parent: null, children: ['u'], message: null },
    u: { id: 'u', parent: 'root', children: ['t1'], message: { author: { role: 'user' }, create_time: T0,
      status: 'finished_successfully', content: { content_type: 'text', parts: ['prompt'] } } },
    t1: { id: 't1', parent: 'u', children: ['t2'], message: { author: { role: 'assistant' }, recipient: 'all',
      status: 'finished_successfully', content: { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'reasoning one' }] } } },
    t2: { id: 't2', parent: 't1', children: [], message: { author: { role: 'assistant' }, recipient: 'all',
      status: 'in_progress', content: { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'reasoning two' }] } } },
  };
  let parent = 't2';
  for (const [id, message] of extra) {
    mapping[parent].children.push(id);
    mapping[id] = { id, parent, children: [], message: { author: { role: 'assistant' }, ...message } };
    parent = id;
  }
  return { conversation_id: CONV_ID, current_node: parent, mapping };
}

test('a reasoning-only turn has no answer text, whatever the thoughts say', () => {
  const snap = extractTurnAnswer(turnBranch(), { notBeforeSec: T0 - 1 });
  assert.deepEqual(snap, { conversationId: CONV_ID, turnFound: true, lastAssistantText: '', isComplete: false });
  // reasoning_recap and a text message on a non-final channel are not answers either.
  const recap = turnBranch([['r', { recipient: 'all', status: 'finished_successfully', end_turn: true,
    content: { content_type: 'reasoning_recap', content: 'Thought for 2m' } }],
  ['c', { recipient: 'all', channel: 'commentary', status: 'finished_successfully', content: { content_type: 'text', parts: ['note'] } }]]);
  assert.equal(extractTurnAnswer(recap, { notBeforeSec: T0 - 1 }).lastAssistantText, '');
});

test('the final text after reasoning is taken in every form the reader accepts', () => {
  const forms = [
    { recipient: 'all', status: 'finished_successfully', content: { content_type: 'text', parts: ['answer'] } },
    { recipient: 'all', channel: 'final', status: 'finished_successfully', content: { content_type: 'text', parts: ['answer'] } },
    { status: 'in_progress', end_turn: true, content: { content_type: 'text', parts: ['answer'] } },
    { recipient: 'all', status: 'in_progress', metadata: { is_complete: true }, content: { content_type: 'text', parts: ['ans', { text: 'wer' }] } },
  ];
  for (const form of forms) {
    const snap = extractTurnAnswer(turnBranch([['a', form]]), { notBeforeSec: T0 - 1 });
    assert.equal(snap.lastAssistantText, form.content.parts.length > 1 ? 'ans\nwer' : 'answer', JSON.stringify(form));
    assert.equal(snap.isComplete, true, JSON.stringify(form));
  }
  const partial = extractTurnAnswer(turnBranch([['a', { status: 'in_progress', content: { content_type: 'text', parts: ['ans'] } }]]),
    { notBeforeSec: T0 - 1 });
  assert.equal(partial.lastAssistantText, 'ans');
  assert.equal(partial.isComplete, false);
});

test('describeTurn reports the thought count, never their content', () => {
  const shape = describeTurn(turnBranch());
  assert.equal(shape, 'assistant/thoughts/-/all/in_progress/end=0/parts=-/len=0/th=1'
    + ' < assistant/thoughts/-/all/finished_successfully/end=0/parts=-/len=0/th=1'
    + ' < user/text/-/-/finished_successfully/end=0/parts=s/len=6');
  assert.ok(!shape.includes('reasoning'));
});

test('turnFingerprint moves with any progress on the branch and only with it', () => {
  const base = turnFingerprint(turnBranch());
  assert.ok(base);
  assert.equal(turnFingerprint(turnBranch()), base, 'same branch, same fingerprint');
  assert.ok(!base.includes('reasoning'), 'content-free');
  const grown = turnBranch(); grown.mapping.t2.message.content.thoughts.push({ summary: 's', content: 'more' });
  const longer = turnBranch(); longer.mapping.t2.message.content.thoughts[0].content += '!';
  const rewritten = turnBranch(); rewritten.mapping.t2.message.content.thoughts[0].content = 'reasoning TWO';
  const flipped = turnBranch(); flipped.mapping.t2.message.status = 'finished_successfully';
  const touched = turnBranch(); touched.mapping.t2.message.update_time = T0 + 5;
  const ended = turnBranch(); ended.mapping.t2.message.end_turn = true;
  const child = turnBranch(); child.mapping.t2.children.push('x');
  const added = turnBranch([['t3', { recipient: 'all', status: 'in_progress', content: { content_type: 'thoughts', thoughts: [] } }]]);
  for (const [name, d] of Object.entries({ grown, longer, rewritten, flipped, touched, ended, child, added })) {
    assert.notEqual(turnFingerprint(d), base, name);
  }
  // Nodes above the prompt (earlier turns) do not belong to this turn.
  const older = turnBranch(); older.mapping.root.children.push('zzz');
  assert.equal(turnFingerprint(older), base);
  assert.equal(turnFingerprint(null), '');
  assert.equal(turnFingerprint({ mapping: null }), '');
});

// 2026-10-31: ChatGPT closes the stream of a turn it dropped mid-answer. The stream's own
// end ([DONE] / message_stream_complete) is not the answer's finish.
test('messageComplete: only the answer message finishing sets it, not the end of the stream', () => {
  const cut = parseSseBody(sse([deltaAdd(assistantShell()), { v: '{"pick": true,' },
    { type: 'message_stream_complete', conversation_id: CONV_ID }, '[DONE]']));
  assert.equal(cut.lastAssistantText, '{"pick": true,');
  assert.equal(cut.isComplete, true, 'the stream is over');
  assert.equal(cut.messageComplete, false, 'the answer is not');
  for (const [name, finish] of [
    ['status', { p: '/message/status', o: 'replace', v: 'finished_successfully' }],
    ['end_turn', { p: '/message/end_turn', o: 'replace', v: true }]]) {
    const snap = parseSseBody(sse([deltaAdd(assistantShell()), { v: 'whole' }, { o: 'patch', v: [finish] }]));
    assert.equal(snap.messageComplete, true, name);
    assert.equal(snap.isComplete, true, name);
  }
  for (const finish of [{ p: '/message/status', o: 'replace', v: 'finished_successfully' },
    { p: '/message/end_turn', o: 'replace', v: true }]) {
    const lone = parseSseBody(sse([deltaAdd(assistantShell()), { v: 'whole' }, finish, '[DONE]']));
    assert.equal(lone.messageComplete, true, `a lone ${finish.p} patch outside a list`);
    assert.equal(lone.lastAssistantText, 'whole');
  }
  assert.equal(parseSseBody(sse([legacyMessage('legacy', 'finished_successfully')])).messageComplete, true);
  assert.equal(parseSseBody(sse([legacyMessage('legacy'), '[DONE]'])).messageComplete, false);
  // A finish on a reasoning message is not the answer's finish.
  const thoughts = { ...assistantShell(), content: { content_type: 'thoughts', thoughts: [] } };
  assert.equal(parseSseBody(sse([deltaAdd(thoughts),
    { o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] }, '[DONE]'])).messageComplete, false);
});

test('merge adopts a finish only together with text that covers what is kept', () => {
  const acc = new SseAccumulator();
  acc.feed(sse([deltaAdd(assistantShell()), { v: 'longer cut text' }, '[DONE]']));
  acc.merge({ lastAssistantText: 'short', isComplete: true, messageComplete: true });
  assert.equal(acc.snapshot().messageComplete, false, 'a shorter finished body says nothing about the cut');
  acc.merge({ lastAssistantText: 'longer cut text', isComplete: true, messageComplete: true });
  assert.equal(acc.snapshot().messageComplete, true, 'the same text, finished');
  assert.equal(acc.snapshot().lastAssistantText, 'longer cut text');
});
