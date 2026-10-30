// Empty-turn retry and early poll (2.16.8). An empty turn (stream COMPLETE, reasoning only,
// branch frozen) is resent once in a new chat when the request budget allows it; the poll that
// detects it starts right after the response stream closed without text. Real adapter; only
// browser, clock and the page's fetch are replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, logs, response, CONVERSATION } = require('./test-stall-diagnostics');

const SECOND = '22222222-3333-4444-8555-666666666666';
const NOW = 1_800_000_000_000;
const COMPLETE = '200 {"status":"COMPLETE"}';
const STREAMING = '200 {"status":"IS_STREAMING"}';
const ENV = { CHAT_BG_POLL_INTERVAL_SEC: '15', CHAT_BG_POLL_THINKING_SEC: '90', CHAT_BG_POLL_SEC: '60',
  CHAT_STALL_WINDOW_SEC: '30', CHAT_STREAM_RESCUE_SEC: '60', CHAT_BG_POLL_EARLY_SEC: '5',
  // The tests below pin the same-mode resend; the instant resend (2.16.9) has its own block.
  CHAT_EMPTY_TURN_INSTANT_RETRY: '0' };
const empty = () => ({ assistantCount: 0, lastAssistantText: '', bodyTail: '' });

// The active branch of a turn whose prompt was sent at `promptAt` (ms): reasoning only, or an answer.
function turn(promptAt, answer = null) {
  const at = promptAt / 1000;
  const mapping = {
    root: { id: 'root', parent: null, children: ['u1'], message: null },
    u1: { id: 'u1', parent: 'root', children: ['t1'], message: { id: 'u1', author: { role: 'user' }, create_time: at,
      content: { content_type: 'text', parts: ['prompt'] }, status: 'finished_successfully', metadata: {} } },
    t1: { id: 't1', parent: 'u1', children: [], message: { id: 't1', author: { role: 'assistant' }, recipient: 'all',
      create_time: at + 1, status: 'in_progress', content: { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'c' }] } } },
  };
  let current = 't1';
  if (answer !== null) {
    mapping.t1.message.status = 'finished_successfully';
    mapping.t1.children = ['a1'];
    mapping.a1 = { id: 'a1', parent: 't1', children: [], message: { id: 'a1', author: { role: 'assistant' }, create_time: at + 2,
      content: { content_type: 'text', parts: [answer] }, status: 'finished_successfully', metadata: {} } };
    current = 'a1';
  }
  return { conversation_id: null, current_node: current, mapping };
}
const polled = (data, streamStatus = COMPLETE) => ({ ok: true, path: '/backend-api/conversation/{id}', token: true, streamStatus, data });

// One page that plays a sequence of turns. Each turn: { id, poll(sentAt) } — the send opens
// /c/<id>, its SSE POST closes at once with no text, and the conversation poll answers poll().
function scripted(f, turns) {
  const p = f.page({
    onSend: page => {
      const t = turns[page.sends - 1];
      page.address = `https://chatgpt.com/c/${t.id}`;
      if (t.onSend) t.onSend(page);
      // 'partial': the stream closes with unfinished answer text, so only the silence window polls.
      const partial = `data: ${JSON.stringify({ message: { id: 'a1', author: { role: 'assistant' }, status: 'in_progress',
        content: { content_type: 'text', parts: ['half'] } }, conversation_id: t.id })}\n\n`;
      const text = t.stream === 'open' ? () => new Promise(() => {})
        : t.stream === 'partial' ? async () => partial : async () => '';
      page.emit('response', response({ status: t.status || 200, ct: t.status ? 'application/json' : 'text/event-stream', text }));
    },
  });
  const base = p.evaluate.bind(p);
  p.polls = [];
  p.evaluate = async (fn, arg) => {
    if (fn.name !== 'conversationPollInPage') return base(fn, arg);
    const t = turns[p.sends - 1];
    p.polls.push({ id: arg.id, at: f.clock.now });
    return t.poll(p.sentAt[p.sends - 1], arg.id);
  };
  f.queue.push(p);
  return p;
}
const frozen = { poll: at => polled(turn(at)) };

