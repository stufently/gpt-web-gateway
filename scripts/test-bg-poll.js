// Background-answer poll (2.16.4): when ChatGPT closes the response stream before the answer
// and finishes the turn server-side, the gateway reads the conversation from inside the page
// instead of reloading it (2026-10-29: reload → stall → 504 on extra_high). Real adapter; only
// browser, clock and the page's fetch are replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, logs, response, CONVERSATION } = require('./test-stall-diagnostics');

const empty = () => ({ assistantCount: 0, lastAssistantText: '', bodyTail: '' });
const NOW = 1_800_000_000_000;
const ENV = { CHAT_BG_POLL_INTERVAL_SEC: '15', CHAT_BG_POLL_HEAVY_SEC: '120', CHAT_BG_POLL_THINKING_SEC: '90',
  CHAT_BG_POLL_SEC: '60', CHAT_STALL_WINDOW_SEC: '3', CHAT_STREAM_RESCUE_SEC: '1' };

function node(id, parent, role, text, { at = NOW / 1000, status = 'finished_successfully', channel } = {}) {
  return { id, parent, children: [], message: { id, author: { role }, create_time: at,
    content: { content_type: 'text', parts: [text] }, status, channel, metadata: {} } };
}
// previous turn (old) → this turn's prompt → optional answer.
function conversation({ answer = null, complete = false, promptAt = NOW / 1000, withPrompt = true } = {}) {
  const mapping = {
    root: { id: 'root', parent: null, children: [], message: null },
    u0: node('u0', 'root', 'user', 'old question', { at: NOW / 1000 - 3600 }),
    a0: node('a0', 'u0', 'assistant', 'old answer', { at: NOW / 1000 - 3590 }),
  };
  let current = 'a0';
  if (withPrompt) { mapping.u1 = node('u1', 'a0', 'user', 'new question', { at: promptAt }); current = 'u1'; }
  if (answer !== null) {
    mapping.a1 = node('a1', current, 'assistant', answer, { status: complete ? 'finished_successfully' : 'in_progress' });
    current = 'a1';
  }
  return { conversation_id: CONVERSATION, current_node: current, mapping };
}
const ok = data => ({ ok: true, path: '/backend-api/conversation/{id}', token: true, streamStatus: '200 {}', data });

async function setup(chat, page, queue, clock, polls) {
  const p = page({}); queue.push(p);
  const slot = chat.getSlot(0); await chat.getPage(slot);
  p.address = `https://chatgpt.com/c/${CONVERSATION}`;
  clock.now = NOW;
  const capture = chat._test.beginBackendCapture(slot);
  const base = p.evaluate.bind(p);
  p.pollTimes = [];
  p.pollArgs = [];
  p.evaluate = async (fn, arg) => {
    if (fn.name !== 'conversationPollInPage') return base(fn, arg);
    p.pollTimes.push(clock.now);
    p.pollArgs.push(arg);
    const next = polls.length > 1 ? polls.shift() : polls[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { p, slot, capture };
}

test('a closed stream is answered from the conversation poll, without a reload', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const polls = [ok(conversation()), ok(conversation({ answer: 'part' })),
      ok(conversation({ answer: 'full answer', complete: true }))];
    const { p, capture } = await setup(chat, page, queue, clock, polls);
    const deltas = [];
    const { result, output } = await logs(() => chat._test.waitAndExtractText(p, empty(),
      { capture, thinkingMode: 'extra_high', onDelta: t => deltas.push(t) }));
    assert.equal(result.text, 'full answer');
    assert.equal(result.conversationId, CONVERSATION);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), [], 'no reload');
    assert.equal(p.pollTimes.length, 3);
    assert.deepEqual(p.pollTimes.slice(1).map((t, i) => t - p.pollTimes[i]), [15000, 15000], 'one poll per interval');
    assert.equal(p.pollArgs[0].id, CONVERSATION);
    assert.deepEqual(p.pollArgs[0].paths, ['/backend-api/conversation/{id}', '/backend-api/conversations/{id}'],
      'the classic path (known payload shape) is tried first');
    assert.deepEqual(deltas, ['full answer'], 'only the finished text reaches the client');
    assert.doesNotMatch(output, /session degraded/);
    assert.match(output, /\[bg-poll\] answer taken from conversation poll \(11 chars/);
  });
});

