# Text completion after the Chat UI change

Observed long structured replies returned a short prefix while the browser later
contained the entire answer. The current UI exposes `button[aria-label="Stop"]`,
which the completion detector did not recognize. Assistant search units also
include a screen-reader speaker heading outside their markdown content.

The fix keeps waiting while that button is present, extracts the semantic
assistant markdown, and rejects unfinished output at the deadline. Legacy
selectors and unwrapped assistant messages remain supported. No response is
repaired by guessing JSON or altering model scores.

Four regression cases initially produced three failures. They now pass:
quiet streaming prefix, speaker heading, literal speaker text, and unfinished
output at an expired budget. Run them with `node scripts/test-text-extraction.js`.
The cases are included in `npm test`.