test('an empty turn is resent once in a new chat and the resend answers', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    let staleGet = null;
    const p = scripted(f, [
      { id: CONVERSATION, ...frozen },
      { id: SECOND,
        // The abandoned turn catches up while the resend runs: its finished answer reaches the
        // passive listener and would be returned by a poll of the OLD conversation.
        onSend: page => {
          staleGet = turn(page.sentAt[0], 'LATE');
          staleGet.conversation_id = CONVERSATION;
          page.emit('response', response({ method: 'GET', url: `/backend-api/conversation/${CONVERSATION}`, ct: 'application/json', data: staleGet }));
        },
        poll: (at, id) => polled(id === SECOND ? turn(at, 'retry answer') : turn(p.sentAt[0], 'LATE')) },
    ]);
    const requestStartedAt = NOW;
    let finished = 0;
    const state = { used: 0 };
    const { result, output } = await logs(() => f.chat.completeText('hello', {
      thinkingMode: 'instant', requestStartedAt, stallRetryState: state, onAttemptFinished: () => { finished++; } }));
    assert.deepEqual(state, { used: 0, emptyTurnUsed: 1, emptyTurnDeadlineAt: NOW + 600000 },
      'the resend and its deadline are recorded in the per-job state');
    assert.equal(result.text, 'retry answer');
    assert.equal(result.conversation_id, SECOND);
    assert.equal(p.sends, 2, 'exactly one resend');
    assert.ok(staleGet, 'the late answer of the abandoned turn was offered');
    assert.deepEqual([...new Set(p.polls.filter(x => x.at >= p.sentAt[1]).map(x => x.id))], [SECOND],
      'the abandoned conversation is never polled again');
    assert.equal(finished, 1, 'the abandoned attempt releases its pacing slot');
    assert.match(output, /\[chatgpt\] empty turn retry 1\/1: resending in a new chat, \d+s of the request budget left/);
    assert.match(output, /\[chatgpt\] empty turn retry 1\/1: answered \(12 chars/);
    assert.doesNotMatch(output, /empty turn retry failed/);
  });
});

test('a resend that is empty too ends as empty_turn, with no third send', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, ...frozen }, { id: SECOND, ...frozen }]);
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }),
      e => e.code === 'empty_turn'));
    assert.equal(p.sends, 2);
    assert.match(output, /empty turn retry 1\/1: failed \(empty_turn\)/);
  });
});

test('no resend when the request budget left is below the minimum', async () => {
  await fixture({ ...ENV, CHAT_REQUEST_BUDGET_SEC: '600', CHAT_EMPTY_TURN_RETRY_MIN_SEC: '180' }, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, poll: at => polled(turn(at, 'never')) }]);
    // ~40 s of the first attempt on top of 400 s already spent → under 180 s left.
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW - 400000 }),
      e => e.code === 'empty_turn'));
    assert.equal(p.sends, 1);
    assert.match(output, /empty turn retry 1\/1: skipped, \d+s of the request budget left, need 180s/);
    assert.doesNotMatch(output, /resending in a new chat/);
  });
});

test('the resend waits no longer than the request deadline', async () => {
  await fixture({ ...ENV, CHAT_REQUEST_BUDGET_SEC: '300', CHAT_EMPTY_TURN_RETRY_MIN_SEC: '60' }, async f => {
    f.clock.now = NOW;
    // The resend's turn keeps "streaming" forever: only a deadline can end it.
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, poll: at => polled(turn(at), STREAMING) }]);
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }),
      e => e.code === 'timeout'));
    assert.equal(p.sends, 2);
    assert.ok(f.clock.now - NOW <= 302000, `ended ${f.clock.now - NOW}ms after the request arrived, budget 300s`);
    assert.ok(f.clock.now - NOW >= 299000, `used the budget (${f.clock.now - NOW}ms)`);
    assert.match(output, /empty turn retry 1\/1: failed \(timeout\)/);
  });
});

test('other failures after submit are not resent', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, poll: at => polled(turn(at), STREAMING) }, { id: SECOND, poll: at => polled(turn(at, 'x')) }]);
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }),
      e => e.code === 'timeout'));
    assert.equal(p.sends, 1);
    assert.doesNotMatch(output, /empty turn retry/);
  });
});

test('an empty turn of a continuation is not resent', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: CONVERSATION, poll: at => polled(turn(at, 'x')) }]);
    p.address = `https://chatgpt.com/c/${CONVERSATION}`;
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW, conversationId: CONVERSATION }),
      e => e.code === 'empty_turn'));
    assert.equal(p.sends, 1);
    assert.doesNotMatch(output, /empty turn retry/);
  });
});

