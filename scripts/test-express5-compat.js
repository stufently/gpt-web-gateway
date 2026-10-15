// Express 5 compatibility: requests without a JSON body must still reach the
// routes' own validation (400), not crash on req.body being undefined (500).
// chatgpt is replaced by a stub — no browser.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');
const express = require('express');

const chatgptPath = require.resolve('../src/chatgpt');
const stub = {
  READ_VIA_BACKEND_API: true,
  setPoolHooks() {},
  getPoolHooks() { return null; },
  generateImage: async () => { throw new Error('stub: must not be called'); },
  editImage: async () => { throw new Error('stub: must not be called'); },
  completeText: async () => { throw new Error('stub: must not be called'); },
  probeCapabilities: async () => ({}),
  resetPage() {},
  resetAllSlotPages() {},
};
const cached = new Module(chatgptPath);
cached.filename = chatgptPath;
cached.loaded = true;
cached.exports = stub;
require.cache[chatgptPath] = cached;

const imagesRouter = require('../src/routes/images');
const { defaultBody } = require('../src/body-default');

function listen(withDefault) {
  const app = express();
  app.use(express.json());
  if (withDefault) app.use(defaultBody);
  app.use(imagesRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: { message: err.message } }));
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function post(port, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { json = { raw }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const CASES = [
  ['/v1/chat/completions', 'messages or input is required'],
  ['/v1/responses', 'messages or input is required'],
  ['/v1/images/generations', 'prompt is required'],
  ['/v1/images/edits', 'prompt and image are required'],
];
const BODIES = [
  ['no body, no content-type', {}, undefined],
  ['text/plain body', { 'content-type': 'text/plain', 'content-length': '5' }, 'hello'],
];

(async () => {
  let passed = 0;
  let total = 0;
  const server = await listen(true);
  const { port } = server.address();
  try {
    for (const [route, message] of CASES) {
      for (const [label, headers, body] of BODIES) {
        total += 1;
        const res = await post(port, route, headers, body);
        assert.strictEqual(res.status, 400, `${route} (${label}) -> ${res.status} ${JSON.stringify(res.json)}`);
        assert.ok(
          String(res.json && res.json.error && res.json.error.message).startsWith(message),
          `${route} (${label}) message: ${JSON.stringify(res.json)}`,
        );
        console.log(`PASS: ${route} ${label} -> 400`);
        passed += 1;
      }
    }
  } finally {
    server.close();
  }

  // Control: without defaultBody, Express 5 really does leave req.body undefined
  // and the route crashes — proves the cases above exercise the middleware.
  total += 1;
  const bare = await listen(false);
  try {
    const res = await post(bare.address().port, '/v1/chat/completions', {}, undefined);
    assert.strictEqual(res.status, 500, `control without defaultBody -> ${res.status}`);
    console.log('PASS: control without defaultBody -> 500');
    passed += 1;
  } finally {
    bare.close();
  }

  // Wiring: server.js must install defaultBody right after the JSON parser.
  total += 1;
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(
    src,
    /app\.use\(express\.json\(\{ limit: '50mb' \}\)\);\napp\.use\(defaultBody\);/,
    'server.js: app.use(defaultBody) must follow express.json',
  );
  console.log('PASS: server.js wires defaultBody after express.json');
  passed += 1;

  // Express 5 passes listen errors to the callback: they must not be swallowed.
  total += 1;
  assert.match(
    src,
    /app\.listen\(PORT, \(err\) => \{[\s\S]*?\n  if \(err\) throw err;/,
    'server.js: app.listen callback must rethrow its error',
  );
  console.log('PASS: server.js rethrows app.listen errors');
  passed += 1;

  console.log(`\n${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
})().catch((err) => {
  console.error(`FAIL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