test('the poll outlives the stall window and the base deadline', async () => {
  await fixture({ ...ENV, CHAT_COMPLETION_TIMEOUT_SEC: '10', CHAT_COMPLETION_RETRY_TIMEOUT_SEC: '5' },
    async ({ chat, page, queue, clock }) => {
      const { p, capture } = await setup(chat, page, queue, clock,
        [() => ok(conversation(clock.now - NOW > 100000 ? { answer: 'late', complete: true } : {}))]);
      const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }));
      assert.equal(result.text, 'late');
      assert.ok(clock.now - NOW > 100000, 'waited past stall window (9s) and deadline (10s)');
    });
});

test('the previous turn of a continuation is never returned as this answer', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    // The new prompt is not on the active branch yet: current_node is the old, complete answer.
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ withPrompt: false }))]);
    const { output } = await logs(() => assert.rejects(
      chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' }),
      e => e.code === 'timeout' && /within 60s after submit \(background poll/.test(e.message)));
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
    assert.match(output, /turn=no chars=0/);
  });
});

test('a user message older than this turn does not count as the prompt', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const old = conversation({ answer: 'stale', complete: true, promptAt: NOW / 1000 - 600 });
    const { p, capture } = await setup(chat, page, queue, clock, [ok(old)]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture }), e => e.code === 'timeout'));
    assert.ok(p.pollTimes.length > 1);
  });
});

test('a previous turn seconds before this capture is still a previous turn', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const prev = conversation({ answer: 'previous', complete: true, promptAt: NOW / 1000 - 10 });
    const { p, capture } = await setup(chat, page, queue, clock, [ok(prev)]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' }),
      e => e.code === 'timeout'));
  });
});

test('the poll GET seen by the passive listener cannot smuggle in the previous reply', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const prev = conversation({ withPrompt: false });
    prev.mapping.a0.message.content.parts = ['**old** answer'];
    const { p, capture } = await setup(chat, page, queue, clock, [() => {
      p.emit('response', response({ method: 'GET', url: `/backend-api/conversation/${CONVERSATION}`, ct: 'application/json', data: prev }));
      return ok(prev);
    }]);
    const before = { ...empty(), lastAssistantText: 'old answer' };
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, before, { capture, thinkingMode: 'instant' }),
      e => e.code === 'timeout'));
  });
});

test('an answer identical to the previous one is still returned', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ answer: 'Yes', complete: true }))]);
    const { result } = await logs(() => chat._test.waitAndExtractText(p, { ...empty(), lastAssistantText: 'Yes' }, { capture }));
    assert.equal(result.text, 'Yes');
  });
});

for (const [mode, sec] of [['extra_high', 120], ['pro', 120], ['high', 90], ['instant', 60]]) {
  test(`poll budget for ${mode} is ${sec}s after submit`, async () => {
    await fixture(ENV, async ({ chat, page, queue, clock }) => {
      const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation())]);
      await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: mode }),
        e => e.code === 'timeout' && e.message.includes(`within ${sec}s after submit`)));
      assert.ok(clock.now - NOW >= sec * 1000 && clock.now - NOW < sec * 1000 + 2000);
    });
  });
}

test('a refused poll (401/404) falls back to the reload rescue', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const refused = { ok: false, token: true, tried: [{ path: 'a', status: 404 }, { path: 'b', status: 401 }] };
    const { p, capture } = await setup(chat, page, queue, clock, [refused]);
    const { output } = await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.equal(p.pollTimes.length, 1, 'no second poll after a refusal');
    assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
    assert.match(output, /falling back to the reload rescue/);
  });
});

test('an unknown payload shape falls back to the reload rescue', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const shape = { ok: false, token: true, tried: [{ path: 'a', status: 200, shape: 'items,total' }] };
    const { p, capture } = await setup(chat, page, queue, clock, [shape]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
  });
});

test('transient poll errors are retried, then fall back to reload after three', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const flaky = { ok: false, token: true, tried: [{ path: 'a', status: 502 }] };
    const { p, capture } = await setup(chat, page, queue, clock, [new Error('Execution context was destroyed'), flaky, flaky]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.equal(p.pollTimes.length, 3);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
  });
});

