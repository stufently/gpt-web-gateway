// Unit tests for the pure OpenAI SSE chunk transform (src/lib/sse-transform.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DONE_EVENT,
  computeDelta,
  formatRoleChunk,
  createStreamEmitter,
} = require('../src/lib/sse-transform');

const META = { id: 'chatcmpl-test', created: 1700000000, model: 'chatgpt-web' };

function parseChunk(str) {
  assert.ok(str.startsWith('data: '), `chunk starts with data: (${str.slice(0, 20)})`);
  assert.ok(str.endsWith('\n\n'), 'chunk ends with blank line');
  return JSON.parse(str.slice(6));
}

test('computeDelta appends, never retracts', () => {
  assert.equal(computeDelta('', 'Hello'), 'Hello');
  assert.equal(computeDelta('Hello', 'Hello world'), ' world');
  assert.equal(computeDelta('Hello', 'Hello'), '');
  assert.equal(computeDelta('Hello world', 'Hello'), '', 'shrink ignored');
  assert.equal(computeDelta('Hello', 'Goodbye'), '', 'rewrite ignored');
  assert.equal(computeDelta('x', ''), '');
  assert.equal(computeDelta('x', null), '');
});

test('role chunk has the OpenAI chunk shape', () => {
  const obj = parseChunk(formatRoleChunk(META));
  assert.equal(obj.id, META.id);
  assert.equal(obj.object, 'chat.completion.chunk');
  assert.equal(obj.created, META.created);
  assert.equal(obj.model, META.model);
  assert.deepEqual(obj.choices, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
});

test('emitter streams growing text as incremental deltas', () => {
  const em = createStreamEmitter(META);
  const start = em.start();
  assert.ok(start);
  assert.equal(em.start(), '', 'start is idempotent');

  const c1 = em.push('Hel');
  const c2 = em.push('Hel');       // no growth → nothing
  const c3 = em.push('Hello wor');
  assert.equal(c1.length, 1);
  assert.equal(c2.length, 0);
  assert.equal(c3.length, 1);
  assert.equal(parseChunk(c1[0]).choices[0].delta.content, 'Hel');
  assert.equal(parseChunk(c3[0]).choices[0].delta.content, 'lo wor');

  const fin = em.finish('Hello world');
  assert.equal(fin.length, 3, 'remaining delta + finish + DONE');
  assert.equal(parseChunk(fin[0]).choices[0].delta.content, 'ld');
  assert.equal(parseChunk(fin[1]).choices[0].finish_reason, 'stop');
  assert.equal(fin[2], DONE_EVENT);
  assert.equal(em.sentText(), 'Hello world');
});

test('emitter with no pushes emits the whole final text at finish', () => {
  const em = createStreamEmitter(META);
  em.start();
  const fin = em.finish('complete answer');
  assert.equal(fin.length, 3);
  assert.equal(parseChunk(fin[0]).choices[0].delta.content, 'complete answer');
  assert.equal(fin[2], DONE_EVENT);
});

test('conflicting DOM rewrites are skipped, final text wins when it extends', () => {
  const em = createStreamEmitter(META);
  em.start();
  em.push('Answer part');
  assert.equal(em.push('Different text').length, 0, 'non-append rewrite skipped');
  const fin = em.finish('Answer part two');
  assert.equal(parseChunk(fin[0]).choices[0].delta.content, ' two');
});

test('finish with contradicting final text emits only finish + DONE', () => {
  const em = createStreamEmitter(META);
  em.start();
  em.push('streamed prefix');
  const fin = em.finish('unrelated final');
  assert.equal(fin.length, 2, 'no content retraction possible');
  assert.equal(parseChunk(fin[0]).choices[0].finish_reason, 'stop');
  assert.equal(fin[1], DONE_EVENT);
});

test('finish extra fields land on the finish chunk (conversation_id)', () => {
  const em = createStreamEmitter(META);
  em.start();
  const fin = em.finish('text', { conversation_id: '01234567-89ab-4cde-8f01-23456789abcd' });
  const finishObj = parseChunk(fin[fin.length - 2]);
  assert.equal(finishObj.conversation_id, '01234567-89ab-4cde-8f01-23456789abcd');
});

test('the finish chunk also carries applied/requested (tier downgrades reach SSE clients)', () => {
  // A streaming client used to learn only the conversation_id, so a Pro→Extra High downgrade
  // was invisible to it while a blocking client saw it. The OpenAI-shaped fields must survive.
  const em = createStreamEmitter(META);
  em.start();
  const fin = em.finish('text', {
    conversation_id: null,
    applied: { thinking_mode: 'extra_high', requested_verified: false,
               thinking_fallback: { from: 'pro', to: 'extra_high', reason: 'quota' } },
    requested: { thinking_mode: 'pro' },
  });
  const finishObj = parseChunk(fin[fin.length - 2]);
  assert.equal(finishObj.applied.thinking_mode, 'extra_high');
  assert.equal(finishObj.applied.requested_verified, false);
  assert.equal(finishObj.applied.thinking_fallback.from, 'pro');
  assert.equal(finishObj.requested.thinking_mode, 'pro');
  // ...without disturbing the standard envelope.
  assert.equal(finishObj.object, 'chat.completion.chunk');
  assert.equal(finishObj.choices[0].finish_reason, 'stop');
  assert.deepEqual(finishObj.choices[0].delta, {});
});

test('concatenated deltas reproduce the full text exactly', () => {
  const em = createStreamEmitter(META);
  em.start();
  const stages = ['H', 'Hi', 'Hi th', 'Hi there', 'Hi there, world'];
  const contents = [];
  for (const s of stages) {
    for (const c of em.push(s)) contents.push(parseChunk(c).choices[0].delta.content);
  }
  for (const c of em.finish('Hi there, world!')) {
    if (c === DONE_EVENT) continue;
    const obj = parseChunk(c);
    if (obj.choices[0].delta.content) contents.push(obj.choices[0].delta.content);
  }
  assert.equal(contents.join(''), 'Hi there, world!');
});