test('CHAT_EMPTY_TURN_RETRIES=0 turns the resend off', async () => {
  await fixture({ ...ENV, CHAT_EMPTY_TURN_RETRIES: '0' }, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, poll: at => polled(turn(at, 'x')) }]);
    await logs(() => assert.rejects(f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }),
      e => e.code === 'empty_turn'));
    assert.equal(p.sends, 1);
  });
});

test('the resend budget is per job: a pool restart does not grant a second one', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const state = { used: 0, emptyTurnUsed: 1 };
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, poll: at => polled(turn(at, 'x')) }]);
    await logs(() => assert.rejects(f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW, stallRetryState: state }),
      e => e.code === 'empty_turn'));
    assert.equal(p.sends, 1);
  });
});

// ---- early poll: the stream closed without answer text ----
async function closedTurn(f, { text = '', partial = false, id = CONVERSATION, polls } = {}) {
  f.clock.now = NOW;
  const p = f.page({}); f.queue.push(p);
  const slot = f.chat.getSlot(0); await f.chat.getPage(slot);
  p.address = id ? `https://chatgpt.com/c/${id}` : 'https://chatgpt.com/c/pending';
  const capture = f.chat._test.beginBackendCapture(slot);
  const base = p.evaluate.bind(p);
  p.pollTimes = [];
  p.evaluate = async (fn, arg) => {
    if (fn.name !== 'conversationPollInPage') return base(fn, arg);
    p.pollTimes.push(f.clock.now);
    return polls(NOW);
  };
  const sse = text ? `data: ${JSON.stringify({ message: { id: 'a1', author: { role: 'assistant' },
    status: partial ? 'in_progress' : 'finished_successfully', end_turn: !partial,
    content: { content_type: 'text', parts: [text] } }, conversation_id: CONVERSATION })}\n\n${partial ? '' : 'data: [DONE]\n\n'}` : '';
  p.emit('response', response({ status: 200, text: async () => sse }));
  await new Promise(resolve => setImmediate(resolve));
  return { p, capture };
}

test('the poll starts right after the stream closes without text, not after the silence window', async () => {
  await fixture(ENV, async f => {
    const { p, capture } = await closedTurn(f, { polls: at => polled(turn(at)) });
    assert.ok(capture.streamEndedAt, 'the close is recorded');
    const { output } = await logs(() => assert.rejects(
      f.chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'high' }), e => e.code === 'empty_turn'));
    assert.equal(p.pollTimes.length, 3);
    assert.ok(p.pollTimes[0] - NOW >= 5000 && p.pollTimes[0] - NOW < 7000, `first poll ${p.pollTimes[0] - NOW}ms after the close`);
    assert.ok(f.clock.now - NOW < 60000, `empty turn ${f.clock.now - NOW}ms after the close, before the 60s silence window`);
    assert.match(output, /\[bg-poll\] the response stream closed \d+s ago without answer text/);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
  });
});

test('an early poll keeps at least the response window as its budget', async () => {
  await fixture({ ...ENV, CHAT_COMPLETION_TIMEOUT_SEC: '200' }, async f => {
    const { p, capture } = await closedTurn(f, { polls: at => polled(turn(at), STREAMING) });
    await logs(() => assert.rejects(
      f.chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' }),
      e => e.code === 'timeout' && /within 200s after submit/.test(e.message)));
  });
});

test('a stream that closed with answer text does not start the poll', async () => {
  await fixture(ENV, async f => {
    const { p, capture } = await closedTurn(f, { text: 'streamed', polls: at => polled(turn(at)) });
    const { result } = await logs(() => f.chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'high' }));
    assert.equal(result.text, 'streamed');
    assert.equal(p.pollTimes.length, 0);
  });
});

test('without a conversation id the early window neither polls nor reloads', async () => {
  await fixture(ENV, async f => {
    const { p, capture } = await closedTurn(f, { id: null, polls: at => polled(turn(at)) });
    let reloadAt = null;
    p.reload = async () => { reloadAt = f.clock.now; p.actions.push('reload'); return response(); };
    await logs(() => assert.rejects(f.chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'high' })));
    assert.equal(p.pollTimes.length, 0);
    assert.ok(reloadAt === null || reloadAt - NOW >= 60000, `reload ${reloadAt - NOW}ms after the close`);
  });
});