test('one transient error does not stop the poll', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock,
      [new Error('net'), new Error('net'), ok(conversation({ answer: 'done', complete: true }))]);
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture }));
    assert.equal(result.text, 'done');
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
  });
});

test('a successful poll resets the transient error count', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [new Error('net'), ok(conversation()),
      new Error('net'), new Error('net'), ok(conversation({ answer: 'after hiccups', complete: true }))]);
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }));
    assert.equal(result.text, 'after hiccups');
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
  });
});

test('slow prompt input comes out of the poll budget, never below two rescue windows', async () => {
  await fixture(ENV, async ({ chat }) => {
    assert.equal(chat._test.backgroundPollBudgetMs('extra_high', 0), 120000);
    assert.equal(chat._test.backgroundPollBudgetMs('extra_high', 30000 + 50000), 70000);
    assert.equal(chat._test.backgroundPollBudgetMs('instant', 30000 + 1000000), 2000);
  });
});

test('an open response stream still defers everything: no poll, no reload', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ answer: 'x', complete: true }))]);
    capture.openStreams = 1;
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' })));
    assert.equal(p.pollTimes.length, 0);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
  });
});

test('without a conversation id the poll is not attempted', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ answer: 'x', complete: true }))]);
    p.address = 'https://chatgpt.com/';
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.equal(p.pollTimes.length, 0);
  });
});

test('the conversation id from the stream is enough when the URL has none', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ answer: 'y', complete: true }))]);
    p.address = 'https://chatgpt.com/';
    capture.conversationId = CONVERSATION;
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture }));
    assert.equal(result.text, 'y');
  });
});

// ---- the in-page function, against a stubbed fetch ----
function stubFetch(routes) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers && init.headers.Authorization, credentials: init.credentials });
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}
const args = { id: CONVERSATION, paths: ['/backend-api/conversation/{id}', '/backend-api/conversations/{id}'], timeoutMs: 1000 };

test('in-page poll: bearer token, fallback path, branch trimmed to this turn, stream status', async () => {
  const chat = require('../src/chatgpt');
  const data = conversation({ answer: 'a', complete: true });
  data.mapping.side = node('side', 'a0', 'user', 'abandoned');
  const f = stubFetch({
    '/api/auth/session': { status: 200, body: { accessToken: 'tok' } },
    [`/backend-api/conversations/${CONVERSATION}`]: { status: 200, body: data },
    [`/backend-api/conversation/${CONVERSATION}/stream_status`]: { status: 200, body: { status: 'done' } },
  });
  try {
    const r = await chat._test.conversationPollInPage(args);
    assert.equal(r.ok, true);
    assert.equal(r.path, '/backend-api/conversations/{id}');
    assert.deepEqual(Object.keys(r.data.mapping).sort(), ['a1', 'u1'], 'only the active branch down to the prompt');
    assert.equal(r.streamStatus, '200 {"status":"done"}');
    const backend = f.calls.filter(c => c.url.startsWith('/backend-api/'));
    assert.ok(backend.every(c => c.auth === 'Bearer tok' && c.credentials === 'include'));
    assert.equal(f.calls[1].url, `/backend-api/conversation/${CONVERSATION}`, 'classic path tried first');
  } finally { f.restore(); }
});

test('in-page poll: refusals and unknown shapes are reported, not thrown', async () => {
  const chat = require('../src/chatgpt');
  const f = stubFetch({
    '/api/auth/session': new Error('offline'),
    [`/backend-api/conversation/${CONVERSATION}`]: { status: 401, body: {} },
    [`/backend-api/conversations/${CONVERSATION}`]: { status: 200, body: { items: [] } },
  });
  try {
    const r = await chat._test.conversationPollInPage(args);
    assert.equal(r.ok, false);
    assert.equal(r.token, false);
    assert.deepEqual(r.tried, [{ path: args.paths[0], status: 401 }, { path: args.paths[1], status: 200, shape: 'items' }]);
    assert.equal(f.calls[1].auth, undefined, 'no token, no Authorization header');
  } finally { f.restore(); }
});

