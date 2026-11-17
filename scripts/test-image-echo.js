// Regression test: an image edit must never return the caller's own upload as the result.
// 2026-11-17: thinking-mode edits logged "Image generation detected" the instant the prompt was
// sent (the sent attachment counted as a new image), then "No new image container found —
// falling back to last in DOM" and returned the input picture (sha result == sha input).
// Covers the echo guard in imageOutcomePredicate and canvasExtractInPage, the Node-side byte
// check, and the honest `no_new_image` error once the result wait runs out.
// Run with: docker run --rm -u 1002:1002 -v $PWD:/app -w /app node:24-slim node scripts/test-image-echo.js
process.env.IMAGE_RESULT_WAIT_SEC = '1';
process.env.RENDER_WAIT_SEC = '1';
const assert = require('node:assert');
const crypto = require('node:crypto');

// ---- DOM stub ---------------------------------------------------------------
// Images carry a 32x32 RGB thumbnail (`fp`) that the stub canvas hands back from getImageData,
// so the page-side fingerprint code runs for real. `inUserTurn` is false for the upload on
// purpose: the live failure is ChatGPT markup the user-turn filter does not recognise.
function makeImg({ src, fp, inUserTurn = false, naturalWidth = 1024, naturalHeight = 1024, complete = true }) {
  return { src, fp, naturalWidth, naturalHeight, complete, closest: (sel) => (sel.includes('user') && inUserTurn ? {} : null) };
}
function solid(r, g, b) {
  const out = [];
  for (let i = 0; i < 1024; i++) out.push(r, g, b);
  return out;
}
function rgbaOf(fp) {
  const d = new Uint8ClampedArray(1024 * 4);
  for (let i = 0; i < 1024; i++) {
    d[i * 4] = fp[i * 3]; d[i * 4 + 1] = fp[i * 3 + 1]; d[i * 4 + 2] = fp[i * 3 + 2]; d[i * 4 + 3] = 255;
  }
  return d;
}
function makeCanvas() {
  let drawn = null;
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (img) => { drawn = img; },
      getImageData: () => {
        if (!drawn || !drawn.fp) throw new Error('tainted canvas');
        return { data: rgbaOf(drawn.fp) };
      },
    }),
    toDataURL: () => `data:image/png;base64,${Buffer.from(`png:${drawn && drawn.src}`).toString('base64')}`,
  };
}
function installDocument({ bodyText = 'chat\nEdit this image: make it red', imgs = [], imageDivs = [] }) {
  delete globalThis.__gwEchoCache;
  global.document = {
    body: { innerText: bodyText },
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}),
    getElementById: (id) => imageDivs.find((d) => d.id === id) || null,
    querySelectorAll: (sel) => {
      if (sel.includes('assistant')) return [];
      if (sel.includes('img')) return imgs;
      return imageDivs;
    },
  };
}
function withDocument(dom, fn) {
  installDocument(dom);
  try { return fn(); } finally { delete global.document; }
}

const { _test } = require('../src/chatgpt');
const { imageOutcomePredicate, canvasExtractInPage, isUploadEcho } = _test;
const { classifyError, shouldRetryKind } = require('../src/metrics');

