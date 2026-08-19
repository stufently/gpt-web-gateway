# Patchright compatibility: measured, not assumed (2026-07-29)

Follow-up to [2026-07-26-cloudflare-block-fingerprint-vs-egress.md](2026-07-26-cloudflare-block-fingerprint-vs-egress.md),
which rejected patchright. **That verdict is stale**, and this document records what replaced it
plus the API facts a migration has to be built on.

## Why the old verdict no longer holds

The rejection was explicit about its premise:

> `patchright` … Run headless, **as this service must**, it is worse than what we already have.

Its own measurement table has exactly one patchright row that passes — *real Chrome, headed
under Xvfb, persistent context → 200 PASS*. On **2026-07-27**, the day after, the service was
moved to headful under Xvfb for the Turnstile work (`HEADLESS=false`, `xvfb-run` in the
Dockerfile). The premise the rejection rested on disappeared the next day.

## What was measured

`patchright@1.61.1`, `npx patchright install chrome` → **Google Chrome 150** (build
`150.0.7871.186`), `channel: "chrome"`, `headless: false` under Xvfb, in a `node:20-slim` image
shaped like production. Probes are throwaway (scratchpad, not committed); the *findings* are the
artifact.

### Works — no migration cost

| Check | Result |
| --- | --- |
| `page.frames()` sees an iframe inside a **CLOSED** shadow root | **frames=2, `document.querySelectorAll('iframe')` = 0**, `boundingBox` 304×69 |
| `context.route` intercept + fulfil | works |
| `storageState` save → reload in a new context | cookie round-tripped |
| `exposeFunction` called from an **isolated** evaluate | works |
| `addInitScript` actually runs | confirmed via a DOM side effect |

The shadow-root row is the one that mattered most: `src/turnstile.js` finds the widget through
the CDP-derived frame graph precisely because the DOM cannot see through a closed root, and
patchright patches that layer (`Target.setAutoAttach`). It survives.

### The fingerprint gets strictly more coherent

This is the concrete win, and it removes two contradictions this repo had already documented as
unfixable under `puppeteer-extra-plugin-stealth`:

- `userAgent` — `Mozilla/5.0 (X11; Linux x86_64) … Chrome/150` with the frozen minor triplet,
  i.e. an ordinary desktop-Linux Chrome string
- `navigator.platform` — `Linux x86_64`; `navigator.webdriver` — `false`
- `getHighEntropyValues()` — `platform: "Linux"`, and `fullVersionList` reports
  `Not;A=Brand`, `Chromium` and `Google Chrome`, all at build `150.0.7871.186`

Two things follow, and both are improvements:

- **No `HeadlessChrome` token anywhere** — including in `fullVersionList`, where the current
  stack still leaks it (see the 2026-07-26 report, which called that out as not fixable there).
- **No Linux-masked-as-Windows.** The stealth bundle rewrites the platform to Windows while
  `navigator.platform` stays `Linux x86_64`; here every layer agrees.
- Real Chrome **150** against Chrome for Testing **145** today.

### The one real blocker, and its fix

**`evaluate` defaults to an ISOLATED world.** The Node signature takes a **third positional
boolean**, not an options object:

```js
await page.evaluate(fn, arg, false);   // MAIN world
await page.evaluate(fn, arg, {isolatedContext:false});  // throws: expected boolean, got object
```

Isolated worlds share the DOM, so plain `document.querySelector` code is unaffected. Anything
touching a **page global** is not — and this gateway has one that carries every streamed answer.

`src/chatgpt.js` patches `window.fetch` from an `addInitScript` (main world) and, from inside
that patched fetch, calls `window.__gwgSseChunk`, a binding installed by `page.exposeFunction`.
Measured behaviour:

| Sequence | `typeof window.__gwgSseChunk` in the main world |
| --- | --- |
| `exposeFunction` → `goto` → page code runs at t0/50/250/1000/2500 ms | **`undefined` at every point** |
| …then **one** `page.evaluate(fn, undefined, false)` | **`function`** — and a page-authored `<script>` sees it too |

So it is **not a race that waiting fixes** — the binding is absent until the main world is
touched once from Node. After priming, both a main-world evaluate and real page-authored
`<script>` code call it successfully and the payload reaches Node.

**Migration requirement:** prime the main world (one `evaluate(…, false)`) after each
navigation/page creation, *before* the tee is relied on, and buffer chunks in a page array while
the binding is still absent so nothing is dropped in the window before priming. Every `evaluate`
that reads or writes a `window.__gwg*` global needs the explicit `false`.

## What this does NOT establish

Nothing here shows that Cloudflare is what breaks `/api/auth/session` in production. The current
code collapses 403 / 5xx / redirect / network error into an identical `null`
(`src/chatgpt.js:749,755`), discarding `cf-mitigated`, `cf-ray`, content-type and the final URL —
the only evidence that would confirm or refute it. A cleaner fingerprint is worth having on its
own merits; it is not yet known to be the fix for the current outage.
