import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  METRIC_STUB_UNTIL_MARKER,
  metricStubTripwireFailures,
} from "./lib/tinybird-metric-stub-tripwire.mjs";

test("tripwire is quiet when metric_events does not exist yet", () => {
  const root = tinybirdRoot();
  writeStubPipe(root, "analysis_metric_values");
  writeStubPipe(root, "analysis_pre_period_covariates");

  assert.deepEqual(metricStubTripwireFailures(root), []);
});

test("tripwire fires when metric_events exists and stubs still carry the marker", () => {
  const root = tinybirdRoot();
  writeFileSync(join(root, "datasources", "metric_events.datasource"), "SCHEMA >\n");
  writeStubPipe(root, "analysis_metric_values");
  writeStubPipe(root, "analysis_pre_period_covariates");

  const failures = metricStubTripwireFailures(root);

  assert.equal(failures.length, 2);
  assert.match(failures[0] ?? "", /analysis_metric_values\.pipe still carries/);
  assert.match(failures[1] ?? "", /analysis_pre_period_covariates\.pipe still carries/);
});

test("tripwire is quiet once stubs are rewritten without the marker", () => {
  const root = tinybirdRoot();
  writeFileSync(join(root, "datasources", "metric_events.datasource"), "SCHEMA >\n");
  writeFileSync(
    join(root, "pipes", "analysis_metric_values.pipe"),
    "DESCRIPTION real\nSQL >\n    SELECT * FROM serve_deduped_metric_events\nTYPE ENDPOINT\n",
  );
  writeFileSync(
    join(root, "pipes", "analysis_pre_period_covariates.pipe"),
    "DESCRIPTION real\nSQL >\n    SELECT * FROM serve_deduped_metric_events\nTYPE ENDPOINT\n",
  );

  assert.deepEqual(metricStubTripwireFailures(root), []);
});

test("tripwire fails when metric_events exists but a stub pipe file is gone", () => {
  const root = tinybirdRoot();
  writeFileSync(join(root, "datasources", "metric_events.datasource"), "SCHEMA >\n");
  writeStubPipe(root, "analysis_metric_values");
  // analysis_pre_period_covariates intentionally missing

  const failures = metricStubTripwireFailures(root);

  assert.equal(failures.length, 2);
  assert.match(failures[0] ?? "", /analysis_metric_values\.pipe still carries/);
  assert.match(failures[1] ?? "", /analysis_pre_period_covariates\.pipe is missing/);
});

function tinybirdRoot() {
  const root = mkdtempSync(join(tmpdir(), "splitch-metric-stub-"));
  mkdirSync(join(root, "datasources"), { recursive: true });
  mkdirSync(join(root, "pipes"), { recursive: true });
  // Best-effort cleanup; tests are short-lived temp dirs.
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeStubPipe(root, name) {
  writeFileSync(
    join(root, "pipes", `${name}.pipe`),
    `DESCRIPTION stub\n${METRIC_STUB_UNTIL_MARKER}\nSQL >\n    SELECT 1 WHERE 0\nTYPE ENDPOINT\n`,
  );
}
