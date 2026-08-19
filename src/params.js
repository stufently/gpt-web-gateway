// Pure request-parameter parsing — no Express, no Playwright. Extracted so contract
// tests can exercise the exact production logic without booting the browser layer.

function parseBool(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

// Boolean env flag with an explicit default. Unlike parseBool (request params,
// absent = false), an ABSENT/empty env keeps the default, explicit false forms
// ('0'/'false'/'no'/'off') disable, explicit true forms enable, and anything else
// (typo like 'tru') logs a warning and keeps the default instead of silently
// flipping a default-on feature off.
function envFlag(name, defaultValue = false, env = process.env) {
  const raw = String(env[name] ?? '').toLowerCase().trim();
  if (!raw) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  console.warn(`[env] ${name}="${env[name]}" is not a recognized boolean — using default (${defaultValue})`);
  return defaultValue;
}

function normalizeThinkingMode(modeOrEnabled) {
  if (modeOrEnabled === true) return 'standard';
  if (modeOrEnabled === false || modeOrEnabled === undefined || modeOrEnabled === null) return 'instant';
  const s = String(modeOrEnabled).toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (['1', 'true', 'yes', 'on', 'think', 'thinking', 'standard', 'standart', 'thinking_standard'].includes(s)) return 'standard';
  // Top tiers, added 2026-07-27. They exist in the ChatGPT "Intelligence" dropdown for
  // non-Plus plans (Instant / Medium / High / Extra High / Pro) and were previously not
  // reachable through the API at all — worse, the adapter actively pushed the UI back down
  // to High when it found one of them selected.
  //
  // BREAKING: `pro` used to be an alias for `extended` (i.e. High). It now selects the real
  // Pro tier, which is what a caller asking for "pro" plainly means once that tier exists.
  // `advanced` / `deep` / `расширенный` keep pointing at `extended` for callers that meant
  // "the strong one" generically.
  // The UI's own level names are accepted too. Without them `thinking_mode: "high"` — the
  // obvious thing to try after looking at the dropdown — silently resolved to `instant`,
  // i.e. the exact opposite of what was asked for. Order matters: "extra high" normalises to
  // `extra_high` and is matched before the bare `high`.
  if (['pro', 'thinking_pro', 'pro_extended', 'pro_расширенный'].includes(s)) return 'pro';
  if (['extra_high', 'very_high', 'extrahigh', 'veryhigh', 'очень_высокий', 'очень_высокое'].includes(s)) return 'extra_high';
  if (['extended', 'thinking_extended', 'advanced', 'deep', 'high', 'высокий', 'расширенное', 'расширенный'].includes(s)) return 'extended';
  if (['medium', 'средний', 'среднее'].includes(s)) return 'standard';
  if (['0', 'false', 'no', 'off', 'instant', 'none', 'disable', 'disabled', 'no_thinking'].includes(s)) return 'instant';
  // Unknown values still fall back to `instant` (that contract is old and callers rely on
  // it), but they no longer do so in silence: a typo in an expensive mode used to be
  // indistinguishable from asking for no reasoning at all.
  if (s) console.warn(`[params] thinking_mode="${s}" is not recognized — falling back to instant`);
  return 'instant';
}

// NB: web_search no longer influences the mode (the instant→standard auto-upgrade was
// removed together with forced web search, 2026-07-10).
function parseThinkingMode(body) {
  const explicit = body.thinking_mode ?? body.reasoning_effort ?? body.mode;
  return explicit !== undefined ? normalizeThinkingMode(explicit) : normalizeThinkingMode(parseBool(body.thinking));
}

// web_search is DEPRECATED (removed 2026-07-10): accepted (snake_case and camelCase) and
// ignored. Returns what the client REQUESTED so routes can echo it honestly.
function parseWebSearchRequested(body) {
  return parseBool(body.web_search ?? body.webSearch);
}

module.exports = { parseBool, envFlag, normalizeThinkingMode, parseThinkingMode, parseWebSearchRequested };