let failed = 0;
function check(name, actual, expected) {
  let ok = true;
  try { assert.deepStrictEqual(actual, expected); } catch { ok = false; }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} → ${JSON.stringify(actual)} (want ${JSON.stringify(expected)})`);
}

const INPUT_FP = solid(200, 30, 30);
// ChatGPT re-encodes the upload: same picture, a couple of levels off here and there.
const INPUT_REENCODED_FP = INPUT_FP.map((v, i) => (i % 7 === 0 ? Math.min(255, v + 3) : v));
const RESULT_FP = solid(30, 30, 200);
// A real edit that keeps most of the picture: a 4x4 patch (1/64 of the area) changed.
const SMALL_EDIT_FP = INPUT_FP.map((v, i) => {
  const px = Math.floor(i / 3);
  const x = px % 32; const y = Math.floor(px / 32);
  if (x < 4 && y < 4) return (i % 3 === 2) ? 255 : 0;
  return v;
});
// Codex review: removing a 48x48 mark from a 1024x1024 picture. At 32x32 it is about one cell,
// shifted by ~60 levels; the MEAN delta over the thumbnail is under 0.2 — a mean threshold took
// this legitimate result for the upload.
const TINY_EDIT_FP = INPUT_FP.map((v, i) => (Math.floor(i / 3) === 500 ? Math.max(0, v - 60) : v));

const PREV = { previousImageIds: [], previousLargeImages: [], previousTailText: 'old tail before submit' };
const ECHO_ARGS = { echoSrcs: [], echoFingerprints: [INPUT_FP], echoMaxDiff: 10 };

// ---- imageOutcomePredicate ----------------------------------------------------
// 1. THE live failure: the sent upload renders as a large image OUTSIDE recognised user-turn
// markup. With its fingerprint known it must not count as a generation result.
check('predicate: re-encoded upload (no user-turn marker) is not success',
  withDocument({ imgs: [makeImg({ src: 'https://chatgpt.com/backend-api/estuary/content?id=file_in', fp: INPUT_REENCODED_FP })] },
    () => imageOutcomePredicate({ ...PREV, ...ECHO_ARGS })),
  false);
// 2. Same, recognised by src (it appeared right after submit) even without a fingerprint.
check('predicate: upload src seen after submit is not success',
  withDocument({ imgs: [makeImg({ src: 'blob:sent-upload' })] },
    () => imageOutcomePredicate({ ...PREV, echoSrcs: ['blob:sent-upload'], echoFingerprints: [], echoMaxDiff: 10 })),
  false);
// 3. Upload + a genuinely new result → success.
check('predicate: real result next to the upload is success',
  withDocument({ imgs: [makeImg({ src: 'blob:upload', fp: INPUT_FP }), makeImg({ src: 'blob:result', fp: RESULT_FP })] },
    () => imageOutcomePredicate({ ...PREV, ...ECHO_ARGS })),
  'success');
// 4. A real edit that changes only a small region must still count as a result.
check('predicate: small-region edit is not mistaken for the upload',
  withDocument({ imgs: [makeImg({ src: 'blob:result', fp: SMALL_EDIT_FP })] },
    () => imageOutcomePredicate({ ...PREV, ...ECHO_ARGS })),
  'success');
// 5. No echo context (plain generation): behaviour unchanged, any new large image is success.
check('predicate: without echo context a new image is success',
  withDocument({ imgs: [makeImg({ src: 'blob:result', fp: INPUT_FP })] },
    () => imageOutcomePredicate(PREV)),
  'success');
// 6. A tainted canvas (fingerprint unreadable) does not block a real result.
check('predicate: unreadable fingerprint does not block success',
  withDocument({ imgs: [makeImg({ src: 'blob:result' })] },
    () => imageOutcomePredicate({ ...PREV, ...ECHO_ARGS })),
  'success');

// ---- canvasExtractInPage ---------------------------------------------------------
// 7. Only the upload on the page → nothing to extract (was: the upload itself).
check('extract: page with only the upload yields no image',
  withDocument({ imgs: [makeImg({ src: 'blob:upload', fp: INPUT_REENCODED_FP })] },
    () => canvasExtractInPage({ targetId: null, prevSrcs: [], ...ECHO_ARGS }).error),
  'No new large image found yet');
// 8. Upload AFTER the result in DOM order (last-wins walk) → still the result.
check('extract: picks the result, skips the later upload',
  withDocument({ imgs: [makeImg({ src: 'blob:result', fp: RESULT_FP }), makeImg({ src: 'blob:upload', fp: INPUT_FP })] },
    () => canvasExtractInPage({ targetId: null, prevSrcs: [], ...ECHO_ARGS }).src),
  'blob:result');
// 9. Upload known by src only.
check('extract: upload src excluded',
  withDocument({ imgs: [makeImg({ src: 'blob:upload' })] },
    () => canvasExtractInPage({ targetId: null, prevSrcs: [], echoSrcs: ['blob:upload'], echoFingerprints: [], echoMaxDiff: 10 }).error),
  'No new large image found yet');

// ---- Node-side byte check ---------------------------------------------------------
const INPUT_BYTES = Buffer.from('fake png bytes of the uploaded file');
const INPUT_SHA = crypto.createHash('sha256').update(INPUT_BYTES).digest('hex');
check('isUploadEcho: identical bytes', isUploadEcho(INPUT_BYTES.toString('base64'), [INPUT_SHA]), true);
check('isUploadEcho: different bytes', isUploadEcho(Buffer.from('other').toString('base64'), [INPUT_SHA]), false);
check('isUploadEcho: no shas', isUploadEcho(INPUT_BYTES.toString('base64'), []), false);

// ---- metrics / retry contract ---------------------------------------------------------
check('classifyError keeps no_new_image', classifyError('x', 'no_new_image'), 'no_new_image');
check('no_new_image is retryable', shouldRetryKind('no_new_image'), true);

// ---- waitAndExtractImage end to end with a page double -----------------------------------
// The predicate verdict is 'success'; every other evaluate is answered from the DOM stub, and
// canvasExtractInPage runs for real against it.
function makePage(dom) {
  return {
    waitForFunction: async () => ({ jsonValue: async () => 'success' }),
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    $: async () => null,
    evaluate: async (fn, args) => {
      installDocument(dom);
      try {
        if (fn === canvasExtractInPage) return fn(args);
        if (Array.isArray(args)) return fn(args); // new image-* containers vs the pre-submit ids
        return '';
      } finally { delete global.document; }
    },
  };
}
async function run(dom, echo, beforeState = { imageIds: [], largeImages: [], tailText: '' }) {
  try {
    return { result: await _test.waitAndExtractImage(makePage(dom), beforeState, { echo }) };
  } catch (e) {
    return { error: e };
  }
}

(async () => {
  // 10. Only the upload ever shows up → honest no_new_image, never the upload.
  {
    const { result, error } = await run(
      { imgs: [makeImg({ src: 'blob:upload', fp: INPUT_REENCODED_FP })] },
      { srcs: [], fingerprints: [INPUT_FP], shas: [] },
    );
    check('e2e: upload only → no result returned', result ? result.url : null, null);
    check('e2e: upload only → no_new_image', error && error.code, 'no_new_image');
  }
  // 11. Page guard blind (no fingerprint readable), but the extracted bytes equal the upload.
  {
    const uploadPng = Buffer.from('png:blob:upload');
    const sha = crypto.createHash('sha256').update(uploadPng).digest('hex');
    const { result, error } = await run(
      { imgs: [makeImg({ src: 'blob:upload', fp: INPUT_FP })] },
      { srcs: [], fingerprints: [], shas: [sha] },
    );
    check('e2e: byte-identical candidate rejected', result ? result.url : null, null);
    check('e2e: byte-identical candidate → no_new_image', error && error.code, 'no_new_image');
  }
  // 12. Upload plus the real result → the result.
  {
    const { result, error } = await run(
      { imgs: [makeImg({ src: 'blob:result', fp: RESULT_FP }), makeImg({ src: 'blob:upload', fp: INPUT_FP })] },
      { srcs: [], fingerprints: [INPUT_FP], shas: [] },
    );
    check('e2e: real result returned', result ? result.url : (error && error.message), 'blob:result');
  }
  // 13. A small-region edit goes through the production threshold (IMAGE_ECHO_MAX_DIFF), not
  // only the explicit one above: a loose default would reject legitimate edits as echoes.
  {
    const { result, error } = await run(
      { imgs: [makeImg({ src: 'blob:upload', fp: INPUT_FP }), makeImg({ src: 'blob:small-edit', fp: SMALL_EDIT_FP })] },
      { srcs: ['blob:upload'], fingerprints: [INPUT_FP], shas: [] },
    );
    check('e2e: small-region edit returned', result ? result.url : (error && error.message), 'blob:small-edit');
  }

  // 14. No NEW container, but an old one (previous turn) is on the page. The removed "last in
  // DOM" fallback targeted it, and the in-container relaxation handed out its picture even though
  // that src was seen before submit — answering with the previous turn's image.
  {
    const oldResult = makeImg({ src: 'blob:old-result', fp: RESULT_FP });
    const oldDiv = { id: 'image-old', closest: () => null, querySelectorAll: () => [oldResult] };
    const { result, error } = await run(
      { imgs: [oldResult, makeImg({ src: 'blob:upload', fp: INPUT_FP })], imageDivs: [oldDiv] },
      { srcs: ['blob:upload'], fingerprints: [INPUT_FP], shas: [] },
      { imageIds: ['image-old'], largeImages: ['blob:old-result'], tailText: '' },
    );
    check('e2e: old container is not a fallback target', result ? result.url : null, null);
    check('e2e: old container → no_new_image', error && error.code, 'no_new_image');
  }

  // 15. Codex review: a one-cell local edit goes through the production threshold.
  {
    const { result, error } = await run(
      { imgs: [makeImg({ src: 'blob:tiny-edit', fp: TINY_EDIT_FP }), makeImg({ src: 'blob:upload', fp: INPUT_FP })] },
      { srcs: [], fingerprints: [INPUT_FP], shas: [] },
    );
    check('e2e: one-cell local edit returned', result ? result.url : (error && error.message), 'blob:tiny-edit');
  }
  // 16. Codex review: with every upload fingerprinted the post-submit src snapshot is skipped —
  // a fast result already on the page must not be excluded by src alone.
  {
    const dom = { imgs: [makeImg({ src: 'blob:fast-result', fp: RESULT_FP })] };
    const page = makePage(dom);
    const before = { imageIds: [], largeImages: [], tailText: '' };
    const full = await _test.snapshotSentImages(page, before, { srcs: [], fingerprints: [INPUT_FP], shas: [], uploads: 1 });
    check('snapshot skipped when all uploads fingerprinted', full.srcs, []);
    const blind = await _test.snapshotSentImages(page, before, { srcs: [], fingerprints: [], shas: [], uploads: 1 });
    check('snapshot used when an upload has no fingerprint', blind.srcs, ['blob:fast-result']);
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll image-echo tests passed.');
})();
