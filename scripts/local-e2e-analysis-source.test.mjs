import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { LOCAL_E2E_ANALYSIS_INPUTS } from "./local-e2e-analysis-inputs.mjs";
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
  const claims = JSON.parse(Buffer.from(token.accessToken.split(".")[1], "base64url"));
  assert.equal(claims.typ, "access_token");
  assert.equal(claims.auth_door, "device_flow");

  const rows = await fetch(
    `${base}/v0/pipes/analysis_run_inputs.json?app_id=app_checkout_e2e&environment_id=env_checkout_prod_e2e&experiment_id=experiment_checkout_prod_e2e`,
    { headers: { authorization: "Bearer local-e2e-tinybird-read-token" } },
  ).then((response) => response.json());
  assert.equal(rows.data[0]?.run_id, "run_checkout_prod_e2e");
  assert.equal(rows.data[0]?.pre_registration, null);
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

test("every fixture Run supplies the Analysis Worker's required commitment columns", async (context) => {
  const workerUrl = new URL("../apps/analysis-api/src/results-run-commitments.ts", import.meta.url);
  const worker = ts.createSourceFile(
    workerUrl.pathname,
    readFileSync(workerUrl, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = worker.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((item) => ts.isIdentifier(item.name) && item.name.text === "COMMITMENT_FIELDS");
  assert.ok(declaration?.initializer, "Worker required commitment columns must be declared");
  assert.ok(ts.isAsExpression(declaration.initializer));
  const fields = declaration.initializer.expression;
  assert.ok(ts.isArrayLiteralExpression(fields));
  assert.ok(fields.elements.length > 0);
  const requiredColumns = fields.elements.map((field) => {
    assert.ok(ts.isStringLiteral(field), "required commitment columns must be string literals");
    return field.text;
  });

  const server = createAnalysisSourceServer("fixture-commitment-columns-test");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  for (const fixture of LOCAL_E2E_ANALYSIS_INPUTS) {
    const params = new URLSearchParams({
      app_id: fixture.appId,
      environment_id: fixture.environmentId,
      experiment_id: fixture.experimentId,
      run_id: fixture.runId,
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v0/pipes/analysis_run_inputs.json?${params}`,
      { headers: { authorization: "Bearer local-e2e-tinybird-read-token" } },
    );
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.length, 1, `missing fixture Run ${fixture.runId}`);
    assert.equal(data[0].run_id, fixture.runId);
    for (const column of requiredColumns) {
      assert.ok(Object.hasOwn(data[0], column), `${fixture.runId} omitted ${column}`);
      assert.equal(data[0][column], null, `${fixture.runId} must retain legacy ${column}`);
    }
  }
});
