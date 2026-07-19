import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_E2E_ANALYSIS_RESULTS } from "./local-e2e-fixtures.mjs";
import { createAnalysisFixtureServer } from "./local-e2e-analysis-fixture.mjs";

test("serves deterministic results through the existing Analysis API route", async (context) => {
  const server = createAnalysisFixtureServer("fixture-contract-test");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (!address || typeof address === "string") throw new Error("missing fixture server address");

  for (const fixture of LOCAL_E2E_ANALYSIS_RESULTS) {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/apps/${fixture.appId}/envs/${fixture.environmentId}/experiments/${fixture.experimentId}/results`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-splitch-local-e2e-run-id"), "fixture-contract-test");
    assert.deepEqual(await response.json(), fixture.result);
  }

  const missing = await fetch(
    `http://127.0.0.1:${address.port}/apps/app_checkout_e2e/envs/env_missing/experiments/experiment_missing/results`,
  );
  assert.equal(missing.status, 404);
});