test('pollConversation classifies refusal, transient failure and a missing page result', async () => {
  const chat = require('../src/chatgpt');
  const pageWith = result => ({ evaluate: async () => (result instanceof Error ? Promise.reject(result) : result) });
  const kind = async r => (await chat._test.pollConversation(pageWith(r), CONVERSATION, NOW / 1000 - 2)).kind;
  assert.equal(await kind({ ok: false, tried: [{ status: 403 }, { status: 404 }] }), 'unsupported');
  assert.equal(await kind({ ok: false, tried: [{ status: 404 }, { status: 500 }] }), 'error');
  assert.equal(await kind({ ok: false, tried: [{ error: 'aborted' }] }), 'error');
  assert.equal(await kind({ ok: false, tried: [] }), 'error');
  assert.equal(await kind(new Error('closed')), 'error');
  assert.equal(await kind(undefined), 'unsupported');
  assert.equal(await kind(ok({ mapping: {} })), 'unsupported');
  const r = await chat._test.pollConversation(pageWith(ok(conversation({ answer: 'z', complete: true }))), CONVERSATION, NOW / 1000 - 2);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.snap, { conversationId: CONVERSATION, turnFound: true, lastAssistantText: 'z', isComplete: true });
});

test('an unreadable turn is logged by shape, never by content', async () => {
  const chat = require('../src/chatgpt');
  const data = conversation({ answer: 'secret words', complete: false });
  const r = await chat._test.pollConversation({ evaluate: async () => ok(data) }, CONVERSATION, NOW / 1000 - 2);
  assert.equal(r.shape, 'assistant/text/-/-/in_progress/end=0/parts=s/len=12 < user/text/-/-/finished_successfully/end=0/parts=s/len=12');
  assert.ok(!r.shape.includes('secret'));
});

// ---- empty turn (2.16.7): stream COMPLETE, reasoning only, branch frozen ----
// Production shape (2026-10-29/30, 15 of 15 cases): the branch never changed again over 17–33
// polls and the request ended in a 504 after 420–600 s.
const COMPLETE = '200 {"status":"COMPLETE"}';
function thinking({ thoughts = 1, inProgress = true } = {}) {
  const data = conversation();
  data.mapping.t1 = { id: 't1', parent: 'u1', children: [], message: { id: 't1', author: { role: 'assistant' },
    recipient: 'all', status: inProgress ? 'in_progress' : 'finished_successfully',
    content: { content_type: 'thoughts', thoughts: Array.from({ length: thoughts }, (_, i) => ({ summary: `s${i}`, content: `c${i}` })) } } };
  data.mapping.u1.children = ['t1'];
  data.current_node = 't1';
  return data;
}
const okWith = (data, streamStatus) => ({ ...ok(data), streamStatus });

test('a frozen reasoning-only turn with a COMPLETE stream fails fast as empty_turn', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [okWith(thinking(), COMPLETE)]);
    let started;
    const { output } = await logs(() => assert.rejects(
      chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }).finally(() => { started = clock.now; }),
      e => e.code === 'empty_turn' && /without an answer/.test(e.message) && /3 polls/.test(e.message)));
    assert.equal(p.pollTimes.length, 3, 'gives up on the third identical poll');
    assert.ok(started - NOW < 60000, `well before the 120s budget (${started - NOW}ms)`);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
    assert.match(output, /\[bg-poll\] #3 empty turn: stream_status COMPLETE/);
    assert.match(output, /branch=assistant\/thoughts\/-\/all\/in_progress\/.*\/th=1 < user/);
  });
});

test('reasoning that keeps moving is never cut, and its answer is returned', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const polls = [1, 2, 3, 4, 5, 6].map(n => okWith(thinking({ thoughts: n }), COMPLETE));
    const done = conversation({ answer: 'thought through', complete: true });
    polls.push(okWith(done, COMPLETE));
    const { p, capture } = await setup(chat, page, queue, clock, polls);
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }));
    assert.equal(result.text, 'thought through');
    assert.equal(p.pollTimes.length, 7);
  });
});

test('the count restarts at every change: two frozen polls, a step, then three frozen', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const a = okWith(thinking({ thoughts: 1 }), COMPLETE);
    const b = okWith(thinking({ thoughts: 2 }), COMPLETE);
    const { p, capture } = await setup(chat, page, queue, clock, [a, a, b, b, b]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }),
      e => e.code === 'empty_turn'));
    assert.equal(p.pollTimes.length, 5);
  });
});

