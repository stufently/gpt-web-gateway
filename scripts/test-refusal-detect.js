// Regression test for imageOutcomePredicate (src/chatgpt.js) — UI refusal banners,
// typographic apostrophes, and user-turn image filtering (edit-flow false success).
// Run with: docker run --rm -v $PWD:/app -w /app node:20-slim node scripts/test-refusal-detect.js
const assert = require('node:assert');

// ---- Minimal DOM stub ------------------------------------------------------
// imageOutcomePredicate uses: document.body.innerText,
// querySelectorAll('div[id^="image-"]'), ('img'), ('[data-message-author-role="assistant"]'),
// plus el.closest('[data-message-author-role="user"]') on image results.
function makeElement({ id, src, innerText, naturalWidth = 1024, naturalHeight = 1024, inUserTurn = false }) {
  return {
    id,
    src,
    innerText,
    naturalWidth,
    naturalHeight,
    closest: (sel) => (sel.includes('user') && inUserTurn ? {} : null),
  };
}

function withDocument({ bodyText, imageDivs = [], imgs = [], assistantTurns = [] }, fn) {
  global.document = {
    body: { innerText: bodyText },
    querySelectorAll: (sel) => {
      if (sel.includes('assistant')) return assistantTurns;
      if (sel.includes('img')) return imgs;
      return imageDivs;
    },
  };
  try {
    return fn();
  } finally {
    delete global.document;
  }
}

const { _test } = require('../src/chatgpt');
const { imageOutcomePredicate } = _test;

const EMPTY_PREV = { previousImageIds: [], previousLargeImages: [], previousTailText: 'old tail before submit' };