test('a stream that closed with partial answer text waits for the silence window', async () => {
  await fixture(ENV, async f => {
    const { p, capture } = await closedTurn(f, { text: 'half', partial: true, polls: at => polled(turn(at)) });
    assert.equal(capture.snapshot().lastAssistantText, 'half', 'the partial text is in the capture');
    await logs(() => assert.rejects(f.chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'high' })));
    assert.ok(p.pollTimes.length === 0 || p.pollTimes[0] - NOW >= 60000, `first poll ${p.pollTimes[0] - NOW}ms after the close`);
  });
});

test('a POST refused after submit (server_error) is not resent', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, status: 503, ...frozen }, { id: SECOND, poll: at => polled(turn(at, 'x')) }]);
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }),
      e => e.code === 'server_error'));
    assert.equal(p.sends, 1);
    assert.doesNotMatch(output, /empty turn retry/);
  });
});

test('the resend opens a new chat even when the caller asked to reuse the chat', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, poll: (at, id) => polled(turn(at, id === SECOND ? 'fresh' : 'old')) }]);
    const goto = p.goto.bind(p);
    const visits = [];
    p.goto = async url => { visits.push({ url, sends: p.sends }); return goto(url); };
    const { result } = await logs(() => f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW, reuseChat: true }));
    assert.equal(result.text, 'fresh');
    assert.ok(visits.some(v => v.sends === 1 && v.url === 'https://chatgpt.com'), JSON.stringify(visits));
  });
});

test('a resend without a conversation poll still ends at the request deadline', async () => {
  await fixture({ ...ENV, CHAT_REQUEST_BUDGET_SEC: '300', CHAT_EMPTY_TURN_RETRY_MIN_SEC: '60' }, async f => {
    f.clock.now = NOW;
    // The resend stays on the new-chat URL with its stream open and the page ticking: only the
    // response window (360 s) and its extension could end it — both must yield to the budget.
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, stream: 'open', poll: at => polled(turn(at)) }]);
    const base = p.evaluate.bind(p);
    p.evaluate = async (fn, arg) => {
      if (String(fn).includes('assistantCount: assistantMessages.length') && p.sends === 2) {
        return { assistantCount: 0, lastAssistantText: '', bodyTail: `thinking ${f.clock.now}` };
      }
      return base(fn, arg);
    };
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }), e => e.code === 'timeout'));
    assert.equal(p.sends, 2);
    assert.ok(f.clock.now - NOW <= 302000 && f.clock.now - NOW >= 299000, `ended ${f.clock.now - NOW}ms after the request arrived`);
    assert.match(output, /empty turn retry 1\/1: failed \(timeout\)/);
    assert.doesNotMatch(output, /still generating — extending/, 'no extension is offered at the request deadline');
  });
});

test('the extension of the response window stops at the request deadline', async () => {
  await fixture({ ...ENV, CHAT_REQUEST_BUDGET_SEC: '300', CHAT_EMPTY_TURN_RETRY_MIN_SEC: '60',
    CHAT_COMPLETION_TIMEOUT_SEC: '100', CHAT_COMPLETION_RETRY_TIMEOUT_SEC: '300' }, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, stream: 'open', poll: at => polled(turn(at)) }]);
    const base = p.evaluate.bind(p);
    p.evaluate = async (fn, arg) => {
      if (String(fn).includes('assistantCount: assistantMessages.length') && p.sends === 2) {
        return { assistantCount: 0, lastAssistantText: '', bodyTail: `thinking ${f.clock.now}` };
      }
      return base(fn, arg);
    };
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }), e => e.code === 'timeout'));
    assert.match(output, /still generating — extending/, 'the base window ended before the budget');
    assert.ok(f.clock.now - NOW <= 302000, `ended ${f.clock.now - NOW}ms after the request arrived`);
  });
});

test('a silent-window poll of the resend is capped by the request deadline too', async () => {
  await fixture({ ...ENV, CHAT_REQUEST_BUDGET_SEC: '300', CHAT_EMPTY_TURN_RETRY_MIN_SEC: '60', CHAT_BG_POLL_SEC: '1000', CHAT_STALL_WINDOW_SEC: '100' }, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, stream: 'partial', poll: at => polled(turn(at), STREAMING) }]);
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }), e => e.code === 'timeout'));
    assert.match(output, /no rendered text for \d+s and the response stream is closed/);
    assert.ok(f.clock.now - NOW <= 302000, `ended ${f.clock.now - NOW}ms after the request arrived`);
  });
});

