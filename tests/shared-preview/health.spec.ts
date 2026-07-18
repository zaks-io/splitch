import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createFleetEvidence } from "../../scripts/lib/shared-preview-deployment-evidence.mjs";
import { test } from "./fixtures";

test.describe("shared-preview health", () => {
  test("every deployed surface reports the shared-preview target", async ({
    smokeConfig,
    smoke,
  }) => {
    const observations = [];
    for (const route of smokeConfig.healthRoutes) {
      await test.step(route.surface, async () => {
        observations.push(await smoke.assertHealth(route));
      });
    }
    const evidence = createFleetEvidence({
      expectedCommitSha: smokeConfig.expectedCommitSha,
      expectedPlatformTarget: smokeConfig.expectedPlatformTarget,
      observations,
    });
    const evidencePath = resolve(
      process.env.SPLITCH_SMOKE_EVIDENCE_FILE ??
        "test-results/shared-preview/deployment-evidence.json",
    );
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  });
});
