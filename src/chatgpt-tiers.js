// The ChatGPT "Intelligence" tier registry.
//
// Extracted from chatgpt.js so the mapping can be unit-tested without loading Playwright and
// the whole adapter. The two maps are mutual inverses and a test pins that: a mode present in
// one and missing from the other is precisely how Extra High and Pro used to be silently
// downgraded to `extended` — and then actively switched back down in the UI.
//
// API mode ←→ UI level:
//   instant    ←→ Instant
//   standard   ←→ Medium
//   extended   ←→ High
//   extra_high ←→ Extra High
//   pro        ←→ Pro
//
// Availability is PLAN-DEPENDENT: Plus exposes only the lower three. A tier that is not in
// the menu cannot be clicked; the adapter reports that as `unsupported` rather than treating
// it as a broken session.
const MODE_TO_LEVEL = {
  instant: 'instant',
  standard: 'medium',
  extended: 'high',
  extra_high: 'veryhigh',
  pro: 'pro',
};

const LEVEL_TO_MODE = {
  instant: 'instant',
  medium: 'standard',
  high: 'extended',
  veryhigh: 'extra_high',
  pro: 'pro',
};

// Modes that count as "reasoning effort was engaged" in the API echo block. Leaving this as
// `mode === 'extended'` reported effort:false for the two highest settings the product has.
const HIGH_EFFORT_MODES = new Set(['extended', 'extra_high', 'pro']);

// ---------------------------------------------------------------------------
// Slider geometry (2026-08 UI)
// ---------------------------------------------------------------------------
// ChatGPT replaced the named "Интеллект" dropdown with a POSITIONAL slider: the composer pill
// opens a popover holding an "Advanced ›" link and a track with one tick per tier. There are no
// menu items left to click by name, so a tier is now addressed by its INDEX on that track.
// This list is the only place the order is written down — weakest position first, matching the
// track left-to-right.
const LEVEL_ORDER = ['instant', 'medium', 'high', 'veryhigh', 'pro'];

// How many positions the track offers is PLAN-DEPENDENT (Plus renders three, Pro five). Fewer
// positions always means the TOP tiers are absent — the weak end is common to every plan — so
// indexes count from the START of LEVEL_ORDER.
//
// A level beyond the track's range returns null, i.e. "this account cannot select that tier".
// Clamping to the nearest position instead would be the same silent downgrade the named menu
// used to produce: asking for Pro on a 3-position track would quietly select High and report
// it as a success.
function levelIndex(level, positions = LEVEL_ORDER.length) {
  const i = LEVEL_ORDER.indexOf(level);
  if (i < 0 || !Number.isFinite(positions) || i >= positions) return null;
  return i;
}

function levelAtIndex(index, positions = LEVEL_ORDER.length) {
  if (!Number.isInteger(index) || index < 0) return null;
  if (index >= positions || index >= LEVEL_ORDER.length) return null;
  return LEVEL_ORDER[index];
}

// ---------------------------------------------------------------------------
// Automatic downgrade when a tier is not actually available
// ---------------------------------------------------------------------------
// Pro has its own quota and it runs out. Before this, a `pro` request that the account
// could no longer serve produced whatever the composer pill happened to show (usually
// the previous chat's level) with `thinking_verified: false` — i.e. the caller silently
// got a weaker answer than any tier it would have chosen deliberately.
//
// The fallback is one hop and explicit: pro → extra_high, the next tier down. It is NOT
// a general "retry everything cheaper" policy; a request for extra_high that fails stays
// a failure, because the caller asking for it has no cheaper intent to infer.
const DEFAULT_TIER_FALLBACKS = { pro: 'extra_high' };

// Per-tier override, e.g. TIER_FALLBACK_PRO=extended. An empty value or off/none/false
// disables the downgrade for that tier and restores the old "report what the UI shows"
// behavior.
const DISABLED_FALLBACK = new Set(['', 'off', 'none', 'no', 'false', '0', 'disable', 'disabled']);

function fallbackFor(mode, env = process.env) {
  const raw = env[`TIER_FALLBACK_${String(mode).toUpperCase()}`];
  if (raw === undefined) return DEFAULT_TIER_FALLBACKS[mode] || null;
  const s = String(raw).toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (DISABLED_FALLBACK.has(s)) return null;
  if (!MODE_TO_LEVEL[s]) {
    console.warn(`[tiers] TIER_FALLBACK_${String(mode).toUpperCase()}="${raw}" is not a known mode — using default`);
    return DEFAULT_TIER_FALLBACKS[mode] || null;
  }
  return s;
}

