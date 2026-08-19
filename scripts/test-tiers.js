// Tests for the intelligence-tier registry and the automatic downgrade (src/chatgpt-tiers.js
// + the tier-chain loop in setThinkingMode).
//
// Why the loop is tested here at all: it decides which tier the caller is billed for AND
// whether the session gets torn down (consecutiveMenuFailures → markSessionDegraded). Both
// used to be one branch each; with a fallback chain they are a state machine, and the failure
// modes are silent — a request served one tier down looks exactly like a successful one unless
// you read `applied.thinking_fallback`.
//
// Run via `npm test`.
const assert = require('assert');
const {
  MODE_TO_LEVEL,
  LEVEL_ORDER,
  levelIndex,
  levelAtIndex,
  fallbackFor,
  fallbackChainFor,
  LIMIT_HINT_RE,
  detectTierLimit,
  cooldownMs,
  tierAvailability,
} = require('../src/chatgpt-tiers');
const { metricsHandler } = require('../src/metrics');
const { _test } = require('../src/chatgpt');

let passed = 0;
function ok(name, fn) {
  tierAvailability._reset();
  _test.resetMenuFailures();
  fn();
  console.log(`PASS: ${name}`);
  passed++;
}
function okAsync(name, fn) {
  return async () => {
    tierAvailability._reset();
    _test.resetMenuFailures();
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  };
}

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

ok('pro falls back to extra_high, other tiers have no fallback', () => {
  assert.deepStrictEqual(fallbackChainFor('pro', {}), ['pro', 'extra_high']);
  for (const mode of ['instant', 'standard', 'extended', 'extra_high']) {
    assert.deepStrictEqual(fallbackChainFor(mode, {}), [mode], mode);
  }
});

ok('per-tier env override picks a different fallback', () => {
  assert.deepStrictEqual(fallbackChainFor('pro', { TIER_FALLBACK_PRO: 'extended' }), ['pro', 'extended']);
  // UI-ish spelling is normalized like everywhere else in the API.
  assert.deepStrictEqual(fallbackChainFor('pro', { TIER_FALLBACK_PRO: 'Extra High' }), ['pro', 'extra_high']);
});

ok('the downgrade can be switched off entirely', () => {
  for (const off of ['', 'off', 'none', 'false', '0', 'disabled']) {
    assert.deepStrictEqual(fallbackChainFor('pro', { TIER_FALLBACK_PRO: off }), ['pro'], off);
  }
});

ok('a bogus override keeps the default instead of disabling silently', () => {
  // A typo used to be indistinguishable from "no fallback wanted" — the expensive case is
  // that Pro requests keep failing when the operator thought they had configured a downgrade.
  assert.strictEqual(fallbackFor('pro', { TIER_FALLBACK_PRO: 'ultra' }), 'extra_high');
});

ok('a cyclic override terminates and yields each tier once', () => {
  const env = { TIER_FALLBACK_PRO: 'extra_high', TIER_FALLBACK_EXTRA_HIGH: 'pro' };
  assert.deepStrictEqual(fallbackChainFor('pro', env), ['pro', 'extra_high']);
  assert.deepStrictEqual(fallbackChainFor('extra_high', env), ['extra_high', 'pro']);
});

ok('every chain entry is a real UI level', () => {
  for (const mode of Object.keys(MODE_TO_LEVEL)) {
    for (const hop of fallbackChainFor(mode, {})) {
      assert.ok(MODE_TO_LEVEL[hop], `${mode} → ${hop} has no UI level`);
    }
  }
});

// ---------------------------------------------------------------------------
// Slider geometry (2026-08 UI)
// ---------------------------------------------------------------------------

ok('every UI level has a slider position, in weakest-first order', () => {
  assert.deepStrictEqual(LEVEL_ORDER, ['instant', 'medium', 'high', 'veryhigh', 'pro']);
  // The two maps and the slider order must describe the same set of levels: a level reachable
  // by name but absent from the order would be unselectable on the slider face of the popover.
  assert.deepStrictEqual([...LEVEL_ORDER].sort(), Object.values(MODE_TO_LEVEL).sort());
  LEVEL_ORDER.forEach((level, i) => {
    assert.strictEqual(levelIndex(level), i, `${level} is at ${i}`);
    assert.strictEqual(levelAtIndex(i), level, `index ${i} is ${level}`);
  });
});

