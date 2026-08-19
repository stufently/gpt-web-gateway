FROM node:20-slim

WORKDIR /app

# Browsers are installed at build time as root, and the runtime user is not root (see USER
# below). Playwright's default cache is `/root/.cache/ms-playwright`, mode 0700 — invisible to
# any other user, so the container would start and then fail to find a browser at all. Pinning
# the path puts both engines' downloads somewhere the runtime user can actually read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# BOTH browsers ship, on purpose, for one release cycle.
#
# `BROWSER_ENGINE=patchright` (the default from 2.11.0) drives REAL Google Chrome; the legacy
# `stealth` engine drives Playwright's bundled Chromium. Keeping both means a rollback is one
# environment variable rather than an image rebuild — which matters because the thing being
# changed is the fingerprint, and the only honest way to judge it is in production. Drop the
# playwright line once the patchright engine has held a full canary.
RUN npx playwright install --with-deps chromium \
    && npx patchright install --with-deps chrome \
    && chmod -R a+rX /ms-playwright

# Xvfb, so the browser can run HEADFUL on a server with no display.
#
# Measured 2026-07-27: with the checkbox solver working, Cloudflare accepted every click and
# immediately served another challenge — a challenge loop, which is what its own docs call the
# symptom of a browser it does not trust. Headless is the strongest remaining signal: the
# `--headless` build differs from real Chrome well below the JS surface any evasion can patch.
# Under Xvfb the browser is a normal windowed Chrome that happens to draw to a virtual screen.
# `xauth` is only a Recommends of the xvfb package, so `--no-install-recommends` drops it — and
# `xvfb-run` shells out to it unconditionally to write the display cookie. Without it the
# container dies at once with `xvfb-run: error: xauth command not found` (prod, 2.8.0).
#
# `tini` is not optional either: `xvfb-run` is a shell script that waits on SIGUSR1 from the X
# server, and that handshake never completes when the script is PID 1 — measured in a clean
# image, the wrapped command produced no output at all and the container hung until killed.
# Under `tini -g --` the same command runs immediately, and `-g` also forwards SIGTERM to the
# whole process group and reaps the browser's orphaned children.
#
# `/tmp/.X11-unix` is created here rather than by the X server: the server creates it itself
# only when it is root, and this image runs as `node`. Without it every start prints
# `_XSERVTransmkdir: ERROR: euid != 0` and X falls back to abstract sockets — which happens to
# work on Linux, but is a fallback nobody chose and one a hardened runtime can take away.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY . .

# The runtime user owns everything it writes: `auth/` (the ChatGPT session — cookies that are
# effectively the account) and `public/images/`. Both are volume mount points in the Helm
# chart, so the chart also sets `fsGroup` to make the PVCs group-writable for this GID.
RUN mkdir -p auth public/images && chown -R node:node /app

# Non-root from here on. `node` (uid/gid 1000) ships with the base image. Chromium's own
# sandbox is already off (Playwright's `chromiumSandbox` default), so dropping root costs
# nothing at the browser layer and removes the container's most obvious escalation path.
USER node

EXPOSE 3000

# Headful by default now. `HEADLESS=true` still works and still runs — it is simply the
# configuration Cloudflare loops on, so it is no longer the default.
ENV HEADLESS=false
ENV PORT=3000
ENV DISPLAY=:99

# `xvfb-run -a` picks a free display number and cleans up after itself; the screen has to be
# large enough that the challenge widget is not clipped, since the solver clicks real
# coordinates on it. `--error-file` sends the X server's own log to stderr instead of a file
# nobody reads, so a failing display shows up in `kubectl logs`.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["xvfb-run", "-a", "--error-file=/dev/stderr", "--server-args=-screen 0 1280x800x24 -ac -nolisten tcp", "node", "src/server.js"]