test('a transient poll error neither counts as a frozen poll nor resets the count', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const a = okWith(thinking(), COMPLETE);
    const { p, capture } = await setup(chat, page, queue, clock, [a, new Error('signal is aborted without reason'), a, a]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }),
      e => e.code === 'empty_turn'));
    assert.equal(p.pollTimes.length, 4);
  });
});

for (const [name, status] of [['still streaming', '200 {"status":"IS_STREAMING"}'], ['unknown', '200 {}'], ['unreadable', null]]) {
  test(`a frozen turn whose stream status is ${name} waits for the budget`, async () => {
    await fixture(ENV, async ({ chat, page, queue, clock }) => {
      const { p, capture } = await setup(chat, page, queue, clock, [okWith(thinking(), status)]);
      await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }),
        e => e.code === 'timeout' && /within 120s/.test(e.message)));
      assert.ok(p.pollTimes.length > 3);
    });
  });
}

test('only empty-looking polls count: a streaming poll in between restarts the count', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const a = okWith(thinking(), COMPLETE);
    const s = okWith(thinking(), '200 {"status":"IS_STREAMING"}');
    const { p, capture } = await setup(chat, page, queue, clock, [s, s, a, a, s, a, a, a]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }),
      e => e.code === 'empty_turn'));
    assert.equal(p.pollTimes.length, 8, 'the first COMPLETE after streaming polls is poll one of three');
  });
});

test('frozen partial answer text is not an empty turn', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [okWith(conversation({ answer: 'half' }), COMPLETE)]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }),
      e => e.code === 'timeout'));
  });
});

test('a COMPLETE stream before the prompt reaches the branch is not an empty turn', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [okWith(conversation({ withPrompt: false }), COMPLETE)]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' }),
      e => e.code === 'timeout'));
  });
});

test('CHAT_BG_POLL_EMPTY_POLLS sets how many frozen polls it takes', async () => {
  await fixture({ ...ENV, CHAT_BG_POLL_EMPTY_POLLS: '5' }, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [okWith(thinking(), COMPLETE)]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }),
      e => e.code === 'empty_turn'));
    assert.equal(p.pollTimes.length, 5);
  });
});

test('empty_turn answers 502 with should_retry and its own error kind and metric', () => {
  const { classifyError, shouldRetryKind, metricsHandler } = require('../src/metrics');
  const { INFRA_ERROR_KINDS } = require('../src/progress');
  assert.equal(classifyError('ChatGPT ended the turn without an answer', 'empty_turn'), 'empty_turn');
  assert.equal(shouldRetryKind('empty_turn'), true);
  assert.equal(INFRA_ERROR_KINDS.has('empty_turn'), false, 'an upstream drop must not count toward our health streak');
  const { respondWithError } = require('../src/routes/images')._internals;
  const res = { headers: {}, code: 0, body: null, set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const err = new Error('ChatGPT ended the turn without an answer'); err.code = 'empty_turn';
  respondWithError(res, Date.now(), err);
  assert.equal(res.code, 502);
  assert.equal(res.body.error_kind, 'empty_turn');
  assert.equal(res.body.should_retry, true);
  let body = '';
  metricsHandler({}, { set() {}, send(b) { body = b; } });
  assert.match(body, /gpt_web_gateway_errors_total\{type="empty_turn"\} [1-9]/, 'counted under its own kind');
  assert.match(body, /gpt_web_gateway_duration_seconds_count\{result="empty_turn"\} [1-9]/);
});

// ---- 2026-10-31: the stream closed in the middle of the answer ----
// ChatGPT closes the stream of a turn it dropped mid-answer and stores the message cut. The
// end of the stream is not the end of the answer: the conversation decides.
const sseBody = events => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const shell = { id: 'a1', author: { role: 'assistant' }, recipient: 'all',
  content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: {} };
function streamed(capture, text, { finished = false } = {}) {
  capture.feed(sseBody([{ o: 'add', v: { message: shell, conversation_id: CONVERSATION } }, { v: text },
    ...(finished ? [{ o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] }] : []),
    { type: 'message_stream_complete', conversation_id: CONVERSATION }, '[DONE]']));
}