// Ordered list of tiers to try for a requested mode, best first. Cycle-safe: a mistyped
// env pair (pro→extra_high, extra_high→pro) yields each tier once instead of hanging.
function fallbackChainFor(mode, env = process.env) {
  const chain = [];
  let cur = mode;
  while (cur && MODE_TO_LEVEL[cur] && !chain.includes(cur)) {
    chain.push(cur);
    cur = fallbackFor(cur, env);
  }
  return chain.length ? chain : [mode];
}

// Wording that marks a menu item as quota-limited rather than merely missing. Used ONLY
// to label the reason in logs and metrics — never to decide a downgrade on its own. A
// regex over UI copy is far too weak a basis for refusing to click the tier the caller
// paid for; the decision comes from an explicit aria-disabled item or from the pill not
// moving after the click.
const LIMIT_HINT_RE = /(limit|лимит|исчерпан|недоступ|unavailable|resets?\b|upgrade|обновит)/i;

const DEFAULT_COOLDOWN_MS = 900 * 1000;

// ChatGPT can also reveal the exhausted quota only AFTER the prompt is sent: the tier stays
// selectable, the turn produces no answer, and a notice appears instead. Patterns are
// deliberately narrow (the tier word AND limit wording in one phrase) because the check runs
// against page text that already contains the caller's own prompt.
const TIER_LIMIT_PATTERNS = [
  /(reached|hit|used)\s+(all\s+)?(your|the)\s+[^.\n]{0,30}\bpro\b[^.\n]{0,30}(limit|quota)/i,
  /\bpro\b[^.\n]{0,40}(limit reached|limit is reached|quota (?:is )?(?:reached|exhausted))/i,
  /(limit|quota)[^.\n]{0,40}\bpro\b[^.\n]{0,40}(reached|exhausted|reset)/i,
  /(достигл[аи]?|исчерпан[аоы]?|закончил[аси]{0,3})[^.\n]{0,40}\bpro\b/i,
  /\bpro\b[^.\n]{0,40}(лимит[^.\n]{0,20}(исчерпан|закончил|достигн)|исчерпан)/i,
  /лимит[^.\n]{0,20}\bpro\b/i,
];

// Returns the tier whose limit the page is reporting, or null.
//
// Three guards, because the input is page text that also contains the caller's own prompt
// AND, on a continued conversation, everything said before:
//   - `armedFor` restricts the check to the tier we actually ran on;
//   - `prompt` is subtracted, so asking Pro to "расскажи, как работают лимиты Pro" cannot
//     abort its own request. Without this the loose patterns matched the question itself;
//   - `seen` (the page text captured BEFORE this turn) is subtracted, so a notice from an
//     earlier turn cannot kill every following request in the same conversation.
function detectTierLimit(pageText, armedFor, { prompt = '', seen = '' } = {}) {
  if (armedFor !== 'pro') return null;
  const text = String(pageText || '');
  if (!text) return null;
  const flat = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const echoed = flat(prompt);
  const before = flat(seen);
  for (const raw of text.split('\n')) {
    const line = flat(raw);
    if (!line) continue;
    if (!TIER_LIMIT_PATTERNS.some((rx) => rx.test(line))) continue;
    // The line is (part of) what we just sent — the user bubble, not a notice.
    if (echoed && echoed.includes(line)) continue;
    // ...or it was already on the page before we sent anything.
    if (before && before.includes(line)) continue;
    return { tier: 'pro', text: raw.trim().replace(/\s+/g, ' ').slice(0, 300) };
  }
  return null;
}

function cooldownMs(env = process.env) {
  const raw = String(env.TIER_UNAVAILABLE_COOLDOWN_SEC ?? '').trim();
  // An EMPTY value means "not configured" — Number('') is 0, which would have silently
  // disabled the memo for the very common `VAR=""` in a k8s manifest.
  if (!raw) return DEFAULT_COOLDOWN_MS;
  const n = Number(raw);
  // An explicit 0 disables the memo (probe the tier on every request); garbage keeps the default.
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  console.warn(`[tiers] TIER_UNAVAILABLE_COOLDOWN_SEC="${raw}" is not a number — using ${DEFAULT_COOLDOWN_MS / 1000}s`);
  return DEFAULT_COOLDOWN_MS;
}

