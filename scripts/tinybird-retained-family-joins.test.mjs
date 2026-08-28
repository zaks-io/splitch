import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("every deployed analysis aggregation joins retained epochs by App family", () => {
  for (const name of [
    "analysis_metric_values",
    "analysis_ratio_metric_values",
    "analysis_pre_period_covariates",
  ]) {
    const pipe = readFileSync(`infra/tinybird/pipes/${name}.pipe`, "utf8");
    assert.match(pipe, /events\.entity_family_hash\s*=\s*exposures\.entity_family_hash/u, name);
  }
});