ok('a short track means the TOP tiers are missing, never a silent downgrade', () => {
  // Plus renders three positions. Asking for a tier past the end must report "unavailable"
  // (null), NOT clamp to the nearest one — clamping is how a Pro request quietly became High.
  assert.strictEqual(levelIndex('high', 3), 2);
  assert.strictEqual(levelIndex('veryhigh', 3), null);
  assert.strictEqual(levelIndex('pro', 3), null);
  assert.strictEqual(levelAtIndex(3, 3), null);
  // The weak end is common to every plan, so those indexes hold whatever the track length is.
  assert.strictEqual(levelIndex('instant', 3), 0);
  assert.strictEqual(levelAtIndex(0, 3), 'instant');
});

ok('garbage index/level input reports unavailable instead of guessing', () => {
  assert.strictEqual(levelIndex('nonesuch'), null);
  assert.strictEqual(levelAtIndex(-1), null);
  assert.strictEqual(levelAtIndex(1.5), null);
  assert.strictEqual(levelAtIndex(99), null);
  assert.strictEqual(levelIndex('pro', NaN), null);
});

// ---------------------------------------------------------------------------
// Cooldown memo
// ---------------------------------------------------------------------------

ok('cooldown defaults to 15 min, 0 disables it, garbage keeps the default', () => {
  assert.strictEqual(cooldownMs({}), 900 * 1000);
  // `VAR=""` in a manifest is "not configured", NOT "disabled": Number('') is 0, which
  // would have silently turned the memo off for the most common way to write an empty env.
  assert.strictEqual(cooldownMs({ TIER_UNAVAILABLE_COOLDOWN_SEC: '' }), 900 * 1000);
  assert.strictEqual(cooldownMs({ TIER_UNAVAILABLE_COOLDOWN_SEC: '  ' }), 900 * 1000);
  assert.strictEqual(cooldownMs({ TIER_UNAVAILABLE_COOLDOWN_SEC: '60' }), 60 * 1000);
  assert.strictEqual(cooldownMs({ TIER_UNAVAILABLE_COOLDOWN_SEC: '0' }), 0);
  assert.strictEqual(cooldownMs({ TIER_UNAVAILABLE_COOLDOWN_SEC: 'soon' }), 900 * 1000);
  assert.strictEqual(cooldownMs({ TIER_UNAVAILABLE_COOLDOWN_SEC: '-5' }), 900 * 1000);
});

ok('an unavailable tier cools down and then expires', () => {
  const t0 = 1_000_000;
  tierAvailability.markUnavailable('pro', 'quota', { env: { TIER_UNAVAILABLE_COOLDOWN_SEC: '100' }, now: t0 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 99_000 }), true);
  assert.strictEqual(tierAvailability.reasonFor('pro'), 'quota');
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 100_001 }), false);
  // Expiry is destructive on read — the reason must go with it, not linger as a stale label.
  assert.strictEqual(tierAvailability.reasonFor('pro'), null);
});

ok('a verified selection clears the memo immediately', () => {
  const t0 = 1_000_000;
  tierAvailability.markUnavailable('pro', 'quota', { now: t0 });
  tierAvailability.markAvailable('pro');
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 1 }), false);
});

ok('cooldown 0 means never memoize', () => {
  const t0 = 1_000_000;
  tierAvailability.markUnavailable('pro', 'quota', { env: { TIER_UNAVAILABLE_COOLDOWN_SEC: '0' }, now: t0 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 1 }), false);
});

ok('snapshot feeds /metrics: live cooldowns and fallback counts', () => {
  const t0 = 1_000_000;
  tierAvailability.markUnavailable('pro', 'quota', { env: { TIER_UNAVAILABLE_COOLDOWN_SEC: '100' }, now: t0 });
  tierAvailability.recordFallback('pro', 'extra_high');
  tierAvailability.recordFallback('pro', 'extra_high');
  const snap = tierAvailability.snapshot({ now: t0 + 40_000 });
  assert.deepStrictEqual(snap.cooldowns, [{ mode: 'pro', seconds_left: 60, reason: 'quota' }]);
  assert.deepStrictEqual(snap.fallbacks, [{ from: 'pro', to: 'extra_high', count: 2 }]);
  // Expired entries must not linger in the gauge.
  assert.deepStrictEqual(tierAvailability.snapshot({ now: t0 + 200_000 }).cooldowns, []);
});

