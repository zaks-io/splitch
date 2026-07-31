import { HARNESS_FAULT_LABEL } from "./local-e2e-fleet-faults.mjs";

/**
 * SPL-181: a Playwright reporter that reads the fleet's fault log and attributes
 * failures to the harness instead of the product. Without it, a miniflare D1 crash
 * reads as an ordinary spec failure (or worse, as a wall of ERR_CONNECTION_REFUSED
 * in later specs) and verification agents chase the wrong bug. A detected fault
 * always fails the run, even when every spec happened to pass, because a run built
 * on a crashed fleet is not evidence.
 */
const FAULT_ENDPOINT = "http://127.0.0.1:18799/faults";
const POLL_MS = 1000;
// A crash logged just before a spec is reported can still be its cause.
const ATTRIBUTION_GRACE_MS = 2000;

export function faultsDuringTest(test, faults) {
  return faults.filter(
    (fault) =>
      fault.at >= test.startedAt - ATTRIBUTION_GRACE_MS &&
      fault.at <= test.endedAt + ATTRIBUTION_GRACE_MS,
  );
}

export function summariseFaults(tests, faults) {
  if (faults.length === 0) return "";
  const lines = [
    "",
    "=".repeat(72),
    HARNESS_FAULT_LABEL,
    `The local E2E fleet hit ${faults.length} miniflare D1 fault(s) during this run.`,
    "These are harness substrate failures (SQLITE_BUSY on a shared local D1), NOT product failures.",
    "",
  ];
  for (const fault of faults) {
    lines.push(`  - [${fault.worker}] ${fault.line}`);
  }
  const blamed = tests.filter((test) => faultsDuringTest(test, faults).length > 0);
  if (blamed.length > 0) {
    lines.push("", "Failing specs that overlap a harness fault (do not treat these as real):");
    for (const test of blamed) {
      lines.push(`  - ${test.title}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export default class LocalE2eFaultReporter {
  #faults = [];
  #tests = [];
  #timer;
  #runId = process.env.SPLITCH_LOCAL_E2E_RUN_ID ?? "";
  #fetchImpl;
  #log;

  constructor(options = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#log = options.log ?? console.error;
    if (options.runId) this.#runId = options.runId;
  }

  async pollOnce() {
    try {
      const response = await this.#fetchImpl(`${FAULT_ENDPOINT}?run=${this.#runId}`);
      if (!response.ok) return;
      const body = await response.json();
      if (Array.isArray(body?.faults)) this.#faults = body.faults;
    } catch {
      // The fleet owns this endpoint; while it is down there is nothing to read.
    }
  }

  onBegin() {
    this.#timer = setInterval(() => void this.pollOnce(), POLL_MS);
    this.#timer.unref?.();
  }

  onTestEnd(test, result) {
    if (result.status === "passed" || result.status === "skipped") return;
    const startedAt = result.startTime?.getTime?.() ?? Date.now();
    this.#tests.push({
      title: test.titlePath?.().filter(Boolean).join(" › ") ?? test.title,
      startedAt,
      endedAt: startedAt + (result.duration ?? 0),
    });
  }

  async onEnd(result) {
    clearInterval(this.#timer);
    await this.pollOnce();
    if (this.#faults.length === 0) return undefined;
    this.#log(summariseFaults(this.#tests, this.#faults));
    return { status: result.status === "passed" ? "failed" : result.status };
  }
}