test('a stream that closed mid-answer is checked against the conversation and its full text returned', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock,
      [okWith(conversation({ answer: '{"pick": true, "body": "all of it"}', complete: true }), COMPLETE)]);
    streamed(capture, '{"pick": true,');
    const { result, output } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extended' }));
    assert.equal(result.text, '{"pick": true, "body": "all of it"}');
    assert.equal(p.pollTimes.length, 1);
    assert.match(output, /stream closed before the answer message finished \(14 chars\)/);
    assert.doesNotMatch(output, /answer taken from backend-api stream/);
  });
});

test('a mid-answer cut that stays frozen fails as empty_turn, never as the cut text', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [okWith(conversation({ answer: '{"pick": true,' }), COMPLETE)]);
    streamed(capture, '{"pick": true,');
    const { output } = await logs(() => assert.rejects(
      chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }),
      e => e.code === 'empty_turn' && /mid-answer/.test(e.message) && /at 14 chars/.test(e.message) && /3 polls/.test(e.message)));
    assert.equal(p.pollTimes.length, 3);
    assert.match(output, /\[bg-poll\] #3 cut turn: stream_status COMPLETE/);
  });
});

test('a mid-answer cut whose turn still moves keeps waiting, then returns the finish', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const polls = ['{"p', '{"pi', '{"pic', '{"pick'].map(a => okWith(conversation({ answer: a }), COMPLETE));
    polls.push(okWith(conversation({ answer: '{"pick": false}', complete: true }), COMPLETE));
    const { p, capture } = await setup(chat, page, queue, clock, polls);
    streamed(capture, '{"p');
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extended' }));
    assert.equal(result.text, '{"pick": false}');
    assert.equal(p.pollTimes.length, 5);
  });
});

test('the page DOM cannot hand back the cut text while the conversation is being checked', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [okWith(conversation({ answer: 'cut' }), COMPLETE)]);
    const base = p.evaluate;
    p.evaluate = async (fn, arg) => String(fn).includes('assistantCount: assistantMessages.length')
      ? { assistantCount: 1, lastAssistantText: 'cut', bodyTail: 'cut' } : base(fn, arg);
    streamed(capture, 'cut');
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' }),
      e => e.code === 'empty_turn'));
  });
});

test('a finished answer message is taken from the stream at once, without a poll', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation())]);
    streamed(capture, 'whole answer', { finished: true });
    const { result, output } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extended' }));
    assert.equal(result.text, 'whole answer');
    assert.equal(p.pollTimes.length, 0);
    assert.match(output, /answer taken from backend-api stream \(12 chars\)\n/);
  });
});

test('without a pollable conversation the mid-answer stream text is taken as is, and says so', async () => {
  for (const variant of ['no id', 'refused']) {
    await fixture(ENV, async ({ chat, page, queue, clock }) => {
      const refused = { ok: false, token: true, tried: [{ path: 'a', status: 404 }] };
      const { p, capture } = await setup(chat, page, queue, clock, [refused]);
      streamed(capture, 'partial');
      if (variant === 'no id') { p.address = 'https://chatgpt.com/'; capture.conversationId = null; }
      const { result, output } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extended' }));
      assert.equal(result.text, 'partial', variant);
      assert.equal(p.pollTimes.length, variant === 'no id' ? 0 : 1, variant);
      assert.match(output, /cannot be polled — taken as is/, variant);
    });
  }
});

test('a finish that reaches the stream during the mid-answer check is taken over the poll', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    let capture;
    const frozen = okWith(conversation({ answer: 'cut' }), COMPLETE);
    const polls = [frozen, () => {
      capture.merge({ lastAssistantText: 'cut and the rest', isComplete: true, messageComplete: true });
      return frozen;
    }, frozen, frozen];
    const ready = await setup(chat, page, queue, clock, polls);
    capture = ready.capture;
    const { p } = ready;
    streamed(capture, 'cut');
    const { result, output } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extended' }));
    assert.equal(result.text, 'cut and the rest');
    assert.equal(p.pollTimes.length, 2, 'stops polling once the stream itself finished');
    assert.match(output, /answer taken from backend-api stream \(16 chars\)\n/);
  });
});