ok('limit wording is recognized, ordinary tier copy is not', () => {
  for (const s of [
    'pro недоступно до 3 августа',
    'Pro limit reached',
    'pro resets in 2 days',
    'pro upgrade to use',
    'pro лимит исчерпан',
  ]) assert.ok(LIMIT_HINT_RE.test(s), s);
  for (const s of ['pro', 'pro лучшее для сложных задач', 'extra high более глубокий анализ']) {
    assert.ok(!LIMIT_HINT_RE.test(s), s);
  }
});

// ---------------------------------------------------------------------------
// The chain loop in setThinkingMode
// ---------------------------------------------------------------------------

// Minimal page double: setThinkingMode only touches waitForTimeout when `settle` is not
// injected, and we always inject it.
const fakePage = {};

// Builds the injected deps. `levels` is the sequence of pill levels reported by successive
// readPill() calls; `outcomes` maps a target level to the applyLevel() result.
function deps({ pill, outcomes, degraded }) {
  const reads = Array.isArray(pill) ? [...pill] : [pill];
  let last = reads[reads.length - 1];
  const calls = [];
  return {
    calls,
    degraded,
    env: {},
    settle: async () => {},
    readPill: async () => {
      const level = reads.length > 1 ? reads.shift() : reads[0];
      last = level;
      return { level, pillText: level || '' };
    },
    applyLevel: async (_p, targetLevel) => {
      calls.push(targetLevel);
      const outcome = outcomes[targetLevel] || { menuOpened: true, clicked: false, unsupported: true, disabled: false };
      if (outcome.thenPill !== undefined) reads.unshift(outcome.thenPill);
      return outcome;
    },
    markDegraded: (reason) => { degraded.push(reason); },
    get lastPill() { return last; },
  };
}

const CLICK_OK = (level) => ({ menuOpened: true, clicked: true, unsupported: false, disabled: false, thenPill: level });
const NOT_OFFERED = { menuOpened: true, clicked: false, unsupported: true, disabled: false, itemText: '', quotaHint: false };
const DISABLED_QUOTA = { menuOpened: true, clicked: false, unsupported: true, disabled: true, itemText: 'pro лимит исчерпан', quotaHint: true };
const CLICK_SWALLOWED = { menuOpened: true, clicked: true, unsupported: false, disabled: false };
const MENU_DEAD = { menuOpened: false, clicked: false, unsupported: false, disabled: false };

const tests = [];

tests.push(okAsync('pro is applied when the tier is available — no fallback recorded', async () => {
  const degraded = [];
  const d = deps({ pill: ['medium'], outcomes: { pro: CLICK_OK('pro') }, degraded });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.deepStrictEqual(d.calls, ['pro']);
  assert.strictEqual(r.mode, 'pro');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.fallback, null);
  assert.strictEqual(r.requestedVerified, true);
  assert.strictEqual(r.effort, true);
  assert.deepStrictEqual(degraded, []);
  assert.strictEqual(tierAvailability.snapshot().fallbacks.length, 0);
}));

tests.push(okAsync('pro disabled by quota → extra_high applied and reported', async () => {
  const degraded = [];
  const d = deps({
    pill: ['medium'],
    outcomes: { pro: DISABLED_QUOTA, veryhigh: CLICK_OK('veryhigh') },
    degraded,
  });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.deepStrictEqual(d.calls, ['pro', 'veryhigh']);
  assert.strictEqual(r.mode, 'extra_high');
  assert.strictEqual(r.requested, 'pro');
  // verified refers to what was APPLIED — Extra High really is active.
  assert.strictEqual(r.verified, true);
  assert.deepStrictEqual(r.fallback, { from: 'pro', to: 'extra_high', reason: 'quota', verified: true });
  // ...and the caller can tell that the tier it ASKED for was not the one confirmed.
  assert.strictEqual(r.requestedVerified, false);
  assert.strictEqual(r.unsupported, true);
  // A downgrade that ended in a working tier is not a degradation.
  assert.deepStrictEqual(degraded, []);
  assert.strictEqual(_test.menuFailures(), 0);
  assert.deepStrictEqual(tierAvailability.snapshot().fallbacks, [{ from: 'pro', to: 'extra_high', count: 1 }]);
}));

