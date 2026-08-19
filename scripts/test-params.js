// Contract tests for pure request parsing (src/params.js) — the deprecated web_search
// behavior and thinking-mode resolution. Run via `npm test`.
const assert = require('assert');
const { parseBool, envFlag, parseThinkingMode, parseWebSearchRequested, normalizeThinkingMode } = require('../src/params');

let passed = 0;
function ok(name, fn) {
  fn();
  console.log(`PASS: ${name}`);
  passed++;
}

ok('parseBool truthy/falsy forms', () => {
  for (const v of [true, 'true', '1', 'yes', 'on', 'TRUE ']) assert.strictEqual(parseBool(v), true, String(v));
  for (const v of [false, 'false', '0', 'no', '', undefined, null, 'off']) assert.strictEqual(parseBool(v), false, String(v));
});

ok('web_search accepted in snake_case and camelCase, echoed as requested', () => {
  assert.strictEqual(parseWebSearchRequested({ web_search: true }), true);
  assert.strictEqual(parseWebSearchRequested({ webSearch: 'true' }), true);
  assert.strictEqual(parseWebSearchRequested({ web_search: false }), false);
  assert.strictEqual(parseWebSearchRequested({}), false);
});

ok('web_search does NOT upgrade thinking mode (auto-upgrade removed)', () => {
  assert.strictEqual(parseThinkingMode({ thinking_mode: 'instant', web_search: true }), 'instant');
  assert.strictEqual(parseThinkingMode({ thinking_mode: 'instant', webSearch: true }), 'instant');
});

ok('thinking_mode resolution and legacy aliases', () => {
  assert.strictEqual(parseThinkingMode({ thinking_mode: 'extended' }), 'extended');
  assert.strictEqual(parseThinkingMode({ reasoning_effort: 'standard' }), 'standard');
  assert.strictEqual(parseThinkingMode({ thinking: true }), 'standard');
  assert.strictEqual(parseThinkingMode({ thinking: false }), 'instant');
  assert.strictEqual(parseThinkingMode({}), 'instant');
  assert.strictEqual(normalizeThinkingMode('расширенный'), 'extended');
});

ok('top tiers: extra_high and pro are their own modes', () => {
  // Added 2026-07-27. Before this the UI's two highest levels were unreachable through the
  // API, and an account already sitting on one of them was pushed back down to High.
  assert.strictEqual(parseThinkingMode({ thinking_mode: 'pro' }), 'pro');
  assert.strictEqual(parseThinkingMode({ thinking_mode: 'extra_high' }), 'extra_high');
  assert.strictEqual(normalizeThinkingMode('Extra High'), 'extra_high');
  assert.strictEqual(normalizeThinkingMode('very high'), 'extra_high');
  assert.strictEqual(normalizeThinkingMode('extrahigh'), 'extra_high');
  assert.strictEqual(normalizeThinkingMode('PRO'), 'pro');
  assert.strictEqual(parseThinkingMode({ reasoning_effort: 'pro' }), 'pro');
});

ok('BREAKING, on purpose: "pro" no longer means extended', () => {
  // It used to be an alias for High. Now that a real Pro tier exists in the UI, a caller
  // asking for "pro" gets Pro. The generic synonyms still mean "the strong one".
  assert.notStrictEqual(normalizeThinkingMode('pro'), 'extended');
  assert.strictEqual(normalizeThinkingMode('advanced'), 'extended');
  assert.strictEqual(normalizeThinkingMode('deep'), 'extended');
  assert.strictEqual(normalizeThinkingMode('расширенный'), 'extended');
});

ok('UI level names resolve to the tier they name, not to instant', () => {
  // "high"/"medium" are what a caller reads off the ChatGPT dropdown. They used to fall
  // through to `instant` — the opposite of the request.
  assert.strictEqual(normalizeThinkingMode('high'), 'extended');
  assert.strictEqual(normalizeThinkingMode('High'), 'extended');
  assert.strictEqual(normalizeThinkingMode('medium'), 'standard');
  assert.strictEqual(normalizeThinkingMode('высокий'), 'extended');
  // "extra high" must NOT be swallowed by the bare "high" rule.
  assert.strictEqual(normalizeThinkingMode('extra high'), 'extra_high');
  assert.strictEqual(normalizeThinkingMode('Extra-High'), 'extra_high');
});

ok('unknown modes still fall back to instant, not to a top tier', () => {
  assert.strictEqual(normalizeThinkingMode('ultra'), 'instant');
  assert.strictEqual(normalizeThinkingMode('proximity'), 'instant');
  assert.strictEqual(normalizeThinkingMode(''), 'instant');
});

// Regression for the 2.2.0 default-flip incident: routes/images.js used to parse
// READ_VIA_BACKEND_API independently with a hard-coded default-off, so with a clean
// env the streaming gate 400'd while the interception layer was on. The flag is now
// imported from one place; these tests pin the envFlag semantics that place relies on.
ok('envFlag: absent env keeps the default (default-on stays on)', () => {
  assert.strictEqual(envFlag('X', true, {}), true);
  assert.strictEqual(envFlag('X', false, {}), false);
  assert.strictEqual(envFlag('X', true, { X: '' }), true);
});

ok('envFlag: explicit false forms disable a default-on flag', () => {
  for (const v of ['0', 'false', 'no', 'off', ' OFF ']) {
    assert.strictEqual(envFlag('X', true, { X: v }), false, v);
  }
});

ok('envFlag: explicit true forms enable a default-off flag', () => {
  for (const v of ['1', 'true', 'yes', 'on', ' On ']) {
    assert.strictEqual(envFlag('X', false, { X: v }), true, v);
  }
});

ok('envFlag: unrecognized value falls back to the default, not to false', () => {
  assert.strictEqual(envFlag('X', true, { X: 'tru' }), true);
  assert.strictEqual(envFlag('X', false, { X: 'enabledd' }), false);
});

ok('MODE_TO_LEVEL and LEVEL_TO_MODE stay mutual inverses', () => {
  // The two maps are edited by hand and drift silently: a mode present in one and missing
  // from the other is exactly how the top tiers ended up being downgraded to `extended`.
  const { MODE_TO_LEVEL, LEVEL_TO_MODE } = require('../src/chatgpt-tiers');
  for (const [mode, level] of Object.entries(MODE_TO_LEVEL)) {
    assert.strictEqual(LEVEL_TO_MODE[level], mode, `LEVEL_TO_MODE["${level}"] should be "${mode}"`);
  }
  for (const [level, mode] of Object.entries(LEVEL_TO_MODE)) {
    assert.strictEqual(MODE_TO_LEVEL[mode], level, `MODE_TO_LEVEL["${mode}"] should be "${level}"`);
  }
});

console.log(`\nAll ${passed} param tests passed.`);
