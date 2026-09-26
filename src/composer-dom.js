// Selectors for ChatGPT's composer, in one place. ChatGPT reshuffles this markup every few
// months; each list keeps the CURRENT markup first and the previous generation as fallback,
// so a rollback on their side (or an A/B bucket still on the old UI) keeps working.
//
// 2026-09-26 redesign (logged-in Pro page, measured live):
//   - editor: ProseMirror `div[contenteditable][role=textbox][data-composer-markdown]`
//     (aria-label "Ask ChatGPT") inside `form[data-chatgpt-composer]` — no `#prompt-textarea`;
//   - send: `button[type=submit][aria-label="Send"]` inside that form;
//   - attachments: `[data-composer-attachments]`, one chip per file with a
//     `button[aria-label="Remove <filename>"]` — no more "Remove file"/"Remove image" labels;
//   - tier control: `button[data-codex-intelligence-trigger]` (aria-label "Select ChatGPT
//     model"), text = current effort level; opens a menu with a 5-position power slider.
// The anonymous page renders a plain `<textarea name="prompt">` instead of ProseMirror.
//
// The thread lost `[data-message-author-role]` in the same redesign: a user message is now
// `[data-content-search-unit-key$=":user"]` (bubble `[data-user-message-bubble]`), an
// assistant message `[data-content-search-unit-key$=":assistant"]`. Those selectors are
// inlined in src/chatgpt.js page functions (they run in the browser and cannot import).

const COMPOSER_SELECTORS = [
  'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][data-composer-markdown]',
  '#prompt-textarea',
  'textarea[name="prompt"]',
];
const COMPOSER_SEL = COMPOSER_SELECTORS.join(', ');
// Only a VISIBLE editor counts — hidden mobile/duplicate composers must not satisfy a wait.
const COMPOSER_VISIBLE_SEL = COMPOSER_SELECTORS.map((s) => `${s}:visible`).join(', ');
// Composer tokens (the web-search pill etc.) live inside the editor.
const SYSTEM_HINT_SEL = COMPOSER_SELECTORS.map((s) => `${s} [data-system-hint-type]`).join(', ');

// NB: must keep the `send-button` testid in the list — it is also what the unit-test page
// doubles route on.
const SEND_BUTTON_SEL = [
  'form[data-chatgpt-composer] button[type="submit"]',
  'button[data-testid="send-button"]',
  '#composer-submit-button',
  'button[aria-label="Send"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label^="Отправить"]',
].join(', ');

const FILE_INPUT_SEL = [
  '#upload-photos',
  'form[data-chatgpt-composer] input[type="file"][accept*="image"]',
  'input[type="file"]:not(#upload-camera)',
].join(', ');

// One "Remove …" button per pending attachment. A single querySelectorAll over the union
// returns each element once, so overlapping selectors never double-count a chip.
const ATTACHMENT_REMOVE_SEL = [
  '[data-composer-attachments] button[aria-label^="Remove"]',
  '[data-composer-attachments] button[aria-label^="Удалить"]',
  'button[aria-label^="Remove file"]',
  'button[aria-label^="Remove attachment"]',
  'button[aria-label^="Remove image"]',
  'button[aria-label^="Удалить"]',
].join(', ');

// The effort ("Intelligence") trigger. `.__composer-pill` is the pre-2026-09 pill.
// The trigger is briefly not visible while the composer re-lays itself out (right after the
// Chat/Work switch), so anything that clicks uses the :visible variant AND waits for it.
const TIER_TRIGGER_SELECTORS = [
  'button[data-codex-intelligence-trigger]',
  'button[data-composer-navigation-target="reasoning"]',
  '.__composer-pill',
];
const TIER_TRIGGER_SEL = TIER_TRIGGER_SELECTORS.join(', ');
const TIER_TRIGGER_VISIBLE_SEL = TIER_TRIGGER_SELECTORS.map((s) => `${s}:visible`).join(', ');

// The trigger may carry a visually-collapsed caption ahead of the level ("Thinking effort
// Medium") depending on the composer width. Strip it before matching the level.
const TIER_CAPTION_RE = /^(thinking effort|intelligence|интеллект|уровень рассуждений)\s*/i;
function stripTierCaption(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(TIER_CAPTION_RE, '');
}

// Text currently in the composer. ProseMirror keeps it in the DOM (textContent), a
// <textarea> in `.value` — textContent of a textarea is only its initial markup.
async function readComposerText(loc) {
  const t = await loc.textContent();
  if (t) return t;
  try {
    return await loc.inputValue({ timeout: 1000 });
  } catch {
    return t;
  }
}

module.exports = {
  COMPOSER_SELECTORS,
  COMPOSER_SEL,
  COMPOSER_VISIBLE_SEL,
  SYSTEM_HINT_SEL,
  SEND_BUTTON_SEL,
  FILE_INPUT_SEL,
  ATTACHMENT_REMOVE_SEL,
  TIER_TRIGGER_SEL,
  TIER_TRIGGER_VISIBLE_SEL,
  TIER_CAPTION_RE,
  stripTierCaption,
  readComposerText,
};
