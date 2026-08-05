import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/mutation.yml", "utf8");

test("scheduled mutation rotates packages and manual runs expose explicit scopes", () => {
  assert.match(workflow, /scope:\n\s+description: Package scope to mutate/);
  assert.match(workflow, /- all\n\s+- sdk\n\s+- contracts\n\s+- stats/);
  assert.match(workflow, /epoch_week="\$\(\( \$\(date -u \+%s\) \/ 604800 \)\)"/);
  assert.match(workflow, /epoch_week % 3/);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
});

test("the rotation stays continuous across an ISO year boundary", () => {
  const [, secondsPerWeek] = workflow.match(/date -u \+%s\) \/ (\d+) \)\)/) ?? [];
  assert.ok(secondsPerWeek, "workflow must derive the rotation index from epoch seconds");

  const selections = [
    // ISO 2026-W53, ISO 2027-W01, ISO 2027-W02. An ISO-week index restarts at 1
    // over this boundary and repeats a package; an epoch-week index does not.
    Date.UTC(2026, 11, 30),
    Date.UTC(2027, 0, 6),
    Date.UTC(2027, 0, 13),
  ].map((ms) => Math.floor(ms / 1000 / Number(secondsPerWeek)) % 3);

  assert.equal(new Set(selections).size, 3);
});

test("each package has an independent budget, baseline cache, and complete artifact", () => {
  assert.match(workflow, /name: Mutation \(\$\{\{ matrix\.name \}\}\)/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(
    workflow,
    /uses: actions\/cache@cdf6c1fa76f9f475f3d7449005a359c84ca0f306 # v5\.0\.3/,
  );
  assert.match(workflow, /path: \$\{\{ matrix\.report_dir \}\}\/stryker-incremental\.json/);
  assert.match(workflow, /timeout-minutes: 18/);
  assert.match(workflow, /pnpm --filter "\$\{\{ matrix\.workspace \}\}" test:mutation 2>&1 \| tee/);
  assert.match(workflow, /name: mutation-\$\{\{ matrix\.name \}\}-reports/);
  assert.match(workflow, /\$\{\{ matrix\.report_dir \}\}\/mutation\.html/);
  assert.match(workflow, /\$\{\{ matrix\.report_dir \}\}\/stryker-incremental\.json/);
  assert.match(workflow, /\$\{\{ matrix\.report_dir \}\}\/mutation\.log/);
  assert.match(workflow, /if-no-files-found: error/);
});
