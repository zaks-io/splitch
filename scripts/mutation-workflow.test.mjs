import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/mutation.yml", "utf8");

test("scheduled mutation rotates packages and manual runs expose explicit scopes", () => {
  assert.match(workflow, /scope:\n\s+description: Package scope to mutate/);
  assert.match(workflow, /- all\n\s+- sdk\n\s+- contracts\n\s+- stats/);
  assert.match(workflow, /week="\$\(date -u \+%V\)"/);
  assert.match(workflow, /10#\$week % 3/);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
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
