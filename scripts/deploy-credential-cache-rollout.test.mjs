import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const packageJson = new URL("../package.json", import.meta.url);

for (const environment of ["production", "shared-preview"]) {
  test(`${environment} deploys the v1/v2-compatible Evaluation Worker before rewriting credential caches`, async () => {
    const { scripts } = JSON.parse(await readFile(packageJson, "utf8"));
    const rollout = scripts[`deploy:cloudflare:${environment}`];

    assert.match(rollout, new RegExp(`^pnpm deploy:cloudflare:evaluation-compat:${environment}`));
    assert.ok(
      rollout.indexOf(`deploy:cloudflare:evaluation-compat:${environment}`) <
        rollout.indexOf(`credential-cache:backfill:${environment}`),
    );
    assert.match(
      scripts[`deploy:cloudflare:evaluation-compat:${environment}`],
      /@splitch\/evaluation-api/,
    );
    assert.match(
      scripts[`deploy:cloudflare:remaining:${environment}`],
      /!@splitch\/evaluation-api/,
    );
  });
}
