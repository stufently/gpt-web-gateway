// Multi-line prompts on the per-key paths (2.14.4). keyboard.type() and pressSequentially()
// press Enter for '\n', and Enter in ChatGPT's composer SENDS the message: an edit with
// `aspect_ratio` ("...\n\nAspect ratio: 3:2.") went out without its hint line, the hint was
// left in the composer and the submit check failed — every edit with an aspect ratio, 100%.
const assert = require('assert');
const {
  _test: { typeAndSubmit, appendAspectRatioHint },
} = require('../src/chatgpt');

let passed = 0;

// A composer double that behaves like ChatGPT's: plain Enter sends whatever is in the editor
// as a user turn and clears it, Shift+Enter inserts a line break. textContent joins lines
// WITHOUT a separator, as ProseMirror does. keyboard.type / pressSequentially go through the
// same per-key model, so a '\n' inside them is a plain Enter, exactly like Playwright.
function composerDouble({ systemHint = false, fillLands = true, dropTail = false, loseSegment = null, stripListMarkers = false, prefix = '' } = {}) {
  const lines = [''];
  const sent = [];
  const keys = [];
  // stripListMarkers: a composer with markdown input rules keeps "- x" as a list item whose
  // textContent is just "x".
  const shown = (l) => (stripListMarkers ? l.replace(/^(?:[-*+>]|\d+[.)])(?: |$)/, '') : l);
  const content = () => prefix + lines.map(shown).join('');
  const sendNow = () => { sent.push(lines.join('\n')); lines.length = 0; lines.push(''); };
  const key = (k) => {
    keys.push(k);
    if (k === 'Enter') { if (content()) sendNow(); return; }
    if (k === 'Shift+Enter') { lines.push(''); return; }
    if (k.length === 1) lines[lines.length - 1] += k;
  };
  const typeChars = (t) => { for (const ch of t) key(ch === '\n' || ch === '\r' ? 'Enter' : ch); };
  const composer = {
    first: () => composer,
    waitFor: async () => {},
    count: async () => 0,
    fill: async (t) => { if (fillLands) { lines.length = 0; lines.push(...t.split('\n')); } },
    textContent: async () => content(),
    click: async () => {},
    press: async (k) => key(k),
    pressSequentially: async (t) => typeChars(t),
  };
  const hint = { first: () => hint, count: async () => (systemHint ? 1 : 0) };
  const send = {
    first: () => send,
    waitFor: async () => {},
    click: async () => { if (content()) sendNow(); },
  };
  const page = {
    evaluate: async (fn) => (String(fn).includes('data-message-author-role') ? sent.length : undefined),
    locator: (sel) => (sel.includes('data-system-hint-type') ? hint
      : sel.includes('send-button') ? send : composer),
    $: async () => null,
    keyboard: {
      press: async (k) => key(k),
      type: async (t) => {
        if (t === loseSegment) return;
        typeChars(t);
        if (dropTail) { lines.length = 1; }
      },
    },
    waitForTimeout: async () => {},
  };
  return { page, sent, keys };
}

async function test(name, fn) { await fn(); console.log(`PASS: ${name}`); passed++; }

