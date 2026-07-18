import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const packageJson = new URL("../package.json", import.meta.url);

for (const environment of ["production", "shared-preview"]) {
  test(`${environment} backfills credentials before deploying the schema-v2 Evaluation Worker`, async () => {
    const { scripts } = JSON.parse(await readFile(packageJson, "utf8"));
    const rollout = scripts[`deploy:cloudflare:${environment}`];

    assert.match(rollout, new RegExp(`^pnpm deploy:cloudflare:control-plane:${environment}`));
    assert.ok(
      rollout.indexOf(`credential-cache:backfill:${environment}`) <
        rollout.indexOf(`deploy:cloudflare:remaining:${environment}`),
    );
    assert.equal(scripts[`deploy:cloudflare:evaluation-compat:${environment}`], undefined);
    assert.doesNotMatch(
      scripts[`deploy:cloudflare:remaining:${environment}`],
      /!@splitch\/evaluation-api/,
    );
  });
}
