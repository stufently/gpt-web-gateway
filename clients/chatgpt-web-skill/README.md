# `chatgpt-web` skill — the client wrappers

The Claude Code skill that calls this gateway: `chat.sh` (chat completions / responses),
`generate.sh` (image generation and edits), `edit_image.py` (multipart edit helper), plus the
skill docs (`SKILL.md`, `rules.md`).

It lives here because it is a client of **this** API and has to move with it: every change to
`thinking_mode`, to the timeout ladder, or to the error envelope lands in both at once. Kept
outside git it was simply unbacked-up — the flags added on 2026-07-27 (`--extra-high`,
`--pro`) and the raised `--max-time` existed on exactly one disk.

## This is the canonical copy

The running copy is at `~/.claude/skills/chatgpt-web/` on the operator's machine. There are
therefore two copies and they can drift. Rule: **edit here, then sync out**.

```bash
# repo → live (deploy an update)
rsync -a --exclude .env clients/chatgpt-web-skill/ ~/.claude/skills/chatgpt-web/

# live → repo (capture an out-of-band edit before committing)
rsync -a --exclude .env --exclude README.md ~/.claude/skills/chatgpt-web/ clients/chatgpt-web-skill/

# check for drift without changing anything
diff -r --exclude=.env --exclude=README.md \
  clients/chatgpt-web-skill/ ~/.claude/skills/chatgpt-web/
```

## Credentials are NOT here

`.env` holds `CHATGPT_WEB_URL`, `CHATGPT_WEB_USER`, `CHATGPT_WEB_PASS` and is excluded by the
repo's `.gitignore`. Only `.env.example` is tracked. The sync commands above exclude it in
both directions, so a copy can never overwrite or publish the real one.

Note the repository is private, so the service hostname in the docs stays internal. If it is
ever opened up, sanitize `SKILL.md` and `rules.md` first.

## Keeping the two in step

The timeout ladder is the case where drift bites hardest, because each layer has to stay above
the one inside it (see the comment on the ingress annotation in `helm/templates/ingress.yaml`).
A `--max-time` here that is lower than the server budget silently turns a working slow request
into a client-side abort — which is exactly the bug `generate.sh` carried at 600 s while the
server was allowed 690 s for an image.
