import { describeFault } from "./local-e2e-fleet-faults.mjs";

/**
 * SPL-181: a Worker killed by the miniflare D1 crash used to take the whole run
 * with it — the fleet exited, every later spec hit ERR_CONNECTION_REFUSED, and the
 * cascade read as a wall of product failures. Supervise instead: when a Worker
 * dies after emitting the known harness signature, say so loudly, bring it back,
 * and keep the run going. A death with no signature is still a hard failure,
 * because that is a real bug we must not swallow.
 */
const MAX_RESTARTS_PER_WORKER = 3;

export function createSupervisor({
  tracker,
  relaunch,
  waitForHealth,
  runId,
  log = console.error,
  maxRestarts = MAX_RESTARTS_PER_WORKER,
}) {
  const restarts = new Map();

  async function restart(worker) {
    const attempts = (restarts.get(worker.name) ?? 0) + 1;
    restarts.set(worker.name, attempts);
    if (attempts > maxRestarts) {
      throw new Error(
        `${worker.name} hit the SPL-181 miniflare D1 crash ${attempts} times; giving up after ${maxRestarts} restarts`,
      );
    }
    log(`local-e2e-fleet: restarting ${worker.name} (attempt ${attempts}/${maxRestarts})`);
    const replacement = relaunch(worker);
    await waitForHealth(replacement, { runId });
    log(`local-e2e-fleet: ${worker.name} recovered`);
    return replacement;
  }

  return {
    restarts,
    /**
     * Resolve once a Worker dies for a reason the harness cannot attribute to the
     * known D1 fault; recover in place from the ones it can.
     */
    async supervise(running) {
      let fleet = [...running];
      for (;;) {
        const stopped = await Promise.race(fleet.map((worker) => worker.stopped));
        const worker = fleet.find((candidate) => candidate.name === stopped.name);
        const faults = tracker
          .since(worker?.startedAt ?? 0)
          .filter((fault) => fault.worker === stopped.name);
        if (faults.length === 0) {
          const detail =
            stopped.error?.message ?? stopped.signal ?? `exit ${stopped.code ?? "unknown"}`;
          throw new Error(`${stopped.name} stopped unexpectedly (${detail})`);
        }
        log(describeFault(faults.at(-1)));
        const replacement = await restart(worker);
        fleet = fleet.map((candidate) =>
          candidate.name === stopped.name ? replacement : candidate,
        );
      }
    },
  };
}