test('a conversation GET of the abandoned turn that resolves during the resend is not its answer', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    let release;
    const late = new Promise(resolve => { release = resolve; });
    let p;
    p = scripted(f, [
      // Read by the app during the first turn, body delivered only once the resend runs.
      { id: CONVERSATION, ...frozen, onSend: page => page.emit('response', response({ method: 'GET',
        url: `/backend-api/conversation/${CONVERSATION}`, ct: 'application/json', data: undefined })) },
      // The body arrives while the resend already waits (its first poll); the resend's own
      // answer only on the next poll.
      { id: SECOND, poll: (at, id) => {
        if (id !== SECOND) return polled(turn(p.sentAt[0], 'LATE'));
        if (p.polls.filter(x => x.id === SECOND).length === 1) {
          const data = turn(p.sentAt[0], 'LATE');
          data.conversation_id = CONVERSATION;
          release(data);
          return polled(turn(at), STREAMING);
        }
        return polled(turn(at, 'retry answer'));
      } },
    ]);
    const emit = p.emit.bind(p);
    p.emit = (event, res) => {
      if (event === 'response' && res.request().method() === 'GET') res.json = () => late;
      return emit(event, res);
    };
    const { result } = await logs(() => f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }));
    assert.equal(result.text, 'retry answer');
    assert.equal(result.conversation_id, SECOND);
  });
});

test('a resend resumed after a pool restart keeps the request deadline', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: SECOND, poll: at => polled(turn(at), STREAMING) }]);
    const state = { used: 0, emptyTurnUsed: 1, emptyTurnDeadlineAt: NOW + 100000 };
    await logs(() => assert.rejects(f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW - 500000,
      stallRetryState: state }), e => e.code === 'timeout'));
    assert.equal(p.sends, 1);
    assert.ok(f.clock.now - NOW <= 102000, `ended ${f.clock.now - NOW}ms, deadline 100s`);
  });
});

test('a resend is not sent when preparing it ate the budget', async () => {
  await fixture(ENV, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: SECOND, poll: at => polled(turn(at, 'x')) }]);
    const state = { used: 0, emptyTurnUsed: 1, emptyTurnDeadlineAt: NOW + 50000 };
    const { output } = await logs(() => assert.rejects(f.chat.completeText('hello', { thinkingMode: 'instant', stallRetryState: state }),
      e => e.code === 'empty_turn' && /resend was not sent: only \d+s of the request budget left/.test(e.message)));
    assert.equal(p.sends, 0);
    assert.match(output, /empty turn retry 1\/1: skipped, .*the resend was not sent/);
    assert.doesNotMatch(output, /empty turn retry 1\/1: failed/);
  });
});

test('a hung poll of a resend gives up at the request deadline, not after its own timeout', async () => {
  await fixture(ENV, async f => {
    const { p, capture } = await closedTurn(f, { polls: () => new Promise(() => {}) });
    const t0 = performance.now();
    await logs(() => assert.rejects(f.chat._test.waitAndExtractText(p, empty(),
      { capture, thinkingMode: 'instant', deadlineAt: NOW + 7000 }), e => e.code === 'timeout'));
    const took = performance.now() - t0;
    assert.ok(took < 10000, `a 2s remainder took ${Math.round(took)}ms of real time`);
  });
});

test('a slow conversation poll is cut at the remaining budget', async () => {
  const chat = require('../src/chatgpt');
  const hung = { evaluate: () => new Promise(() => {}) };
  const t0 = performance.now();
  const r = await chat._test.pollConversation(hung, CONVERSATION, NOW / 1000, 1200);
  const took = performance.now() - t0;
  assert.equal(r.kind, 'error');
  assert.match(r.detail, /poll deadline/);
  assert.ok(took >= 1100 && took < 5000, `waited ${Math.round(took)}ms for a 1.2s budget`);
});

test('the request start time reaches completeText from both text routes', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/images'), 'utf8');
  const calls = src.split('completeText(prompt, {').slice(1).map(s => s.slice(0, s.indexOf('}))')));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(call, /requestStartedAt: startedAt/);
});

