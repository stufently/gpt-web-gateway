// Memory-based recycle (2.17.0). Two OOMKills at the 8Gi limit (06.11 and 09.11) came from
// a burst of parallel short jobs: the pod went 2.8 → 7.1 GiB in four minutes, while the
// job-count recycle (PAGE_RECYCLE_AFTER_JOBS) waits for N finished jobs per slot and never
// looks at memory. The guard reads the same number the OOM killer and kubelet act on —
// the cgroup working set (memory.current minus inactive_file) — and acts in two levels:
//
//   soft (MEMORY_RECYCLE_SOFT_PCT of the limit): every slot gets a fresh page on its next
//     job. Running jobs are not touched, the pool keeps admitting work.
//   hard (MEMORY_RECYCLE_HARD_PCT): a full browser restart is requested as pool
//     maintenance. From that moment no new job starts (the pool queues them), running
//     jobs finish normally, then the browser is rebuilt and the queue resumes.
//
// The guard never aborts a job and never raises the limit. It only decides; the actions
// are injected, so the decision logic is tested without a browser or a cgroup.

const fs = require('fs');

const MIB = 1024 * 1024;

function pctFromEnv(raw, fallback, name) {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  console.warn(`[memory] ${name}="${s}" is not a number 0..100 — using ${fallback}`);
  return fallback;
}

