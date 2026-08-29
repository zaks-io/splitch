import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRetainedFamilyMigrationContract } from "./lib/tinybird-retained-family-migration-contract.mjs";

const DATASOURCES = ["raw_events", "deduped_exposures", "metric_events"];
const fail = (message) => {
  throw new Error(message);
};

test("retained-family migrations match every complete deployed schema", () => {
  assert.doesNotThrow(() => assertRetainedFamilyMigrationContract("infra/tinybird", fail));
});

test("retained-family migrations reject extra output and trailing clauses", (t) => {
  for (const name of DATASOURCES) {
    for (const mutate of [
      (contents) => contents.replace("    SELECT ", "    SELECT '' AS extra_column, "),
      (contents) => `${contents.trimEnd()}\n    WHERE 1\n`,
    ]) {
      const root = copyDatasources(t);
      const path = join(root, "datasources", `${name}.datasource`);
      writeFileSync(path, mutate(readFileSync(path, "utf8")));
      assert.throws(
        () => assertRetainedFamilyMigrationContract(root, fail),
        new RegExp(`${name} must carry its exact one-release retained-family migration`, "u"),
      );
    }
  }
});

function copyDatasources(t) {
  const root = mkdtempSync(join(tmpdir(), "splitch-tinybird-family-contract-"));
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