tests.push(okAsync('pro missing from the menu → extra_high, reason not-offered', async () => {
  const d = deps({ pill: ['medium'], outcomes: { pro: NOT_OFFERED, veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.strictEqual(r.mode, 'extra_high');
  assert.strictEqual(r.fallback.reason, 'not-offered');
}));

tests.push(okAsync('a click the UI swallowed downgrades THIS request but never memoizes', async () => {
  // This is what an out-of-quota tier looks like when the item stays enabled: Radix accepts
  // the click, an upsell dialog eats it, the pill never moves. It is also what a plain
  // Playwright/UI transient looks like — so serve this request one tier down, but do NOT
  // block Pro for the next 15 minutes on that evidence (Codex review).
  const d = deps({ pill: ['medium'], outcomes: { pro: CLICK_SWALLOWED, veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.strictEqual(r.mode, 'extra_high');
  assert.strictEqual(r.fallback.reason, 'click-not-applied');
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
}));

tests.push(okAsync('a tier missing ONCE is not memoized — a half-rendered menu looks the same', async () => {
  // intelligenceMenuOpen() is satisfied by two visible levels, so "Pro is not in the menu"
  // can simply mean the menu had not finished rendering.
  const once = deps({ pill: ['medium'], outcomes: { pro: NOT_OFFERED, veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  await _test.setThinkingMode(fakePage, 'pro', once);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
  // Twice in a row is evidence.
  const twice = deps({ pill: ['medium'], outcomes: { pro: NOT_OFFERED, veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  await _test.setThinkingMode(fakePage, 'pro', twice);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), true);
}));

tests.push(okAsync('an explicitly disabled item is believed at once', async () => {
  const d = deps({ pill: ['medium'], outcomes: { pro: DISABLED_QUOTA, veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  await _test.setThinkingMode(fakePage, 'pro', d);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), true);
}));

tests.push(okAsync('a memoized tier that the pill already shows wins over the memo', async () => {
  // Quota came back (or someone set Pro by hand): forcing the downgrade anyway would mean
  // the adapter undoing a real recovery for the rest of the cooldown.
  tierAvailability.markUnavailable('pro', 'quota');
  const d = deps({ pill: ['pro'], outcomes: {}, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.deepStrictEqual(d.calls, []);
  assert.strictEqual(r.mode, 'pro');
  assert.strictEqual(r.fallback, null);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
}));

tests.push(okAsync('second pro request skips straight to extra_high (cooldown)', async () => {
  const first = deps({ pill: ['medium'], outcomes: { pro: DISABLED_QUOTA, veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  await _test.setThinkingMode(fakePage, 'pro', first);
  const second = deps({ pill: ['medium'], outcomes: { veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'pro', second);
  // The whole point: no menu round-trip for the tier we already know is gone.
  assert.deepStrictEqual(second.calls, ['veryhigh']);
  assert.strictEqual(r.mode, 'extra_high');
  assert.strictEqual(r.fallback.reason, 'cooldown:quota');
}));

tests.push(okAsync('a verified pro clears the cooldown so the next request tries Pro again', async () => {
  tierAvailability.markUnavailable('pro', 'quota', { env: { TIER_UNAVAILABLE_COOLDOWN_SEC: '900' } });
  // Cooldown active → this request is downgraded...
  const skipped = deps({ pill: ['medium'], outcomes: { veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  await _test.setThinkingMode(fakePage, 'pro', skipped);
  assert.deepStrictEqual(skipped.calls, ['veryhigh']);
  // ...operator shortens the memo by hand / quota returns: a verified selection clears it.
  tierAvailability.markAvailable('pro');
  const retried = deps({ pill: ['medium'], outcomes: { pro: CLICK_OK('pro') }, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'pro', retried);
  assert.deepStrictEqual(retried.calls, ['pro']);
  assert.strictEqual(r.fallback, null);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
}));

tests.push(okAsync('a dead menu is NOT a tier problem: no fallback, no stale memo, degradation counted', async () => {
  const degraded = [];
  const d = deps({ pill: ['medium'], outcomes: { pro: MENU_DEAD, veryhigh: CLICK_OK('veryhigh') }, degraded });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  // Retrying a lower tier through the same broken menu cannot help — don't waste the time.
  assert.deepStrictEqual(d.calls, ['pro']);
  assert.strictEqual(r.fallback, null);
  assert.strictEqual(r.verified, false);
  // And the tier must not be remembered as unavailable — the menu was, the tier is unknown.
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
  assert.strictEqual(_test.menuFailures(), 1);
  assert.deepStrictEqual(degraded, []);
}));

tests.push(okAsync('the whole chain failing counts degradation ONCE, not per tier', async () => {
  const degraded = [];
  const d = deps({ pill: ['medium'], outcomes: { pro: CLICK_SWALLOWED, veryhigh: CLICK_SWALLOWED }, degraded });
  await _test.setThinkingMode(fakePage, 'pro', d);
  assert.deepStrictEqual(d.calls, ['pro', 'veryhigh']);
  // Two failed hops in ONE call must not reach the 2-strike session reset by themselves.
  assert.strictEqual(_test.menuFailures(), 1);
  assert.deepStrictEqual(degraded, []);
}));

tests.push(okAsync('two consecutive unverified calls still degrade the session', async () => {
  const degraded = [];
  for (let i = 0; i < 2; i++) {
    const d = deps({ pill: ['medium'], outcomes: { veryhigh: CLICK_SWALLOWED }, degraded });
    await _test.setThinkingMode(fakePage, 'extra_high', d);
  }
  assert.strictEqual(degraded.length, 1, 'markSessionDegraded should fire on the second strike');
}));

tests.push(okAsync('a tier with no fallback is attempted even while cooling down', async () => {
  // extra_high has nothing below it: skipping the only hop would mean never trying again
  // until the memo expires, i.e. a self-inflicted outage of that tier.
  tierAvailability.markUnavailable('extra_high', 'not-offered');
  const d = deps({ pill: ['medium'], outcomes: { veryhigh: CLICK_OK('veryhigh') }, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'extra_high', d);
  assert.deepStrictEqual(d.calls, ['veryhigh']);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.fallback, null);
}));

tests.push(okAsync('already on Pro: no menu round-trip, no fallback', async () => {
  const d = deps({ pill: ['pro'], outcomes: {}, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.deepStrictEqual(d.calls, []);
  assert.strictEqual(r.mode, 'pro');
  assert.strictEqual(r.verified, true);
}));

tests.push(okAsync('the downgrade honours TIER_FALLBACK_PRO=off', async () => {
  const d = deps({ pill: ['medium'], outcomes: { pro: DISABLED_QUOTA }, degraded: [] });
  d.env = { TIER_FALLBACK_PRO: 'off' };
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.deepStrictEqual(d.calls, ['pro']);
  assert.strictEqual(r.fallback, null);
  assert.strictEqual(r.verified, false);
  assert.strictEqual(r.unsupported, true);
}));

tests.push(okAsync('a downgrade that also fails reports the failure honestly', async () => {
  const d = deps({ pill: ['medium'], outcomes: { pro: DISABLED_QUOTA, veryhigh: CLICK_SWALLOWED }, degraded: [] });
  const r = await _test.setThinkingMode(fakePage, 'pro', d);
  assert.strictEqual(r.verified, false);
  assert.strictEqual(r.requestedVerified, false);
  assert.strictEqual(r.fallback.to, 'extra_high');
  assert.strictEqual(r.fallback.verified, false);
  // applied.thinking_mode must reflect the pill (standard), never the tier we hoped for.
  assert.strictEqual(r.mode, 'standard');
  // "Served one tier down" did not happen — the counter must stay clean.
  assert.deepStrictEqual(tierAvailability.snapshot().fallbacks, []);
}));

tests.push(okAsync('non-pro modes are untouched by all of this', async () => {
  for (const [mode, level] of [['standard', 'medium'], ['extended', 'high'], ['instant', 'instant']]) {
    const d = deps({ pill: ['high'], outcomes: { [level]: CLICK_OK(level) }, degraded: [] });
    const r = await _test.setThinkingMode(fakePage, mode, d);
    assert.strictEqual(r.mode, mode, mode);
    assert.strictEqual(r.fallback, null, mode);
  }
}));

// ---------------------------------------------------------------------------
// Post-submit limit notice + metrics rendering
// ---------------------------------------------------------------------------

ok('the post-submit limit notice is recognized only when it is not our own prompt', () => {
  const notice = 'Вы достигли лимита Pro. Сбросится 3 августа.';
  assert.strictEqual(detectTierLimit(notice, 'pro').tier, 'pro');
  assert.strictEqual(detectTierLimit("You've reached your Pro limit", 'pro').tier, 'pro');
  // Armed only for the tier we actually ran on.
  assert.strictEqual(detectTierLimit(notice, 'extra_high'), null);
  assert.strictEqual(detectTierLimit(notice, 'instant'), null);
  // The caller's own words are on the page too — a question ABOUT Pro limits must not
  // abort its own request.
  const prompt = 'расскажи как работают лимиты pro';
  assert.strictEqual(detectTierLimit(`You said:\n${prompt}\nThinking...`, 'pro', { prompt }), null);
  // ...but a real notice alongside that same prompt still fires.
  assert.strictEqual(detectTierLimit(`${prompt}\n${notice}`, 'pro', { prompt }).tier, 'pro');
  assert.strictEqual(detectTierLimit('here is your answer', 'pro'), null);
});

ok('a notice from an EARLIER turn does not kill the next request', () => {
  // Continuing a conversation re-renders the whole history, so the banner is still on the
  // page. Without subtracting the pre-turn text every following request in that conversation
  // died with tier_limit (Codex review).
  const notice = 'Вы достигли лимита Pro. Сбросится 3 августа.';
  const before = `предыдущий вопрос\n${notice}`;
  assert.strictEqual(detectTierLimit(`${before}\nновый вопрос`, 'pro', { seen: before }), null);
  // A FRESH notice in the same conversation still fires.
  assert.strictEqual(
    detectTierLimit(`${before}\nновый вопрос\n${notice}`, 'pro', { seen: 'предыдущий вопрос' }).tier,
    'pro',
  );
});

ok('strikes must be CONSECUTIVE and do not survive the cooldown', () => {
  const t0 = 1_000_000;
  const env = { TIER_UNAVAILABLE_COOLDOWN_SEC: '100' };
  // not-offered → click-not-applied → not-offered is NOT two agreeing observations.
  tierAvailability.noteUnavailable('pro', 'not-offered', { stickyAfter: 2, env, now: t0 });
  tierAvailability.noteUnavailable('pro', 'click-not-applied', { stickyAfter: Infinity, env, now: t0 });
  tierAvailability.noteUnavailable('pro', 'not-offered', { stickyAfter: 2, env, now: t0 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 1 }), false, 'interleaved');
  // Two in a row do memoize...
  tierAvailability.noteUnavailable('pro', 'not-offered', { stickyAfter: 2, env, now: t0 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 1 }), true);
  // ...and once the memo expires, the evidence expires with it: a fresh window needs fresh
  // confirmations instead of re-blocking on a single sighting forever.
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 200_000 }), false);
  assert.strictEqual(tierAvailability.strikesFor('pro'), 0);
  tierAvailability.noteUnavailable('pro', 'not-offered', { stickyAfter: 2, env, now: t0 + 200_000 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro', { now: t0 + 200_001 }), false, 'one sighting is not enough');
});

ok('/metrics renders the tier series (stable zero series when nothing happened)', () => {
  let body = '';
  const res = { set() {}, send(b) { body = b; } };
  metricsHandler({}, res);
  assert.ok(body.includes('gpt_web_gateway_tier_fallbacks_total{from="pro",to="extra_high"} 0'), 'zero series');
  assert.ok(body.includes('gpt_web_gateway_tier_cooldown_active{tier="pro"} 0'), 'gauge off');
  assert.ok(body.includes('gpt_web_gateway_errors_total{type="tier_limit"}'), 'tier_limit error series');
  assert.ok(body.includes('gpt_web_gateway_duration_seconds_count{result="tier_limit"}'), 'tier_limit histogram');

  tierAvailability.recordFallback('pro', 'extra_high');
  tierAvailability.markUnavailable('pro', 'quota');
  metricsHandler({}, res);
  assert.ok(body.includes('gpt_web_gateway_tier_fallbacks_total{from="pro",to="extra_high"} 1'), 'counted');
  assert.ok(body.includes('gpt_web_gateway_tier_cooldown_active{tier="pro"} 1'), 'gauge on');

  // A differently-configured pair must not make the baseline series disappear — a gauge that
  // vanishes once something happens is worse than no gauge (Codex review).
  tierAvailability.recordFallback('pro', 'extended');
  metricsHandler({}, res);
  assert.ok(body.includes('gpt_web_gateway_tier_fallbacks_total{from="pro",to="extra_high"} 1'), 'baseline kept');
  assert.ok(body.includes('gpt_web_gateway_tier_fallbacks_total{from="pro",to="extended"} 1'), 'new pair too');
});

(async () => {
  for (const t of tests) await t();
  console.log(`\n${passed} tier tests passed`);
})().catch((err) => {
  console.error('FAIL:', err && err.message);
  console.error(err);
  process.exit(1);
});
