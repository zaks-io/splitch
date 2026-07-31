import assert from "node:assert/strict";
import test from "node:test";
import LocalE2eFaultReporter, {
  faultsDuringTest,
  summariseFaults,
} from "./local-e2e-fault-reporter.mjs";

const fault = (at, worker = "control-panel") => ({
  at,
  worker,
  line: "NOSENTRY database is locked: SQLITE_BUSY",
  signature: "SQLITE_BUSY",
});

test("a fault inside the spec window is attributed to that spec", () => {
  const spec = { title: "flags › creates a Flag", startedAt: 1000, endedAt: 2000 };
  assert.equal(faultsDuringTest(spec, [fault(1500)]).length, 1);
});

test("a fault far outside the spec window is not attributed to it", () => {
  const spec = { title: "flags › creates a Flag", startedAt: 1000, endedAt: 2000 };
  assert.equal(faultsDuringTest(spec, [fault(90_000)]).length, 0);
});

test("the summary names SPL-181 and the offending spec", () => {
  const spec = { title: "metrics › round-trips", startedAt: 1000, endedAt: 2000 };
  const summary = summariseFaults([spec], [fault(1500)]);
  assert.match(summary, /SPL-181 harness fault: miniflare D1 crashed/);
  assert.match(summary, /metrics › round-trips/);
  assert.match(summary, /NOT product failures/);
});

test("no faults means no noise", () => {
  assert.equal(summariseFaults([], []), "");
});

test("a green run is still failed when the fleet crashed underneath it", async () => {
  const logs = [];
  const reporter = new LocalE2eFaultReporter({
    runId: "run-1",
    log: (line) => logs.push(line),
    fetchImpl: async () => new Response(JSON.stringify({ faults: [fault(1500)] })),
  });
  const outcome = await reporter.onEnd({ status: "passed" });
  assert.equal(outcome.status, "failed", "a crashed fleet must never report a green run");
  assert.match(logs.join("\n"), /SPL-181 harness fault/);
});

test("a clean run is left alone", async () => {
  const reporter = new LocalE2eFaultReporter({
    runId: "run-1",
    log: () => assert.fail("must not log on a clean run"),
    fetchImpl: async () => new Response(JSON.stringify({ faults: [] })),
  });
  assert.equal(await reporter.onEnd({ status: "passed" }), undefined);
});

test("an unreachable fleet endpoint does not crash the reporter", async () => {
  const reporter = new LocalE2eFaultReporter({
    runId: "run-1",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(await reporter.onEnd({ status: "passed" }), undefined);
});
