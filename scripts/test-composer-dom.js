// Composer selectors after the 2026-09-26 chatgpt.com redesign (2.14.5). The editor lost its
// `#prompt-textarea` id, attachment chips lost their "Remove file" label and the tier pill
// became a dedicated trigger — every one of those took the gateway down.
const assert = require('assert');
const dom = require('../src/composer-dom');

let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS: ${name}`); passed++; }

(async () => {
  await test('the current editor markup is the PRIMARY composer selector', async () => {
    assert.match(dom.COMPOSER_SELECTORS[0], /data-chatgpt-composer.*contenteditable/);
    assert.ok(dom.COMPOSER_SELECTORS.includes('#prompt-textarea'), 'legacy #prompt-textarea kept as fallback');
  });

  await test('a bare textarea no longer counts as a ready composer', async () => {
    // `textarea:visible` let the page-load check pass on markup the typing code could not use.
    for (const s of dom.COMPOSER_VISIBLE_SEL.split(', ')) {
      assert.notStrictEqual(s.replace(/:visible$/, ''), 'textarea', `bare textarea in ${dom.COMPOSER_VISIBLE_SEL}`);
      assert.ok(s.endsWith(':visible'), s);
    }
  });

  await test('send / hint selectors keep the routing tokens the page doubles rely on', async () => {
    assert.ok(dom.SEND_BUTTON_SEL.includes('send-button'));
    assert.ok(dom.SEND_BUTTON_SEL.includes('form[data-chatgpt-composer] button[type="submit"]'));
    assert.ok(dom.SYSTEM_HINT_SEL.includes('data-system-hint-type'));
  });

  await test('attachment chips are recognised by the new "Remove <filename>" label', async () => {
    assert.ok(dom.ATTACHMENT_REMOVE_SEL.includes('[data-composer-attachments] button[aria-label^="Remove"]'));
  });

  await test('stripTierCaption drops the trigger caption but keeps the level', async () => {
    assert.strictEqual(dom.stripTierCaption('Thinking effort\n Medium'), 'Medium');
    assert.strictEqual(dom.stripTierCaption('Medium'), 'Medium');
    assert.strictEqual(dom.stripTierCaption('5.6 Sol Очень высокий'), '5.6 Sol Очень высокий');
    assert.strictEqual(dom.stripTierCaption(''), '');
  });

  await test('readComposerText reads ProseMirror textContent', async () => {
    const loc = { textContent: async () => 'hello', inputValue: async () => { throw new Error('not an input'); } };
    assert.strictEqual(await dom.readComposerText(loc), 'hello');
  });

  await test('readComposerText reads a <textarea> through its value', async () => {
    const loc = { textContent: async () => '', inputValue: async () => 'typed' };
    assert.strictEqual(await dom.readComposerText(loc), 'typed');
  });

  await test('readComposerText survives a locator without inputValue', async () => {
    assert.strictEqual(await dom.readComposerText({ textContent: async () => '' }), '');
  });

  console.log(`All ${passed} composer-dom tests passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
