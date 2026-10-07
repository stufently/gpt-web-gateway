// Kills four regressions in src/totp-step.js. rc=0 only when each mutation is
// present exactly once, turns its own test into an AssertionError, and the
// original bytes are restored (sha256).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const target = path.join(root, 'src', 'totp-step.js');
const testScript = path.join(root, 'scripts', 'test-totp-step.js');

const mutations = [
  {
    id: 'a',
    test: 'a code field that appears at 20s virtual time is filled',
    from: 'const DEFAULT_TOTP_PROMPT_TIMEOUT_SEC = 30;',
    to: 'const DEFAULT_TOTP_PROMPT_TIMEOUT_SEC = 10;',
  },
  {
    id: 'b',
    test: 'six visible maxlength=1 inputs receive one digit each',
    from: [
      '  const segments = await visibleSegmentRun(page);',
      '  if (segments) return { mode: \'segments\', fields: segments };',
      '',
    ].join('\n'),
    to: '',
  },
  {
    id: 'c',
    test: 'an MFA page with no code field throws login_form_changed',
    from: [
      '    const err = new Error(\'TOTP prompt is on screen but the code field was not found\');',
      '    err.loginBlockerHint = \'login_form_changed\';',
      '    throw err;',
    ].join('\n'),
    to: [
      '    emit(opts, \'[auto-login] TOTP prompt not found — skipping\');',
      '    return;',
    ].join('\n'),
  },
  {
    id: 'd',
    test: 'error=totp after submit throws mfa_required',
    from: [
      '  if (String(url).includes(\'error=totp\')) {',
      '    const err = new Error(\'TOTP code rejected (error=totp)\');',
      '    err.loginBlockerHint = \'mfa_required\';',
      '    throw err;',
      '  }',
    ].join('\n'),
    to: '',
  },
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function runTests() {
  return spawnSync(process.execPath, [testScript], { cwd: root, encoding: 'utf8' });
}

function killedBy(result, testName) {
  const out = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0) return 'tests exited 0';
  const line = out.split('\n').find((row) => row.startsWith(`FAIL: ${testName} —`));
  if (!line) return `no FAIL line for "${testName}"`;
  if (!line.includes('AssertionError')) return `not an assertion: ${line}`;
  return null;
}

const original = fs.readFileSync(target);
const hash = sha256(original);
let failed = 0;

function restore() {
  fs.writeFileSync(target, original);
  const after = sha256(fs.readFileSync(target));
  if (after !== hash) {
    console.error(`sha256 mismatch after rollback: ${after} !== ${hash}`);
    process.exit(1);
  }
}

console.log('clean run');
const clean = runTests();
if (clean.status !== 0) {
  console.error(clean.stdout);
  console.error(clean.stderr);
  console.error('clean run failed');
  process.exit(1);
}
console.log('clean run green');

for (const mutation of mutations) {
  const text = original.toString('utf8');
  const count = text.split(mutation.from).length - 1;
  if (count !== 1) {
    console.error(`${mutation.id}: fragment occurs ${count} times, expected 1`);
    failed += 1;
    continue;
  }
  console.log(`${mutation.id}: fragment occurs once`);
  fs.writeFileSync(target, text.replace(mutation.from, mutation.to));
  try {
    const result = runTests();
    const problem = killedBy(result, mutation.test);
    if (problem) {
      console.error(`${mutation.id}: ${problem}`);
      const tail = `${result.stdout || ''}\n${result.stderr || ''}`.split('\n').filter((row) => row.startsWith('FAIL:')).join('\n');
      if (tail) console.error(tail);
      failed += 1;
    } else {
      console.log(`${mutation.id}: killed on its own assert (${mutation.test})`);
    }
  } finally {
    restore();
    console.log(`${mutation.id}: rolled back, sha256 ${hash}`);
  }
}

if (sha256(fs.readFileSync(target)) !== hash) {
  console.error('source hash drifted after the loop');
  process.exit(1);
}

if (failed) {
  console.error(`${failed} mutation(s) were not killed`);
  process.exit(1);
}
console.log('all four mutations killed');
