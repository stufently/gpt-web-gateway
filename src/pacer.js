// Proactive pacing between jobs: the missing half of rate limiting.
//
// The queue already serialises work (one browser, one request at a time) and
// there is already a rate-limit cooldown — but that cooldown is REACTIVE: it
// arms only after ChatGPT has refused. Nothing stopped a client from firing
// job after job back to back for hours, and ChatGPT's own anti-abuse noticed:
// the account got "You're making requests too quickly. We've temporarily
// limited access to your conversations", which also locks the human owner out
// of their own interactive session. A batch pipeline starving its own account
// is not a load problem to be tuned away — it is a missing limit.
//
// So the gap is measured from the previous job's FINISH, not its start. A gap
// measured from the start does nothing whenever the job itself runs longer
// than the gap, and these jobs take a minute or more each — the setting would
// have looked configured and changed nothing.
//
// Waiting happens inside the queue slot, so a waiting job keeps its place and
// callers see ordinary queue backpressure instead of a silent reordering.
//
// The wait beats a heartbeat while it lasts. Without one the liveness detector
// sees queued work and no progress and restarts a container that is doing
// exactly what it was told — and it would do that for any gap at or above
// HEALTH_STUCK_SEC, turning the limit into a self-inflicted outage. Warning
// about such a value is not enough: a deliberate pause is progress, and it
// should say so. Found by codex.
//
// What this paces is ONE UPSTREAM TURN, not one HTTP request. A batch request
// sends up to ten prompts inside a single job, and pacing the job alone left
// that burst untouched — the limit would have looked applied while ten turns
// went out back to back. Callers that make several turns call gate() around
// each of them. Found by codex.

const DEFAULT_GAP_MS = 60 * 1000;

// How often to beat while waiting. Far below any sane stuck threshold, and
// coarse enough that a minute-long pause is a couple of timers, not a spin.
const HEARTBEAT_MS = 30 * 1000;

// The liveness threshold, read the same way progress.js reads it. Both the
// oversized-gap warning and the heartbeat cadence below are relative to it, and
// two independent parses of the same variable would eventually disagree.
function stuckMsFrom(env = process.env) {
  return (parseInt(env.HEALTH_STUCK_SEC, 10) || 900) * 1000;
}

// A beat must land INSIDE the liveness window, not at a fixed 30s: the threshold
// has no lower bound, so HEALTH_STUCK_SEC=10 would be exceeded before the first
// beat ever fired and the probe would kill a container that was pacing exactly
// as told. Half the threshold leaves room for one missed beat. Found by codex.
function heartbeatMsFor(env = process.env) {
  return Math.max(250, Math.min(HEARTBEAT_MS, Math.floor(stuckMsFrom(env) / 2)));
}

function gapMs(env = process.env) {
  const raw = String(env.MIN_JOB_GAP_SEC ?? '').trim();
  const chosen = (() => {
    if (!raw) return DEFAULT_GAP_MS;
    const parsed = Number(raw);
    // 0 disables pacing deliberately — a single-user instance that never
    // batches has nothing to protect itself from, and a hardcoded floor would
    // be a limit nobody asked for.
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed * 1000);
    console.warn(`[pacer] MIN_JOB_GAP_SEC="${raw}" is not a number — using ${DEFAULT_GAP_MS / 1000}s`);
    return DEFAULT_GAP_MS;
  })();
  // A gap at or beyond the stuck threshold is unusually large: it is longer
  // than the window the liveness probe calls "hung". gate() beats the progress
  // heartbeat while it waits, so the container is no longer restarted for
  // obeying the setting — but a gap that big is worth saying out loud, since
  // every queued caller now waits past that threshold for its turn. Refusing
  // the value would be worse: it would override the operator. Found by agy.
  const stuckMs = stuckMsFrom(env);
  if (chosen >= stuckMs) {
    console.warn(
      `[pacer] MIN_JOB_GAP_SEC=${chosen / 1000}s is at or above HEALTH_STUCK_SEC=${stuckMs / 1000}s: `
      + 'unusually long; the heartbeat keeps the service alive, but every queued caller waits that long',
    );
  }
  return chosen;
}

function createPacer({
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  gap = gapMs(),
  heartbeat = () => {},
  heartbeatMs = heartbeatMsFor(),
} = {}) {
  // No previous finish yet: the first job goes straight through. Delaying it
  // would punish an idle instance for nothing — and an interactive one-off
  // request is exactly the traffic this module exists to protect.
  let lastFinishedAt = null;
  let waitedMs = 0;

  function waitFor() {
    if (!gap || lastFinishedAt === null) return 0;
    const elapsed = now() - lastFinishedAt;
    // Clock moved backwards (NTP step): treat it as "long enough ago" rather
    // than waiting out an interval that never happened.
    if (elapsed < 0) return 0;
    return Math.max(0, gap - elapsed);
  }

  return {
    /** Holds until the configured gap since the previous upstream turn has
     *  passed, beating a heartbeat so the wait reads as progress. Returns how
     *  long it actually waited. */
    async gate() {
      const total = waitFor();
      let pending = total;
      while (pending > 0) {
        const slice = Math.min(pending, heartbeatMs);
        await sleep(slice);
        heartbeat();
        // Take the clock's answer when it shortens the wait (a forward NTP step
        // should end it early), but never let the remainder fail to shrink: a
        // stalled clock would otherwise spin here forever, waking every beat and
        // never releasing the queue slot. Found by codex.
        pending = Math.min(waitFor(), pending - slice);
      }
      waitedMs += total;
      return total;
    },

    /** Stamps the finish of an upstream turn. Called for failures too: a
     *  refused or timed-out turn reached ChatGPT just as a successful one did,
     *  and the account counts it. Some pre-submit failures (login, upload)
     *  never reach ChatGPT and are stamped anyway — pacing an extra gap after
     *  those is harmless, while sorting them out reliably is not. */
    finished() {
      lastFinishedAt = now();
    },

    status() {
      return {
        min_gap_sec: gap / 1000,
        next_slot_in_sec: Math.ceil(waitFor() / 1000),
        throttled_seconds_total: Math.round(waitedMs / 1000),
      };
    },
  };
}

module.exports = {
  createPacer, gapMs, heartbeatMsFor, DEFAULT_GAP_MS, HEARTBEAT_MS,
};