(async () => {
  const edit = appendAspectRatioHint('Edit this image: make the sky orange', '3:2');

  await test('an edit with aspect_ratio is sent as ONE message with the hint in it', async () => {
    const { page, sent } = composerDouble();
    await typeAndSubmit(page, edit, true);
    assert.deepStrictEqual(sent, [edit]);
  });

  await test('no plain Enter while typing a multi-line prompt around attachments', async () => {
    const { page, keys } = composerDouble();
    await typeAndSubmit(page, 'line one\nline two\r\nline three', true);
    assert.ok(!keys.includes('Enter'), `plain Enter pressed: ${JSON.stringify(keys.filter((k) => k.length > 1))}`);
    assert.strictEqual(keys.filter((k) => k === 'Shift+Enter').length, 2);
  });

  await test('a multi-line chat prompt typed around a composer token is one message', async () => {
    const { page, sent, keys } = composerDouble({ systemHint: true });
    const text = 'first line\n\nsecond paragraph';
    await typeAndSubmit(page, text, false);
    assert.deepStrictEqual(sent, [text]);
    assert.ok(!keys.includes('Enter'));
  });

  await test('the per-key fallback after a failed fill keeps multi-line text in one message', async () => {
    const { page, sent, keys } = composerDouble({ fillLands: false });
    const text = 'Generate an image: a cat\n\nQuality: high.';
    await typeAndSubmit(page, text, false);
    assert.deepStrictEqual(sent, [text]);
    assert.ok(!keys.includes('Enter'));
  });

  await test('a prompt whose tail did not land is refused, not sent truncated', async () => {
    const { page, sent } = composerDouble({ dropTail: true });
    await assert.rejects(typeAndSubmit(page, edit, true),
      (e) => e.code === 'page_load_failed' && /partially/.test(e.message));
    assert.deepStrictEqual(sent, []);
  });

  await test('a tail that also occurs earlier in the prompt does not hide a lost last line', async () => {
    const { page, sent } = composerDouble({ dropTail: true });
    const text = 'Edit this image: keep the logo\nMake the background red\nkeep the logo';
    await assert.rejects(typeAndSubmit(page, text, true),
      (e) => e.code === 'page_load_failed' && /partially/.test(e.message));
    assert.deepStrictEqual(sent, []);
  });

  await test('a short lost last line is caught', async () => {
    const { page, sent } = composerDouble({ dropTail: true });
    await assert.rejects(typeAndSubmit(page, 'Describe the attached image in detail\nok', true),
      (e) => e.code === 'page_load_failed' && /partially/.test(e.message));
    assert.deepStrictEqual(sent, []);
  });

  await test('a short repeated tail does not hide the lost lines before it', async () => {
    const { page, sent } = composerDouble({ dropTail: true });
    await assert.rejects(typeAndSubmit(page, 'Edit this image: add labels YES\nNO\nYES', true),
      (e) => e.code === 'page_load_failed' && /partially/.test(e.message));
    assert.deepStrictEqual(sent, []);
  });

  await test('list markers the composer turns into formatting do not fail a prompt that landed', async () => {
    const { page, sent } = composerDouble({ stripListMarkers: true });
    const text = 'Edit this image:\n- make the sky orange\n1. keep the logo';
    await typeAndSubmit(page, text, true);
    assert.strictEqual(sent.length, 1);
  });

  await test('a lost last line after list items is caught', async () => {
    const { page, sent } = composerDouble({ loseSegment: 'ok' });
    await assert.rejects(typeAndSubmit(page, 'Edit this image:\n- a\n- b\nok', true),
      (e) => e.code === 'page_load_failed' && /partially/.test(e.message));
    assert.deepStrictEqual(sent, []);
  });

  await test('a repeated last line that was lost is caught (lines are matched in order)', async () => {
    const { page, sent } = composerDouble({ loseSegment: 'ok' });
    await assert.rejects(typeAndSubmit(page, 'Edit this image:\n- keep red\n- ok\nok', true),
      (e) => e.code === 'page_load_failed' && /partially/.test(e.message));
    assert.deepStrictEqual(sent, []);
  });

  await test('a trailing empty list item that became formatting is not a missing line', async () => {
    const { page, sent } = composerDouble({ stripListMarkers: true });
    await typeAndSubmit(page, 'Edit this image:\n- keep logo\n- ', true);
    assert.strictEqual(sent.length, 1);
  });

  await test('a single-line prompt keeps the head-probe check only', async () => {
    const { page, sent } = composerDouble();
    await typeAndSubmit(page, 'Edit this image: brighter', true);
    assert.deepStrictEqual(sent, ['Edit this image: brighter']);
  });

  await test('a lost line that looks like the next line\'s kept marker is caught', async () => {
    const { page, sent } = composerDouble({ loseSegment: '5' });
    await assert.rejects(typeAndSubmit(page, 'Edit this image: add these labels\n5\n5. keep the logo', true),
      (e) => e.code === 'page_load_failed' && /partially/.test(e.message));
    assert.deepStrictEqual(sent, []);
  });

  await test('list markers kept as plain text in the composer land too', async () => {
    const { page, sent } = composerDouble();
    const text = 'Edit this image:\n- make the sky orange\n1. keep the logo';
    await typeAndSubmit(page, text, true);
    assert.deepStrictEqual(sent, [text]);
  });

  await test('the same prompt with its marker turned into formatting lands', async () => {
    const { page, sent } = composerDouble({ stripListMarkers: true });
    await typeAndSubmit(page, 'Edit this image: add these labels\n5\n5. keep the logo', true);
    assert.strictEqual(sent.length, 1);
  });

  await test('a composer token before the typed text does not fail the check', async () => {
    const { page, sent } = composerDouble({ systemHint: true, prefix: 'Search' });
    await typeAndSubmit(page, 'line one\nline two', false);
    assert.strictEqual(sent.length, 1);
  });

  await test('a prompt with thousands of lines is checked without blowing the stack', async () => {
    const { page, sent } = composerDouble();
    const text = Array.from({ length: 3000 }, (_, i) => String(i % 10)).join('\n');
    await typeAndSubmit(page, text, true);
    assert.deepStrictEqual(sent, [text]);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
