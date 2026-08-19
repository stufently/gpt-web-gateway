# Contributing

Thanks for your interest in gpt-web-gateway!

## Ground rules

- Open an issue before large changes so the approach can be discussed.
- Keep dependencies minimal — the runtime deliberately uses a small set
  (Express, Playwright + stealth, multer, dotenv, uuid) and the tests use
  plain Node with no extra packages.
- UI selectors must degrade gracefully: prefer multiple fallbacks and
  soft-fails over hard crashes, and keep the `applied` echo honest about what
  was actually activated.

## Development

```bash
# Install deps once (no browser download needed for tests)
docker run --rm -v "$PWD":/app -w /app -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node:20-slim npm ci --omit=dev

# Run tests (pure node:assert scripts, no browser needed)
docker run --rm -v "$PWD":/app -w /app node:20-slim npm test

# Build the image
docker build -t gpt-web-gateway .
```

CI runs the same tests plus a Docker build on every push/PR.

## Pull requests

- Keep PRs focused; include a short description of the ChatGPT UI behavior
  you tested against (the UI changes often — note the date).
- Never include real credentials, cookies, or `auth/` contents in commits,
  fixtures, or debug snapshots.
