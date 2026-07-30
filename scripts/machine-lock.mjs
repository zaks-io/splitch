import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Machine-global advisory lock for machine-global singletons (e.g. the
// tinybird-local docker container: one name, one port set per machine).
// Concurrent agent sessions in different worktrees run the same checks and
// destroy each other's singleton mid-run without this. The path is fixed
// under /tmp on purpose: every session must agree on the rendezvous point,
// and per-process TMPDIR overrides would break that. Only cooperating
// callers are serialized; a process that touches the singleton without
// taking the lock can still interfere.

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * @param {string} name
 * @param {{ timeoutMs?: number; pollMs?: number }} [options]
 * @returns {Promise<{ release: () => void }>}
 */
export async function acquireMachineLock(name, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const lockDir = `/tmp/splitch-${name}.lock`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      return { release: () => rmSync(lockDir, { recursive: true, force: true }) };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }

    let ownerPid = Number.NaN;
    try {
      ownerPid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
    } catch {
      // Owner may be mid-acquire or mid-release; treat as held and poll.
    }

    if (Number.isFinite(ownerPid) && !processAlive(ownerPid)) {
      console.log(`machine-lock: removing stale ${name} lock from dead pid ${ownerPid}`);
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `machine-lock: timed out after ${Math.round(timeoutMs / 60000)}m waiting for ${name} lock held by pid ${ownerPid} (${lockDir})`,
      );
    }

    console.log(
      `machine-lock: ${name} is locked by pid ${ownerPid} (another run in a different session); waiting...`,
    );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
