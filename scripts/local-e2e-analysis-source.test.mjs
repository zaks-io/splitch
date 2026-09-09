import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisSourceServer } from "./local-e2e-analysis-source.mjs";

test("serves authenticated deterministic Tinybird rows and local JWT evidence", async (context) => {
  const server = createAnalysisSourceServer("fixture-contract-test");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture server address");
  const base = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${base}/v0/pipes/analysis_run_inputs.json`);
  assert.equal(unauthorized.status, 401);

  const appended = await fetch(`${base}/v0/events?name=run_snapshots`, {
    method: "POST",
    headers: { authorization: "Bearer local-e2e-tinybird-read-token" },
  });
  assert.equal(appended.status, 200);
  assert.deepEqual(await appended.json(), { successful_rows: 1, quarantined_rows: 0 });

  const token = await fetch(`${base}/token`).then((response) => response.json());
  assert.equal(typeof token.accessToken, "string");
  assert.equal(token.accessToken.split(".").length, 3);

  const rows = await fetch(
    `${base}/v0/pipes/analysis_run_inputs.json?app_id=app_checkout_e2e&environment_id=env_checkout_prod_e2e&experiment_id=experiment_checkout_prod_e2e`,
    { headers: { authorization: "Bearer local-e2e-tinybird-read-token" } },
  ).then((response) => response.json());
  assert.equal(rows.data[0]?.run_id, "run_checkout_prod_e2e");
  assert.match(rows.data[0]?.config_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(rows.data[0]?.data_watermark, "2026-07-20T00:00:00.000Z");

  const metricRows = await fetch(`${base}/v0/pipes/analysis_metric_values_batch.json`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-e2e-tinybird-read-token",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      app_id: "app_checkout_e2e",
      environment_id: "env_checkout_dev_e2e",
      experiment_id: "experiment_checkout_significance_e2e",
      run_id: "run_checkout_significance_e2e",
    }),
  }).then((response) => response.json());
  assert.equal(metricRows.data.length, 675);
});
