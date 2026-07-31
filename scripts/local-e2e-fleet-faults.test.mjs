import assert from "node:assert/strict";
import test from "node:test";
import {
  createFaultTracker,
  describeFault,
  HARNESS_FAULT_LABEL,
  matchFaultSignature,
} from "./local-e2e-fleet-faults.mjs";

test("the hosted SQLITE_BUSY signature is recognised", () => {
  assert.ok(
    matchFaultSignature(
      "workerd/util/sqlite.c++:1671: failed: SENTRY_DO SQLite failed; NOSENTRY database is locked: SQLITE_BUSY",
    ),
  );
});

test("the opaque miniflare queryExecute crash is recognised", () => {
  assert.ok(matchFaultSignature("Error: internal error; reference = 3fdkkn6mbrahraja8v7p77rm"));
  assert.ok(
    matchFaultSignature(
      "    at D1DatabaseObject.queryExecute (miniflare/src/workers/d1/database.worker.ts:228:31)",
    ),
  );
});

test("the broader storage-fault family is recognised", () => {
  for (const line of [
    "Error: D1_ERROR: SQLITE_IOERR: disk I/O error",
    "SQLITE_BUSY_SNAPSHOT: database is locked",
    "failed: SQLITE_CANTOPEN: unable to open database file",
    "database table is locked",
    "    at D1DatabaseObject.fetch (miniflare/src/workers/d1/database.worker.ts:96:5)",
  ]) {
    assert.ok(matchFaultSignature(line), `expected a fault signature for: ${line}`);
  }
});

test("ordinary Worker output is not a fault", () => {
  assert.equal(matchFaultSignature("[wrangler] Ready on http://127.0.0.1:18790"), "");
  assert.equal(matchFaultSignature("GET /health 200 OK"), "");
});

test("a Worker's own deliberate error is NOT laundered into a harness fault", () => {
  // Mislabelling a product bug as a harness fault would hide it — the opposite of
  // the fail-loud contract this module exists to serve.
  assert.equal(
    matchFaultSignature('Error: control-panel D1 binding is read-only: refused "delete" statement'),
    "",
  );
  assert.equal(matchFaultSignature("Error: control-panel missing required CONTROL_PLANE_API"), "");
});

test("faults are detected across chunk boundaries", () => {
  const tracker = createFaultTracker({ now: () => 100 });
  assert.deepEqual(tracker.scan("control-panel", "Error: internal err"), []);
  const faults = tracker.scan("control-panel", "or; reference = abc123\nGET /health 200\n");
  assert.equal(faults.length, 1);
  assert.equal(faults[0].worker, "control-panel");
  assert.equal(faults[0].at, 100);
  assert.equal(tracker.count, 1);
});

test("a trailing partial line is flushed when a Worker dies mid-write", () => {
  const tracker = createFaultTracker();
  tracker.scan("control-plane-api", "NOSENTRY database is locked: SQLITE_BUSY");
  assert.equal(tracker.count, 0, "an unterminated line is not yet a fault");
  const flushed = tracker.flush("control-plane-api");
  assert.equal(flushed.length, 1);
  assert.equal(tracker.count, 1);
});

test("faults are filterable by the window a spec ran in", () => {
  let clock = 0;
  const tracker = createFaultTracker({ now: () => clock });
  clock = 10;
  tracker.scan("control-panel", "SQLITE_BUSY\n");
  clock = 30;
  tracker.scan("control-panel", "database is locked\n");
  assert.equal(tracker.since(20).length, 1);
  assert.equal(tracker.since(0).length, 2);
});

test("a fault describes itself with the SPL-181 label so it is never mis-attributed", () => {
  const tracker = createFaultTracker();
  const [fault] = tracker.scan("control-panel", "NOSENTRY database is locked: SQLITE_BUSY\n");
  const described = describeFault(fault);
  assert.ok(described.startsWith(HARNESS_FAULT_LABEL));
  assert.match(described, /control-panel/);
});
