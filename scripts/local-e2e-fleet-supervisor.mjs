import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { localBindings } from "./local-e2e-fleet-config.mjs";
import { describeFault } from "./local-e2e-fleet-faults.mjs";

export function capturedChild(
  args,
  {
    cwd = resolve(import.meta.dirname, ".."),
    env = process.env,
    signal,
    command = process.execPath,
    onOutput,
    capture = true,
  } = {},
) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    if (capture) stdout += chunk;
    onOutput?.(chunk, process.stdout);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    if (capture) stderr += chunk;
    onOutput?.(chunk, process.stderr);
  });
  const completed = new Promise((done) => {
    child.once("error", () => {});
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
  return { child, completed, output: () => stdout + stderr };
}

export async function stopChild(running) {
  if (running.child.pid) {
    const kill = (signal) => {
      try {
        process.kill(-running.child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    const closed = await Promise.race([
      running.completed.then(() => true),
      delay(5_000, false, { ref: false }),
    ]);
    if (!closed) kill("SIGKILL");
  }
  await running.completed;
}

export function launchWorker(worker, runId, tracker, { quiet = false } = {}) {
  const args =
    worker.name === "control-plane-api"
      ? [...worker.args, "--var", `SPLITCH_LOCAL_E2E_RUN_ID:${runId}`]
      : worker.args;
  const env = {
    ...process.env,
    ...localBindings,
    ...worker.env,
    CI: "true",
    SPLITCH_LOCAL_E2E_RUN_ID: runId,
  };
  if (process.env.SPLITCH_LOCAL_DEV_FLEET === "true") {
    delete env.WORKOS_API_KEY;
    delete env.WORKOS_CLIENT_ID;
  }
  const captured = capturedChild(args, {
    command: worker.command,
    cwd: worker.cwd,
    env,
    capture: quiet,
    onOutput(chunk, sink) {
      if (!quiet) sink.write(chunk);
      for (const fault of tracker.scan(worker.name, chunk))
        if (!quiet) process.stderr.write(`${describeFault(fault)}\n`);
    },
  });
  captured.completed.then(() => {
    for (const fault of tracker.flush(worker.name))
      if (!quiet) process.stderr.write(`${describeFault(fault)}\n`);
  });
  const running = { ...worker, ...captured, process: captured.child, startedAt: Date.now() };
  return {
    ...running,
    stopped: captured.completed.then(({ code }) => ({ name: worker.name, code })),
  };
}

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
    const replacement = await relaunch(worker);
    await waitForHealth(replacement, { runId });
    log(`local-e2e-fleet: ${worker.name} recovered`);
    return replacement;
  }

  async function recover(fleet, stopped) {
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
    return restart(worker);
  }

  return {
    restarts,
    /**
     * Resolve once a Worker dies for a reason the harness cannot attribute to the
     * known D1 fault; recover in place from the ones it can.
     */
    async supervise(running, { signal } = {}) {
      let fleet = [...running];
      let onAbort;
      const aborted = new Promise((done) => {
        onAbort = () => done(null);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        while (!signal?.aborted) {
          const stopped = await Promise.race([...fleet.map((worker) => worker.stopped), aborted]);
          if (!stopped || signal?.aborted) return;
          const replacement = await recover(fleet, stopped);
          fleet = fleet.map((candidate) =>
            candidate.name === stopped.name ? replacement : candidate,
          );
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function watchWorker(worker) {
  return new Promise((resolveStop) => {
    worker.process.once("error", (error) => {
      resolveStop({ name: worker.name, error });
    });
    worker.process.once("exit", (code, signal) => {
      resolveStop({ name: worker.name, code, signal });
    });
  });
}

// A failed monitor owns cancellation; cleanup waits for the scenario's finally
// blocks before stopping Workers or removing private files.
export function createTaskScope(parentSignal) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let active;
  return {
    watch(monitored) {
      const finished = monitored.then(() => {
        if (!controller.signal.aborted) throw new Error("Fleet supervision stopped unexpectedly");
      });
      finished.catch((error) => controller.abort(error));
      return finished;
    },
    async run(task, monitored) {
      signal.throwIfAborted();
      if (active) throw new Error("A fleet scenario is already running");
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return task(signal);
      });
      active = operation;
      try {
        return await Promise.race([operation, monitored]);
      } catch (error) {
        controller.abort(error);
        await operation.catch(() => {});
        throw error;
      } finally {
        active = undefined;
      }
    },
    async close() {
      controller.abort();
      await active?.catch(() => {});
    },
  };
}

export async function failOnWorkerStop(running) {
  const stopped = await Promise.race(running.map((worker) => worker.stopped));
  const detail = stopped.error?.message ?? stopped.signal ?? `exit ${stopped.code ?? "unknown"}`;
  throw new Error(`${stopped.name} stopped unexpectedly (${detail})`);
}
