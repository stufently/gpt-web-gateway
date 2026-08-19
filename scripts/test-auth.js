// Unit tests for the app-level auth check (src/auth.js). Pure Node, no Express.
const assert = require('node:assert');
const { checkAuthHeader, createAuthMiddleware } = require('../src/auth');

const KEY = 'test-key-123';
let passed = 0;

function check(name, actual, expected) {
  assert.strictEqual(actual, expected, `${name}: got ${actual}, want ${expected}`);
  console.log(`PASS: ${name} → ${actual} (want ${expected})`);
  passed++;
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

// No key configured → everything passes (auth disabled)
check('no key configured → open', checkAuthHeader(undefined, ''), true);

// Bearer
check('valid Bearer', checkAuthHeader(`Bearer ${KEY}`, KEY), true);
check('lowercase bearer scheme', checkAuthHeader(`bearer ${KEY}`, KEY), true);
check('wrong Bearer token', checkAuthHeader('Bearer nope', KEY), false);
check('Bearer with padding spaces', checkAuthHeader(`Bearer   ${KEY}  `, KEY), true);

// Basic: any username, password must equal the key
check('valid Basic any user', checkAuthHeader(basic('alice', KEY), KEY), true);
check('valid Basic empty user', checkAuthHeader(basic('', KEY), KEY), true);
check('lowercase basic scheme', checkAuthHeader(basic('u', KEY).replace('Basic', 'basic'), KEY), true);
check('wrong Basic password', checkAuthHeader(basic('alice', 'nope'), KEY), false);
check('Basic without colon', checkAuthHeader(`Basic ${Buffer.from('justuser').toString('base64')}`, KEY), false);
check('Basic password containing colon', checkAuthHeader(basic('u', `${KEY}:extra`), KEY), false);

// Garbage / missing
check('missing header', checkAuthHeader(undefined, KEY), false);
check('empty header', checkAuthHeader('', KEY), false);
check('unknown scheme', checkAuthHeader(`Digest ${KEY}`, KEY), false);
check('bare token without scheme', checkAuthHeader(KEY, KEY), false);

// Middleware behavior
const mw = createAuthMiddleware(KEY);
{
  let nextCalled = false;
  mw({ headers: { authorization: `Bearer ${KEY}` } }, {}, () => { nextCalled = true; });
  check('middleware calls next() on valid key', nextCalled, true);
}
{
  let status = null;
  let body = null;
  const res = {
    set() { return this; },
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  mw({ headers: {} }, res, () => { throw new Error('next() must not be called'); });
  check('middleware rejects missing header with 401', status, 401);
  check('middleware error_kind', body.error_kind, 'unauthorized');
  check('middleware should_retry', body.should_retry, false);
}

console.log(`\nAll ${passed} auth tests passed.`);