// Instant resend (2.16.9): when the same-mode resend is empty too, one more resend goes out in
// instant mode, under the same rules and the same request budget. Default config.
const ENV_INSTANT = { ...ENV, CHAT_EMPTY_TURN_INSTANT_RETRY: undefined };
// The composer pill shows levels[k] before send k; the adapter only clicks when it differs from
// its target, which the fixture page cannot do, so a wrong target fails the turn.
function withPill(p, levels) {
  const base = p.evaluate;
  p.evaluate = async (fn, arg) => {
    if (String(fn).includes('captionSrc') && arg?.matchers) {
      const level = levels[Math.min(p.sends, levels.length - 1)];
      return { level, pillText: level };
    }
    return base(fn, arg);
  };
  return p;
}
const MEDIUM_THEN_INSTANT = ['medium', 'medium', 'instant'];
const targets = output => [...output.matchAll(/Intelligence pill before: .*\(target=(\w+)\)/g)].map(m => m[1]);

test('a second empty turn is resent once more, in instant mode, and that resend answers', async () => {
  await fixture(ENV_INSTANT, async f => {
    f.clock.now = NOW;
    const THIRD = '33333333-4444-4555-8666-777777777777';
    const p = withPill(scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, ...frozen },
      { id: THIRD, poll: (at, id) => polled(id === THIRD ? turn(at, 'fast answer') : turn(at)) }]), MEDIUM_THEN_INSTANT);
    const state = { used: 0 };
    let finished = 0;
    const { result, output } = await logs(() => f.chat.completeText('hello', {
      thinkingMode: 'standard', requestStartedAt: NOW, stallRetryState: state, onAttemptFinished: () => { finished++; } }));
    assert.equal(result.text, 'fast answer');
    assert.equal(result.conversation_id, THIRD);
    assert.equal(p.sends, 3, 'the original send, one same-mode resend, one instant resend');
    assert.equal(state.emptyTurnUsed, 2);
    assert.equal(finished, 2, 'each abandoned attempt releases its pacing slot');
    assert.deepEqual(targets(output), ['medium', 'medium', 'instant'], 'only the last resend switches to instant');
    assert.equal(result.applied.thinking_mode, 'instant');
    assert.equal(result.applied.thinking, false);
    assert.equal(result.applied.requested_verified, false);
    assert.deepEqual(result.applied.thinking_fallback, { from: 'standard', to: 'instant', reason: 'empty_turn', verified: true });
    assert.match(output, /\[chatgpt\] empty turn retry 1\/2: resending in a new chat, \d+s of the request budget left/);
    assert.match(output, /\[chatgpt\] empty turn retry 1\/2: failed \(empty_turn\)/);
    assert.match(output, /\[chatgpt\] empty turn retry 2\/2 \(instant\): resending in a new chat, \d+s of the request budget left/);
    assert.match(output, /\[chatgpt\] empty turn retry 2\/2 \(instant\): answered \(11 chars/);
    assert.deepEqual([...new Set(p.polls.filter(x => x.at >= p.sentAt[2]).map(x => x.id))], [THIRD],
      'neither abandoned conversation is polled again');
  });
});

test('an instant resend that is empty too ends as empty_turn, with no fourth send', async () => {
  await fixture(ENV_INSTANT, async f => {
    f.clock.now = NOW;
    const p = withPill(scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, ...frozen }, { id: SECOND, ...frozen },
      { id: SECOND, poll: at => polled(turn(at, 'never')) }]), MEDIUM_THEN_INSTANT);
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'standard', requestStartedAt: NOW }), e => e.code === 'empty_turn'));
    assert.equal(p.sends, 3);
    assert.match(output, /empty turn retry 2\/2 \(instant\): failed \(empty_turn\)/);
  });
});

test('the instant resend is skipped when the request budget left is below the minimum', async () => {
  await fixture({ ...ENV_INSTANT, CHAT_REQUEST_BUDGET_SEC: '600', CHAT_EMPTY_TURN_RETRY_MIN_SEC: '180' }, async f => {
    f.clock.now = NOW;
    const p = withPill(scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, ...frozen },
      { id: SECOND, poll: at => polled(turn(at, 'never')) }]), MEDIUM_THEN_INSTANT);
    // ~36 s per empty attempt: 600 - 380 - 36 ≥ 180 for the first resend, < 180 for the second.
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'standard', requestStartedAt: NOW - 380000 }), e => e.code === 'empty_turn'));
    assert.equal(p.sends, 2);
    assert.match(output, /empty turn retry 1\/2: resending/);
    assert.match(output, /empty turn retry 2\/2 \(instant\): skipped, \d+s of the request budget left, need 180s/);
    assert.doesNotMatch(output, /2\/2 \(instant\): resending/);
  });
});

