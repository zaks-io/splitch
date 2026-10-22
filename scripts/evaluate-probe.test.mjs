import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readConfig, runEvaluateProbe } from "./evaluate-probe.mjs";

const config = { clientKey: "test-client-key" };

test("probe requires an existing credential and never supplies a fallback", () => {
  assert.throws(() => readConfig({}), /SPLITCH_SMOKE_CLIENT_KEY is required/);
  assert.throws(() => readConfig({ SPLITCH_SMOKE_CLIENT_KEY: " " }), /is required/);
  assert.deepEqual(readConfig({ SPLITCH_SMOKE_CLIENT_KEY: config.clientKey }), config);
});

test("five bounded requests measure full responses and use the evaluate wire contract", async () => {
  const calls = [];
  const times = [0, 100, 100, 120, 120, 170, 170, 200, 200, 240];
  const result = await runEvaluateProbe(config, {
    now: () => times.shift(),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ variant: true }, { headers: { "cf-ray": "ray-test" } });
    },
  });
  assert.equal(result.medianMs, 40);
  assert.equal(result.p95Ms, 100);
  assert.equal(result.maxMs, 100);
  assert.equal(result.requests, 5);
  assert.equal(result.platformTarget, "shared-preview");
  assert.equal(new Set(calls.map(({ init }) => init.headers["idempotency-key"])).size, 5);
  for (const { url, init } of calls) {
    assert.equal(url, "https://edge.preview.splitch.dev/api/sdk/evaluate");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.authorization, `Bearer ${config.clientKey}`);
    assert.equal(JSON.parse(init.body).flagKey, "shared-preview-smoke");
    assert.match(JSON.parse(init.body).targetingKey, /^evaluate-probe-/);
  }
  assert.ok(result.measurements.every(({ cfRay }) => cfRay === "ray-test"));
  assert.doesNotMatch(JSON.stringify(result), /test-client-key|targetingKey|authorization/);
});

test("HTTP errors and malformed success responses fail loudly without response bodies", async () => {
  for (const response of [
    Response.json({ error: config.clientKey }, { status: 401 }),
    Response.json({ reason: "ERROR", value: config.clientKey }),
    new Response("not json"),
  ]) {
    await assert.rejects(
      runEvaluateProbe(config, { now: () => 0, fetch: async () => response }),
      (error) => {
        assert.match(error.message, /evaluate probe request 1/);
        assert.ok(!error.message.includes(config.clientKey));
        return true;
      },
    );
  }
});

test("network failures cannot leak headers through error messages", async () => {
  await assert.rejects(
    runEvaluateProbe(config, {
      now: () => 0,
      fetch: async () => {
        throw new Error(config.clientKey);
      },
    }),
    { message: "evaluate probe request 1 failed to complete" },
  );
});

test("scheduled probe is opt-in, preview-scoped and has no production or mutation authority", () => {
  const workflow = readFileSync(".github/workflows/evaluate-probe.yml", "utf8");
  assert.match(workflow, /cron: "23 \* \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /if: github.ref == 'refs\/heads\/main' && vars.SPLITCH_EVALUATE_PROBE_ENABLED == 'true'/,
  );
  assert.match(workflow, /environment: preview/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /SPLITCH_SMOKE_CLIENT_KEY: \$\{\{ secrets.SPLITCH_SMOKE_CLIENT_KEY \}\}/);
  assert.match(workflow, /run: node scripts\/evaluate-probe.mjs/);
  assert.doesNotMatch(
    workflow,
    /environment: production|CLOUDFLARE_API_TOKEN|SPLITCH_SMOKE_CLIENT_SECRET|pull_request:|push:/,
  );
});