// Remembers "this tier was not available just now" so a run of pro requests does not each
// pay ~2-4 s of opening the menu and failing to select. Availability is an ACCOUNT property,
// so this deliberately survives page and browser-context rebuilds; only time or a verified
// selection clears it.
const unavailable = new Map(); // mode -> { until, reason }
const strikes = new Map();     // mode -> { reason, count } — evidence toward memoizing
const fallbacks = new Map();   // "from>to" -> count

const tierAvailability = {
  markUnavailable(mode, reason, { env = process.env, now = Date.now() } = {}) {
    const ttl = cooldownMs(env);
    if (ttl <= 0) return;
    unavailable.set(mode, { until: now + ttl, reason: reason || 'unavailable' });
  },
  // Record evidence that a tier is unavailable and memoize it only once `stickyAfter`
  // consecutive observations agree. A single unverified click is a weak signal — Playwright
  // and the ChatGPT UI both produce them transiently, and a 15-minute memo on that basis
  // would downgrade every Pro request for a quarter of an hour over one flake (Codex review).
  // Absence of the item is nearly as weak on its own: the menu counts as "open" at two
  // visible levels, so an incomplete render looks exactly like a missing tier.
  noteUnavailable(mode, reason, { stickyAfter = 1, env = process.env, now = Date.now() } = {}) {
    // A reason that never memoizes still BREAKS the streak — "consecutive" has to mean
    // consecutive. Returning early here made not-offered → click-not-applied → not-offered
    // count as two agreeing observations (Codex review).
    if (!Number.isFinite(stickyAfter)) {
      strikes.delete(mode);
      return 0;
    }
    const prev = strikes.get(mode);
    const count = prev && prev.reason === reason ? prev.count + 1 : 1;
    strikes.set(mode, { reason, count });
    if (count >= stickyAfter) this.markUnavailable(mode, reason, { env, now });
    return count;
  },
  strikesFor(mode) {
    const entry = strikes.get(mode);
    return entry ? entry.count : 0;
  },
  // A verified selection is proof the tier is back — clear the memo immediately rather
  // than making the caller wait out a cooldown that reality has already invalidated.
  markAvailable(mode) {
    unavailable.delete(mode);
    strikes.delete(mode);
  },
  isCoolingDown(mode, { now = Date.now() } = {}) {
    const entry = unavailable.get(mode);
    if (!entry) return false;
    if (entry.until <= now) {
      unavailable.delete(mode);
      // Evidence expires with the memo: a fresh window needs fresh confirmations, otherwise
      // one sighting after every expiry re-blocks the tier forever.
      strikes.delete(mode);
      return false;
    }
    return true;
  },
  reasonFor(mode) {
    const entry = unavailable.get(mode);
    return entry ? entry.reason : null;
  },
  recordFallback(from, to) {
    const key = `${from}>${to}`;
    fallbacks.set(key, (fallbacks.get(key) || 0) + 1);
  },
  snapshot({ now = Date.now() } = {}) {
    return {
      cooldowns: [...unavailable.entries()]
        .filter(([, v]) => v.until > now)
        .map(([mode, v]) => ({ mode, seconds_left: Math.round((v.until - now) / 1000), reason: v.reason })),
      fallbacks: [...fallbacks.entries()].map(([key, count]) => {
        const [from, to] = key.split('>');
        return { from, to, count };
      }),
    };
  },
  // Tests only — module state must not leak between cases.
  _reset() {
    unavailable.clear();
    strikes.clear();
    fallbacks.clear();
  },
};

module.exports = {
  MODE_TO_LEVEL,
  LEVEL_TO_MODE,
  HIGH_EFFORT_MODES,
  LEVEL_ORDER,
  levelIndex,
  levelAtIndex,
  DEFAULT_TIER_FALLBACKS,
  fallbackFor,
  fallbackChainFor,
  LIMIT_HINT_RE,
  detectTierLimit,
  cooldownMs,
  DEFAULT_COOLDOWN_MS,
  tierAvailability,
};