test('the instant resend waits no longer than the request deadline', async () => {
  await fixture({ ...ENV_INSTANT, CHAT_REQUEST_BUDGET_SEC: '300', CHAT_EMPTY_TURN_RETRY_MIN_SEC: '60' }, async f => {
    f.clock.now = NOW;
    const p = withPill(scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, ...frozen },
      { id: SECOND, poll: at => polled(turn(at), STREAMING) }]), MEDIUM_THEN_INSTANT);
    const { output } = await logs(() => assert.rejects(
      f.chat.completeText('hello', { thinkingMode: 'standard', requestStartedAt: NOW }), e => e.code === 'timeout'));
    assert.equal(p.sends, 3);
    assert.ok(f.clock.now - NOW <= 302000, `ended ${f.clock.now - NOW}ms after the request arrived, budget 300s`);
    assert.match(output, /empty turn retry 2\/2 \(instant\): failed \(timeout\)/);
  });
});

test('a continuation gets neither resend with the instant resend on', async () => {
  await fixture(ENV_INSTANT, async f => {
    f.clock.now = NOW;
    const p = withPill(scripted(f, [{ id: CONVERSATION, ...frozen }, { id: CONVERSATION, poll: at => polled(turn(at, 'x')) }]), ['medium']);
    const { output } = await logs(() => assert.rejects(f.chat.completeText('hello', {
      thinkingMode: 'standard', conversationId: CONVERSATION, requestStartedAt: NOW }), e => e.code === 'empty_turn'));
    assert.equal(p.sends, 1);
    assert.doesNotMatch(output, /empty turn retry/);
  });
});

test('an instant resend resumed after a pool restart stays instant and is the last one', async () => {
  await fixture(ENV_INSTANT, async f => {
    f.clock.now = NOW;
    const p = withPill(scripted(f, [{ id: SECOND, ...frozen }, { id: SECOND, poll: at => polled(turn(at, 'never')) }]), ['instant']);
    const state = { used: 0, emptyTurnUsed: 2, emptyTurnDeadlineAt: NOW + 400000 };
    const { output } = await logs(() => assert.rejects(f.chat.completeText('hello', {
      thinkingMode: 'standard', requestStartedAt: NOW - 200000, stallRetryState: state }), e => e.code === 'empty_turn'));
    assert.equal(p.sends, 1);
    assert.deepEqual(targets(output), ['instant']);
    assert.match(output, /empty turn retry 2\/2 \(instant\): failed \(empty_turn\)/);
  });
});

test('a caller who asked for instant gets no fallback marker from the instant resend', async () => {
  await fixture(ENV_INSTANT, async f => {
    f.clock.now = NOW;
    const p = scripted(f, [{ id: CONVERSATION, ...frozen }, { id: SECOND, ...frozen },
      { id: SECOND, poll: at => polled(turn(at, 'fast')) }]);
    const { result } = await logs(() => f.chat.completeText('hello', { thinkingMode: 'instant', requestStartedAt: NOW }));
    assert.equal(p.sends, 3);
    assert.equal(result.applied.thinking_fallback, null);
    assert.equal(result.applied.requested_verified, true);
  });
});

test('a resend that was not sent for lack of budget does not start the instant resend', async () => {
  // A minimum below the 60 s send floor: without the guard the unsent resend would chain into
  // the instant one with the same thin budget.
  await fixture({ ...ENV_INSTANT, CHAT_EMPTY_TURN_RETRY_MIN_SEC: '30' }, async f => {
    f.clock.now = NOW;
    const p = withPill(scripted(f, [{ id: SECOND, poll: at => polled(turn(at, 'x')) }]), ['medium']);
    const state = { used: 0, emptyTurnUsed: 1, emptyTurnDeadlineAt: NOW + 50000 };
    const { output } = await logs(() => assert.rejects(f.chat.completeText('hello', {
      thinkingMode: 'standard', requestStartedAt: NOW - 550000, stallRetryState: state }), e => e.code === 'empty_turn'));
    assert.equal(p.sends, 0);
    assert.equal(state.emptyTurnUsed, 1);
    assert.match(output, /empty turn retry 1\/2: skipped, .*the resend was not sent/);
    assert.doesNotMatch(output, /2\/2 \(instant\)/);
  });
});
