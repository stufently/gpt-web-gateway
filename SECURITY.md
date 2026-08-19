# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab) rather than public
issues. You should get a response within a few days. There is no bug bounty.

## Threat model & hardening notes

- **Session cookies.** The `auth/` directory (mounted as a volume in Docker/
  Kubernetes) stores the ChatGPT session state, including cookies that grant
  full access to the account. Treat it like a credential store: private
  volume, restrictive permissions, never commit it, never bake it into an
  image. `.gitignore` and `.dockerignore` already exclude it.
- **App-level auth.** Set `API_KEY` to require `Bearer`/Basic credentials on
  all `/v1/*` and `/login/*` routes (browsers get a Basic auth prompt on
  `/login`). `/health`, `/health/live` and `/metrics` are intentionally
  unauthenticated (probes/scrapers); the web UI at `/` and generated images
  under `/images/` are not covered by `API_KEY` — protect them at your
  reverse proxy if exposed.
- **Do not expose the gateway to the public internet unauthenticated.** Anyone
  who can reach `/v1/*` can spend your account's quota and read generated
  images; anyone who can reach `/login` can interact with the browser session.
- **Debug snapshots** (`DEBUG_SNAPSHOTS=1`) write page screenshots and HTML to
  disk and may contain prompts and chat history. Off by default; enable only
  while debugging.
- **Generated images** under `public/images/` are served without auth by
  design (OpenAI-style `url` responses). Mount the volume accordingly.

## Disclaimer

This project automates the ChatGPT web interface, which **violates OpenAI's
Terms of Use** (automated/scripted access outside the official API):

- The ChatGPT account used with this gateway **can be suspended or banned
  without warning**. Use a dedicated account, not your personal one.
- This is **not** a payment bypass — a valid Plus/Pro subscription on that
  account is required, and the account's own rate limits still apply (the
  gateway enforces a queue and cooldowns to stay within them).
- The UI can change at any time and break automation; no availability
  guarantees are given.
- The software is provided **as-is**, for **educational purposes**, with **no
  warranty**. The authors accept no liability for account loss, data loss, or
  any other damages arising from its use.
