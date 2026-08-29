import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPromotedForwardQueriesRemoved } from "./lib/tinybird-forward-query-cleanup-contract.mjs";

const DATASOURCES = [
  "raw_events",
  "deduped_exposures",
  "metric_events",
  "environment_exposure_status_state",
];
const fail = (message) => {
  throw new Error(message);
};

test("promoted datasource migrations are absent", () => {
  assert.doesNotThrow(() => assertPromotedForwardQueriesRemoved("infra/tinybird", fail));
});

test("a stale promoted migration fails the contract", (t) => {
  for (const name of DATASOURCES) {
    const root = copyDatasources(t);
    const path = join(root, "datasources", `${name}.datasource`);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8").trimEnd()}\n\nFORWARD_QUERY >\n    SELECT 1\n`,
    );
    assert.throws(
      () => assertPromotedForwardQueriesRemoved(root, fail),
      new RegExp(`${name} must not retain its completed one-release migration query`, "u"),
    );
  }
});

function copyDatasources(t) {
  const root = mkdtempSync(join(tmpdir(), "splitch-tinybird-forward-query-cleanup-"));
  const destination = join(root, "datasources");
  mkdirSync(destination);
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (const name of DATASOURCES) {
    writeFileSync(
      join(destination, `${name}.datasource`),
      readFileSync(`infra/tinybird/datasources/${name}.datasource`, "utf8"),
    );
  }
  return root;
}