function readFileTrim(fsImpl, file) {
  try {
    return String(fsImpl.readFileSync(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

function statField(text, field) {
  if (!text) return null;
  const m = text.match(new RegExp(`^${field} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : null;
}

// Reads { usage, limit } in bytes for this container. cgroup v2 first, then v1.
// usage is the working set (current − inactive_file), the same figure kubelet reports as
// container_memory_working_set_bytes and the one that runs into memory.max.
// limit is null when the cgroup is unlimited ("max", or the v1 near-2^63 sentinel).
// Returns null when no cgroup memory controller is readable (dev host, macOS).
function readCgroupMemory({ fsImpl = fs, root = '/sys/fs/cgroup' } = {}) {
  const v2Current = readFileTrim(fsImpl, `${root}/memory.current`);
  if (v2Current !== null && /^\d+$/.test(v2Current)) {
    const current = Number(v2Current);
    const inactive = statField(readFileTrim(fsImpl, `${root}/memory.stat`), 'inactive_file') || 0;
    const maxRaw = readFileTrim(fsImpl, `${root}/memory.max`);
    const limit = maxRaw && /^\d+$/.test(maxRaw) ? Number(maxRaw) : null;
    return { usage: Math.max(0, current - inactive), limit };
  }
  const v1Usage = readFileTrim(fsImpl, `${root}/memory/memory.usage_in_bytes`);
  if (v1Usage !== null && /^\d+$/.test(v1Usage)) {
    const current = Number(v1Usage);
    const inactive = statField(readFileTrim(fsImpl, `${root}/memory/memory.stat`), 'total_inactive_file') || 0;
    const limRaw = readFileTrim(fsImpl, `${root}/memory/memory.limit_in_bytes`);
    // v1 reports "no limit" as a page-aligned value near 2^63.
    const lim = limRaw && /^\d+$/.test(limRaw) ? Number(limRaw) : null;
    const limit = lim !== null && lim < 2 ** 60 ? lim : null;
    return { usage: Math.max(0, current - inactive), limit };
  }
  return null;
}

function mib(bytes) {
  return Math.round(bytes / MIB);
}

// readUsage() → { usage, limit } | null. limitOverride (bytes) replaces the cgroup limit.
// onSoft(info) / onHard(info) run the actions; neither may throw into the caller.
// onHard may return a promise (the restart): until it settles no second restart is
// requested, and the cooldown counts from its end, not from the request — draining the
// running jobs can take minutes, and a restart queued behind a restart is pure downtime.
function createMemoryGuard({
  readUsage,
  softPct = 70,
  hardPct = 80,
  limitOverride = null,
  hardCooldownMs = 120000,
  onSoft,
  onHard,
  now = () => Date.now(),
  log = (msg) => console.log(msg),
}) {
  if (typeof readUsage !== 'function') throw new TypeError('readUsage must be a function');
  if (typeof onSoft !== 'function' || typeof onHard !== 'function') {
    throw new TypeError('onSoft and onHard must be functions');
  }
  // 0 disables a level. A hard level below the soft one would skip the cheap step.
  const soft = softPct > 0 ? softPct : 0;
  const hard = hardPct > 0 ? Math.max(hardPct, soft) : 0;
  let level = 'ok';
  let lastHardAt = -Infinity;
  let hardInFlight = false;
  let disabledLogged = false;

  function runAction(fn, info, name) {
    try {
      return fn(info);
    } catch (err) {
      log(`[memory] ${name} action failed: ${err && err.message ? err.message : err}`);
      return undefined;
    }
  }

  function startHard(info) {
    const result = runAction(onHard, info, 'hard');
    if (!result || typeof result.then !== 'function') {
      lastHardAt = now();
      return;
    }
    hardInFlight = true;
    const done = () => {
      hardInFlight = false;
      lastHardAt = now();
    };
    result.then(done, done);
  }

  // reason: where the check runs ('before-job', 'after-job', 'timer') — goes to the log.
  // Returns the level seen: 'off' | 'ok' | 'soft' | 'hard'.
  function check(reason = 'check') {
    let sample = null;
    try {
      sample = readUsage();
    } catch {
      sample = null;
    }
    const limit = limitOverride || (sample && sample.limit) || null;
    if (!sample || !Number.isFinite(sample.usage) || !limit || (!soft && !hard)) {
      if (!disabledLogged) {
        disabledLogged = true;
        log('[memory] recycle by memory is off: no cgroup memory limit and no MEMORY_LIMIT_MB, or both levels are 0');
      }
      return 'off';
    }
    const pct = (sample.usage / limit) * 100;
    const info = {
      reason, usage: sample.usage, limit, pct: Math.round(pct * 10) / 10,
    };
    const text = `${mib(sample.usage)} MiB of ${mib(limit)} MiB (${info.pct}%) at ${reason}`;
    let seen = 'ok';
    if (hard && pct >= hard) seen = 'hard';
    else if (soft && pct >= soft) seen = 'soft';

    if (seen === 'hard') {
      const sinceHard = now() - lastHardAt;
      if (hardInFlight) {
        // Already requested: new jobs are held by the pending restart.
      } else if (sinceHard >= hardCooldownMs) {
        log(`[memory] ${text} ≥ hard ${hard}% — browser restart requested; new jobs wait until it is done, running jobs finish`);
        startHard(info);
      } else if (level !== 'hard') {
        // Above hard right after a restart: the memory is not the browser's, or it grew
        // back at once. Restarting again in a loop would only stop the service.
        log(`[memory] ${text} ≥ hard ${hard}% again ${Math.round(sinceHard / 1000)}s after a restart — next restart not before ${Math.round(hardCooldownMs / 1000)}s`);
      }
    } else if (seen === 'soft') {
      if (level === 'ok') {
        log(`[memory] ${text} ≥ soft ${soft}% — fresh pages on the next job of every slot`);
        runAction(onSoft, info, 'soft');
      }
    } else if (level !== 'ok') {
      log(`[memory] ${text} — back under ${soft || hard}%`);
    }
    level = seen;
    return seen;
  }

  return {
    check,
    level: () => level,
    config: () => ({ soft, hard, limitOverride, hardCooldownMs }),
  };
}

function configFromEnv(env = process.env) {
  const softPct = pctFromEnv(env.MEMORY_RECYCLE_SOFT_PCT, 70, 'MEMORY_RECYCLE_SOFT_PCT');
  const hardPct = pctFromEnv(env.MEMORY_RECYCLE_HARD_PCT, 80, 'MEMORY_RECYCLE_HARD_PCT');
  const limitMb = Number(String(env.MEMORY_LIMIT_MB ?? '').trim());
  const limitOverride = Number.isFinite(limitMb) && limitMb > 0 ? limitMb * MIB : null;
  const cooldownSec = Number(String(env.MEMORY_RECYCLE_COOLDOWN_SEC ?? '').trim());
  const hardCooldownMs = (Number.isFinite(cooldownSec) && cooldownSec >= 0 && String(env.MEMORY_RECYCLE_COOLDOWN_SEC ?? '').trim() !== ''
    ? cooldownSec : 120) * 1000;
  const intervalSec = Number(String(env.MEMORY_CHECK_INTERVAL_SEC ?? '').trim());
  const checkIntervalMs = (Number.isFinite(intervalSec) && intervalSec >= 0 && String(env.MEMORY_CHECK_INTERVAL_SEC ?? '').trim() !== ''
    ? intervalSec : 10) * 1000;
  return {
    softPct, hardPct, limitOverride, hardCooldownMs, checkIntervalMs,
  };
}

module.exports = {
  createMemoryGuard, readCgroupMemory, configFromEnv,
};