// Verbatim refusal banners from owner screenshots 2026-07-16 (typographic apostrophe,
// as ChatGPT renders it).
const REFUSAL_FRAUD = 'We’re so sorry, but the image we created may violate our guardrails around potential fraudulent or scam activity. If you think we got it wrong, please retry or edit your prompt.';
const REFUSAL_POLICY = 'We’re so sorry, but the prompt may violate our content policies. If you think we got it wrong, please retry or edit your prompt.';
const REFUSAL_NUDITY = 'We’re so sorry, but the image we created may violate our guardrails around nudity, sexuality, or erotic content. If you think we got it wrong, please retry or edit your prompt.';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} → ${JSON.stringify(actual)} (want ${JSON.stringify(expected)})`);
}

// 1-3. Each screenshot banner must classify as 'policy' (→ 422 policy_violation).
for (const [name, banner] of [
  ['fraud/scam guardrails banner', REFUSAL_FRAUD],
  ['content policies banner', REFUSAL_POLICY],
  ['nudity/sexuality guardrails banner', REFUSAL_NUDITY],
]) {
  const outcome = withDocument(
    { bodyText: `chat history above\n${banner}` },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check(name, outcome, 'policy');
}

// 4. Edit flow: the user's own uploaded image (new large img in a USER turn) plus a
// refusal banner must yield 'policy', NOT a false 'success'.
{
  const outcome = withDocument(
    {
      bodyText: `uploaded photo\n${REFUSAL_NUDITY}`,
      imgs: [makeElement({ src: 'blob:user-upload', inUserTurn: true })],
    },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('edit flow: user upload + refusal ≠ success', outcome, 'policy');
}

// 5. User-turn image alone (refusal not rendered yet) must NOT be success — keep polling.
{
  const outcome = withDocument(
    { bodyText: 'old tail before submit', imgs: [makeElement({ src: 'blob:user-upload', inUserTurn: true })] },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('edit flow: user upload alone keeps polling', outcome, false);
}

// 6. A new ASSISTANT image is still success.
{
  const outcome = withDocument(
    {
      bodyText: 'some chat text',
      imageDivs: [makeElement({ id: 'image-abc123' })],
      imgs: [makeElement({ src: 'blob:generated' })],
    },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('assistant image → success', outcome, 'success');
}

// 6a. "Image created" typed by the USER (it is in the body tail, inside the user turn) is not
// a success signal once the assistant turn is readable — only the assistant's own text counts.
{
  const outcome = withDocument(
    {
      bodyText: 'Draw a sign that says "Image created"\nThinking…',
      assistantTurns: [{ innerText: 'Thinking…' }],
    },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('"image created" in the user prompt keeps polling', outcome, false);
}
{
  const outcome = withDocument(
    { bodyText: 'Draw a cat\nImage created', assistantTurns: [{ innerText: 'Image created' }] },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('"image created" from the assistant → success', outcome, 'success');
}

// 6b. canvasExtractInPage must never hand back an image that was on the page before submit
// (a previous turn's result) when nothing new has rendered yet.
function withCanvasDocument({ imgs = [], containers = {} }, fn) {
  global.document = {
    querySelectorAll: () => imgs,
    getElementById: (id) => containers[id] || null,
    createElement: () => ({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => 'data:image/png;base64,QUJD',
    }),
  };
  try { return fn(); } finally { delete global.document; }
}
const { canvasExtractInPage } = _test;
{
  const old = { ...makeElement({ src: 'blob:previous-turn' }), complete: true };
  const r = withCanvasDocument({ imgs: [old] },
    () => canvasExtractInPage({ targetId: null, prevSrcs: ['blob:previous-turn'] }));
  check('canvas: only a pre-submit image on the page → not returned', !!r.error && !r.b64, true);
}
{
  const old = { ...makeElement({ src: 'blob:previous-turn' }), complete: true };
  const fresh = { ...makeElement({ src: 'blob:this-turn' }), complete: true };
  const r = withCanvasDocument({ imgs: [old, fresh] },
    () => canvasExtractInPage({ targetId: null, prevSrcs: ['blob:previous-turn'] }));
  check('canvas: a new image is extracted', r.src, 'blob:this-turn');
}
{
  const inside = { ...makeElement({ src: 'blob:re-rendered' }), complete: true };
  const container = { querySelectorAll: () => [inside] };
  const r = withCanvasDocument({ imgs: [inside], containers: { 'image-new': container } },
    () => canvasExtractInPage({ targetId: 'image-new', prevSrcs: ['blob:re-rendered'] }));
  check('canvas: inside the new container a seen src is still this turn', r.src, 'blob:re-rendered');
}

// 7. reuseChat: an OLD refusal already present in the pre-submit tail must not abort
// the new turn (banner is not "new") — both content-policy and guardrails variants.
for (const [name, banner] of [
  ['stale content-policies refusal', REFUSAL_POLICY],
  ['stale guardrails refusal', REFUSAL_FRAUD],
]) {
  const bodyText = `history\n${banner}`;
  const outcome = withDocument(
    { bodyText },
    () => imageOutcomePredicate({
      previousImageIds: [],
      previousLargeImages: [],
      previousTailText: bodyText.slice(-500),
    })
  );
  check(`reuseChat: ${name} keeps polling`, outcome, false);
}

// 8. Generic "We're so sorry" without policy/guardrail wording → 'refused'.
{
  const outcome = withDocument(
    { bodyText: "chat\nWe’re so sorry, but we can’t help with that request right now." },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check("generic so-sorry → refused", outcome, 'refused');
}

// 9. Straight-apostrophe variant also detected (defensive).
{
  const outcome = withDocument(
    { bodyText: "chat\nWe're so sorry, but the prompt may violate our content policies." },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('straight apostrophe variant', outcome, 'policy');
}

// 10. Success phrase still works and refusal patterns don't eat it.
{
  const outcome = withDocument(
    { bodyText: 'chat history\nImage created' },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check("'Image created' → success", outcome, 'success');
}

// 11. Refusal banner WINS over a simultaneous success signal (ChatGPT can render an
// image and then block it — "the image we created may violate…").
{
  const outcome = withDocument(
    {
      bodyText: `chat\nImage created\n${REFUSAL_FRAUD}`,
      imageDivs: [makeElement({ id: 'image-new1' })],
      imgs: [makeElement({ src: 'blob:generated' })],
    },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('refusal banner beats simultaneous success', outcome, 'policy');
}

// 12. Policy-looking words in the USER's own prompt must not trigger detection when
// the assistant turn is readable and benign (prompt lands in the body tail after submit).
{
  const outcome = withDocument(
    {
      bodyText: 'chat\nEdit this image: remove the copyright watermark text\nOn it — working…',
      assistantTurns: [makeElement({ innerText: 'On it — working…' })],
    },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check("user prompt with 'copyright' does not false-trigger", outcome, false);
}

// 13. Refusal detected when scoped to an assistant turn (turn roles readable).
{
  const outcome = withDocument(
    {
      bodyText: `chat\nsome prompt\n${REFUSAL_NUDITY}`,
      assistantTurns: [makeElement({ innerText: REFUSAL_NUDITY })],
    },
    () => imageOutcomePredicate(EMPTY_PREV)
  );
  check('assistant-scoped refusal → policy', outcome, 'policy');
}

// ---- Outcome → error mapping ----------------------------------------------
// Everything above asserts WHICH outcome the DOM shows. These assert what
// waitAndExtractImage turns that outcome into: the code the client receives and, through it,
// whether the client is told to retry. That half had no test, and 2.10.0 shipped a regression
// straight through the gap — `errorMsgs` read `limitKind` from an object literal built above
// its own `let`, so every non-success outcome threw
// `Cannot access 'limitKind' before initialization` and reached the caller as a *retryable*
// server_error. A content refusal was advertised as worth retrying for a day.
const { shouldRetryKind } = require('../src/metrics');
const { tierAvailability } = require('../src/chatgpt-tiers');

// A non-success outcome throws long before any image work, so the page double needs only the
// predicate's verdict and one text read.
function makePage(outcome, pageText) {
  return {
    waitForFunction: async () => ({ jsonValue: async () => outcome }),
    evaluate: async () => pageText,
  };
}

async function outcomeError(outcome, { pageText = '', thinkingMode = 'instant' } = {}) {
  try {
    await _test.waitAndExtractImage(makePage(outcome, pageText), undefined, { thinkingMode });
  } catch (e) {
    return e;
  }
  return null;
}

(async () => {
  // 14. Content policy → 422 policy_violation, and never retry it.
  {
    const err = await outcomeError('policy');
    check('policy → policy_violation', err && err.code, 'policy_violation');
    check('policy is not retryable', shouldRetryKind(err && err.code), false);
  }
  // 15. Plain refusal → refused, also terminal.
  {
    const err = await outcomeError('refused');
    check('refused → refused', err && err.code, 'refused');
    check('refused is not retryable', shouldRetryKind(err && err.code), false);
  }
  // 16. A limit with no Pro notice is the account-wide rate limit.
  {
    const err = await outcomeError('limit', { pageText: 'You have reached the limit for images' });
    check('plain limit → rate_limit', err && err.code, 'rate_limit');
  }
  // 17. A Pro-quota notice is one tier being out, NOT the gateway being rate-limited —
  // that distinction is the whole point of 2.10.0 and the reason limitKind exists.
  {
    tierAvailability.markAvailable('pro');
    const err = await outcomeError('limit', {
      pageText: "You've reached your Pro limit",
      thinkingMode: 'pro',
    });
    check('pro-quota notice → tier_limit', err && err.code, 'tier_limit');
    check('...pro is memoized as unavailable', tierAvailability.isCoolingDown('pro'), true);
    check('...and it is not a global rate_limit', (err && err.code) === 'rate_limit', false);
    tierAvailability.markAvailable('pro');
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll refusal-detect tests passed.');
})();
