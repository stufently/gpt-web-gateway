// Mutation run for the empty-turn retry and the early poll (2.16.8) and the instant resend (2.16.9), against
// scripts/test-empty-turn-retry.js only. Each mutation replaces one unique fragment, the
// test file runs, the original bytes are restored and checked by sha256.
// rc=0 when every fragment was unique and every file was restored; survivors are reported.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const TEST = 'scripts/test-empty-turn-retry.js';
const C = 'src/chatgpt.js';
const R = 'src/routes/images.js';
const mutations = [
  ['E01', C, "if (err.code === 'empty_turn' && !anyDeltaEmitted", "if (err.code !== 'timeout' && !anyDeltaEmitted"],
  ['E02', C, "&& !anyDeltaEmitted && !options.conversationId\n          && !err.resendNotSent", "&& !anyDeltaEmitted\n          && !err.resendNotSent"],
  ['E03', C, '&& (stallRetryState.emptyTurnUsed || 0) < EMPTY_TURN_RETRIES_TOTAL) {', '&& (stallRetryState.emptyTurnUsed || 0) <= EMPTY_TURN_RETRIES_TOTAL) {'],
  ['E04', C, 'if (leftMs >= EMPTY_TURN_RETRY_MIN_MS) {', 'if (true) {'],
  ['E05', C, 'stallRetryState.emptyTurnUsed = (stallRetryState.emptyTurnUsed || 0) + 1;', ''],
  ['E06', C, '          retryDeadlineAt = requestDeadline;\n', ''],
  ['E07', C, "          if (typeof options.onAttemptFinished === 'function') options.onAttemptFinished();\n          console.log(`[chatgpt] empty turn retry", "          console.log(`[chatgpt] empty turn retry"],
  ['E08', C, 'const requestStartedAt = Number.isFinite(options.requestStartedAt) ? options.requestStartedAt : Date.now();', 'const requestStartedAt = Date.now();'],
  ['E09', C, "        || (stallRetryState.emptyTurnUsed || 0) > 0) await ensureNewChat(p);", "        || false) await ensureNewChat(p);"],
  ['E10', C, '        deadlineAt: retryDeadlineAt,\n', ''],
  ['E11', C, 'let deadline = Math.min(start + baseBudgetMs, hardDeadline);', 'let deadline = start + baseBudgetMs;'],
  ['E12', C, 'const until = Math.min(early ? Math.max(start + budgetMs, deadline) : start + budgetMs, hardDeadline);', 'const until = early ? Math.max(start + budgetMs, deadline) : start + budgetMs;'],
  ['E13', C, 'const until = Math.min(early ? Math.max(start + budgetMs, deadline) : start + budgetMs, hardDeadline);', 'const until = Math.min(start + budgetMs, hardDeadline);'],
  ['E14', C, '      if (!streamOpen(cap)) cap.streamEndedAt = Date.now();\n', ''],
  ['E15', C, '&& !streamOpen(capture) && Date.now() - capture.streamEndedAt >= BG_POLL_EARLY_GRACE_MS', '&& !streamOpen(capture) && Date.now() - capture.streamEndedAt >= 0'],
  ['E16', C, "      && !capture.snapshot().lastAssistantText;\n", ";\n"],
  ['E17', C, '      } else if (early) {\n', '      } else if (false) {\n'],
  ['E18', C, "const early = !silent && !bgPollUnsupported", "const early = false && !silent && !bgPollUnsupported"],
  ['E19', C, "      if (retryDeadlineAt !== null) {\n        const label = emptyTurnRetryLabel(", "      if (false) {\n        const label = emptyTurnRetryLabel("],
  ['E20', R, "      stallRetryState,\n      requestStartedAt: startedAt, // the empty-turn retry budget counts queue time too\n    })), conversationKey(conversationId));\n\n    const applied", "      stallRetryState,\n    })), conversationKey(conversationId));\n\n    const applied"],
  ['E21', C, 'deadline = Math.min(Date.now() + CHAT_COMPLETION_RETRY_TIMEOUT_MS, hardDeadline);', 'deadline = Date.now() + CHAT_COMPLETION_RETRY_TIMEOUT_MS;'],
  ['E22', C, 'if (!extended && Date.now() < hardDeadline) {', 'if (!extended) {'],
  ['E23', C, 'if (snap && snap.lastAssistantText && activeCapture(slot) === cap) {', 'if (snap && snap.lastAssistantText) {'],
  ['E24', C, '          stallRetryState.emptyTurnDeadlineAt = requestDeadline;\n', ''],
  ['E25', C, 'let retryDeadlineAt = Number.isFinite(stallRetryState.emptyTurnDeadlineAt) ? stallRetryState.emptyTurnDeadlineAt : null;', 'let retryDeadlineAt = null;'],
  ['E26', C, 'if (retryDeadlineAt !== null && retryDeadlineAt - Date.now() < EMPTY_TURN_SEND_MIN_MS) {', 'if (false) {'],
  ['E27', C, 'const waitMs = Math.max(1000, Math.min(BG_POLL_FETCH_TIMEOUT_MS * 4, maxWaitMs));', 'const waitMs = BG_POLL_FETCH_TIMEOUT_MS * 4;'],
  ['E28', C, 'turnNotBeforeSec(capture, start), bgPoll.until - Date.now());', 'turnNotBeforeSec(capture, start));'],
  // 2.16.9: the instant resend.
  ['I01', C, 'const instantResend = (stallRetryState.emptyTurnUsed || 0) > EMPTY_TURN_RETRIES;', 'const instantResend = (stallRetryState.emptyTurnUsed || 0) >= EMPTY_TURN_RETRIES;'],
  ['I02', C, "const thinkingMode = instantResend ? 'instant' : requestedMode;", 'const thinkingMode = requestedMode;'],
  ['I03', C, "const instantFallback = instantResend && requestedMode !== 'instant';", 'const instantFallback = instantResend;'],
  ['I04', C, "const instantFallback = instantResend && requestedMode !== 'instant';", 'const instantFallback = false;'],
  ['I05', C, 'requested_verified: !instantFallback && !!thinkingState.requestedVerified,', 'requested_verified: !!thinkingState.requestedVerified,'],
  ['I06', C, 'const EMPTY_TURN_RETRIES_TOTAL = EMPTY_TURN_RETRIES + EMPTY_TURN_INSTANT_RETRY;', 'const EMPTY_TURN_RETRIES_TOTAL = EMPTY_TURN_RETRIES;'],
  ['I07', C, "safeNonNegativeInt(process.env.CHAT_EMPTY_TURN_INSTANT_RETRY, 1) > 0 ? 1 : 0;", "safeNonNegativeInt(process.env.CHAT_EMPTY_TURN_INSTANT_RETRY, 0) > 0 ? 1 : 0;"],
  ['I08', C, "${n > EMPTY_TURN_RETRIES ? ' (instant)' : ''}", "${n >= EMPTY_TURN_RETRIES ? ' (instant)' : ''}"],
  ['I09', C, '&& !err.resendNotSent && (stallRetryState', '&& (stallRetryState'],
  ['I10', C, 'if (err.resendNotSent) console.log(', 'if (false) console.log('],
  ['I11', C, 'const label = emptyTurnRetryLabel((stallRetryState.emptyTurnUsed || 0) + 1);', 'const label = emptyTurnRetryLabel(stallRetryState.emptyTurnUsed || 0);'],
  ['I12', C, "? { from: requestedMode, to: 'instant', reason: 'empty_turn'", "? { from: thinkingMode, to: 'instant', reason: 'empty_turn'"],
  ['I13', C, "if (instantResend && thinkingState.mode !== 'instant') {", 'if (false) {'],
  ['I14', C, 'const EMPTY_TURN_INSTANT_RETRY = EMPTY_TURN_RETRIES > 0\n  && ', 'const EMPTY_TURN_INSTANT_RETRY = '],
];

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const rows = [];
let bad = false;
for (const [id, file, from, to] of mutations) {
  const fp = path.join(root, file);
  const original = fs.readFileSync(fp);
  const text = original.toString('utf8');
  const n = text.split(from).length - 1;
  if (n !== 1) { rows.push({ id, result: `invalid (fragment found ${n}x)` }); bad = true; continue; }
  fs.writeFileSync(fp, text.replace(from, to));
  const run = spawnSync(process.execPath, [TEST], { cwd: root, encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(fp, original);
  if (sha(fs.readFileSync(fp)) !== sha(original)) { console.error(`${id}: restore failed`); process.exit(1); }
  const out = `${run.stdout}${run.stderr}`;
  const failed = (out.match(/^not ok \d+ - (.*)$/gm) || []).map(l => l.replace(/^not ok \d+ - /, ''));
  rows.push({ id, result: run.status === 0 ? 'SURVIVED' : 'killed', by: failed.slice(0, 2).join(' | ') });
}
for (const r of rows) console.log(`${r.id}\t${r.result}\t${r.by || ''}`);
const clean = spawnSync(process.execPath, [TEST], { cwd: root, encoding: 'utf8' });
console.log(`clean run rc=${clean.status}`);
process.exit(bad || clean.status !== 0 ? 1 : 0);
