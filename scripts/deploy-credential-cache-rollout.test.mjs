import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = new URL("../package.json", import.meta.url);

for (const environment of ["production", "shared-preview"]) {
  test(`${environment} deploys the Analysis Worker before its Control Plane caller`, async () => {
    const { scripts } = JSON.parse(await readFile(packageJson, "utf8"));
    const rollout = scripts[`deploy:cloudflare:${environment}`];

    assert.deepEqual(rollout.split(" && "), [
      `pnpm deploy:cloudflare:event-ingest:${environment}`,
      `pnpm deploy:cloudflare:analysis:${environment}`,
      `pnpm deploy:cloudflare:control-plane-compat:${environment}`,
      `pnpm deploy:cloudflare:evaluation:${environment}`,
      `pnpm credential-cache:backfill:${environment}`,
      `pnpm deploy:cloudflare:control-panel:${environment}`,
      `pnpm deploy:cloudflare:control-plane:${environment}`,
      `pnpm deploy:cloudflare:remaining:${environment}`,
    ]);
    assert.match(
      scripts[`deploy:cloudflare:analysis:${environment}`],
      /--filter=@splitch\/analysis-api/,
    );
    assert.match(
      scripts[`deploy:cloudflare:remaining:${environment}`],
      /--filter=!@splitch\/analysis-api/,
    );
    assert.match(
      scripts[`deploy:cloudflare:control-panel:${environment}`],
      new RegExp(`CLOUDFLARE_ENV=${environment} SPLITCH_GENERATED_WRANGLER_ENV=${environment}`),
    );
    assert.match(
      scripts[`deploy:cloudflare:remaining:${environment}`],
      new RegExp(`CLOUDFLARE_ENV=${environment} SPLITCH_GENERATED_WRANGLER_ENV=${environment}`),
    );
  });

  /**
   * Compat Control Plane publishes the Config Store DO RPC first, Evaluation
   * consumes it second, then the credential backfill and final Control Plane
   * complete the cutover (SPL-322 / ADR-0046).
   */
  test(`${environment} deploys Evaluation after compat and before the credential backfill`, async () => {
    const { scripts } = JSON.parse(await readFile(packageJson, "utf8"));
    const rollout = scripts[`deploy:cloudflare:${environment}`];

    assert.ok(
      rollout.indexOf(`deploy:cloudflare:control-plane-compat:${environment}`) <
        rollout.indexOf(`deploy:cloudflare:evaluation:${environment}`) &&
        rollout.indexOf(`deploy:cloudflare:evaluation:${environment}`) <
          rollout.indexOf(`credential-cache:backfill:${environment}`) &&
        rollout.indexOf(`credential-cache:backfill:${environment}`) <
          rollout.indexOf(`deploy:cloudflare:control-plane:${environment}`),
    );
    assert.equal(scripts[`deploy:cloudflare:evaluation-compat:${environment}`], undefined);
    assert.match(
      scripts[`deploy:cloudflare:remaining:${environment}`],
      /!@splitch\/evaluation-api/,
    );
  });
}
