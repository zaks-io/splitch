import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { LOCAL_E2E_ANALYSIS_INPUTS } from "./local-e2e-analysis-inputs.mjs";
import { createAnalysisSourceServer } from "./local-e2e-analysis-source.mjs";
import { capturedChild } from "./local-e2e-fleet-supervisor.mjs";

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

test("isolated issuer preserves owner claims and cleanup requires exact tenant scope plus delete authority", async (context) => {
  const server = createAnalysisSourceServer("isolated-run", {
    origin: "http://127.0.0.1:12032",
    audience: "http://127.0.0.1:12030",
    principal: { sub: "user_local_e2e", scopes: ["app:app_checkout_e2e:owner"] },
    cleanupAppId: "app_checkout_e2e",
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { accessToken } = await fetch(`${base}/token`).then((response) => response.json());
  const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url"));
  assert.equal(claims.iss, "http://127.0.0.1:12032");
  assert.equal(claims.aud, "http://127.0.0.1:12030");
  assert.equal(claims.sub, "user_local_e2e");
  assert.deepEqual(claims.scopes, ["app:app_checkout_e2e:owner"]);
  const deletion = (condition, token = "local-e2e-tinybird-delete-token") =>
    fetch(`${base}/v0/datasources/environment_exposure_status_state/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams({ delete_condition: condition }),
    });
  assert.equal(
    (await deletion("app_id = 'app_checkout_e2e'", "local-e2e-tinybird-read-token")).status,
    401,
  );
  assert.equal((await deletion("app_id = 'app_checkout_e2e'")).status, 400);
  assert.equal(
    (await deletion("app_id = 'other_app' AND environment_id = 'env_temp'")).status,
    400,
  );
  assert.equal(server.fixture.cleanedEnvironments.size, 0);
  assert.equal(
    (await deletion("app_id = 'app_checkout_e2e' AND environment_id = 'env_temp'")).status,
    400,
  );
  for (const scope of [
    { app_id: "other_app", environment_id: "env_temp" },
    { app_id: "app_checkout_e2e" },
    { app_id: "app_checkout_e2e", environment_id: "env_temp' OR 1=1" },
  ]) {
    const invalid = await fetch(
      `${base}/v0/events?name=environment_exposure_status_deletions&wait=true`,
      {
        method: "POST",
        headers: { authorization: "Bearer local-e2e-tinybird-delete-token" },
        body: JSON.stringify(scope),
      },
    );
    assert.equal(invalid.status, 400);
  }
  const suppression = await fetch(
    `${base}/v0/events?name=environment_exposure_status_deletions&wait=true`,
    {
      method: "POST",
      headers: { authorization: "Bearer local-e2e-tinybird-delete-token" },
      body: JSON.stringify({ app_id: "app_checkout_e2e", environment_id: "env_temp" }),
    },
  );
  assert.equal(suppression.status, 200);
  assert.deepEqual(await suppression.json(), { successful_rows: 1, quarantined_rows: 0 });
  const response = await deletion("app_id = 'app_checkout_e2e' AND environment_id = 'env_temp'");
  assert.equal(response.status, 200);
  const job = await response.json();
  assert.equal(job.status, "waiting");
  const path = new URL(job.job_url).pathname;
  assert.equal((await fetch(`${base}${path}`)).status, 401);
  const completed = await fetch(`${base}${path}`, {
    headers: { authorization: "Bearer local-e2e-tinybird-delete-token" },
  });
  assert.deepEqual(await completed.json(), { status: "done" });
  assert.deepEqual([...server.fixture.cleanedEnvironments], ["env_temp"]);
});

test("standalone issuer ignores inherited full mode and missing or invalid full signing keys", async () => {
  const source = new URL("./local-e2e-analysis-source.mjs", import.meta.url).href;
  const code = `
    const { createAnalysisSourceServer } = await import(${JSON.stringify(source)});
    const server = createAnalysisSourceServer("standalone", { mode: "standalone", origin: "http://127.0.0.1:12032", audience: "http://127.0.0.1:12030" });
    const claims = JSON.parse(Buffer.from(server.fixture.accessToken().split(".")[1], "base64url"));
    console.log(JSON.stringify({ issuer: claims.iss, audience: claims.aud }));
  `;
  for (const invalid of [undefined, "invalid-fixture-jwk"]) {
    const env = { ...process.env, SPLITCH_LOCAL_DEV_FLEET: "true" };
    if (invalid === undefined) delete env.ACCESS_TOKEN_SECRET;
    else env.ACCESS_TOKEN_SECRET = invalid;
    const result = await capturedChild(["--input-type=module", "-e", code], { env }).completed;
    assert.equal(result.code, 0, "standalone source must not require the full signing key");
    assert.deepEqual(JSON.parse(result.stdout), {
      issuer: "http://127.0.0.1:12032",
      audience: "http://127.0.0.1:12030",
    });
  }
});

test("panel full mode keeps its configured signing key and canonical issuer", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const source = new URL("./local-e2e-analysis-source.mjs", import.meta.url).href;
  const code = `
    const { createAnalysisSourceServer } = await import(${JSON.stringify(source)});
    const { createPrivateKey, createPublicKey, verify } = await import("node:crypto");
    const server = createAnalysisSourceServer("panel");
    const parts = server.fixture.accessToken().split(".");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    const key = createPublicKey(createPrivateKey({ key: JSON.parse(process.env.ACCESS_TOKEN_SECRET), format: "jwk" }));
    const valid = verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), key, Buffer.from(parts[2], "base64url"));
    console.log(JSON.stringify({ issuer: claims.iss, audience: claims.aud, valid }));
  `;
  const env = {
    ...process.env,
    SPLITCH_LOCAL_DEV_FLEET: "true",
    ACCESS_TOKEN_SECRET: JSON.stringify(privateKey.export({ format: "jwk" })),
  };
  const result = await capturedChild(["--input-type=module", "-e", code], { env }).completed;
  assert.equal(result.code, 0, "panel full-mode source must accept its configured signing key");
  assert.deepEqual(JSON.parse(result.stdout), {
    issuer: "http://localhost:8791",
    audience: "http://127.0.0.1:18790",
    valid: true,
  });
});
