import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  MCP_DELEGATION_PAIRS,
  validateHostedWorkerSecretEnv,
} from "./lib/hosted-worker-secrets.mjs";
import {
  delegationFixture,
  delegationValues,
  writeIngestDatasources,
  writeWorker,
} from "./lib/hosted-worker-secret-test-fixtures.mjs";

test("hosted secret validation exercises TINYBIRD_INGEST_TOKEN instead of trusting its presence", async () => {
  const root = delegationFixture();
  writeWorker(root, "event-ingest-api", ["TINYBIRD_INGEST_TOKEN"], {
    TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co",
  });
  const validate = (fetchImpl) =>
    validateHostedWorkerSecretEnv(
      root,
      "production",
      { ...delegationValues(), TINYBIRD_INGEST_TOKEN: "p.not-a-real-token" },
      { fetch: fetchImpl },
    );

  const calls = [];
  const recording = (status) => (url, init) => {
    calls.push({ url, ...init });
    return Promise.resolve(new Response(null, { status }));
  };

  // A non-empty token that Tinybird refuses is exactly what shipped: the deploy
  // was green and every Exposure was dropped at runtime.
  await assert.rejects(
    () => validate(recording(403)),
    /TINYBIRD_INGEST_TOKEN was rejected by api\.us-west-2\.aws\.tinybird\.co for Data Source "raw_evaluations" \(HTTP 403\)/,
  );
  // A right token in the wrong region reaches the API and 404s on the Data Source.
  await assert.rejects(() => validate(recording(404)), /\(HTTP 404\)/);
  // The probe sends the token in an Authorization header, so a transport failure
  // reports the error's class and nothing free-text out of it.
  await assert.rejects(
    () => validate(() => Promise.reject(new DOMException("socket hang up", "TimeoutError"))),
    (error) =>
      /could not be exercised against api\.us-west-2\.aws\.tinybird\.co \(TimeoutError\)/.test(
        error.message,
      ) && !error.message.includes("socket hang up"),
  );
  // A 5xx says nothing about the credential. Passing it through would ship the
  // exact unverified token this probe exists to catch.
  await assert.rejects(
    () => validate(recording(503)),
    /could not be verified against api\.us-west-2\.aws\.tinybird\.co for Data Source "raw_evaluations" \(HTTP 503\); deploying an unverified token drops Exposures silently/,
  );

  calls.length = 0;
  assert.deepEqual(await validate(recording(202)), [
    ...MCP_DELEGATION_PAIRS.map(({ name }) => name).sort(),
    "TINYBIRD_INGEST_TOKEN",
  ]);
  // Every Data Source the Worker appends to, probed with zero rows so the check
  // writes nothing. One scoped only to raw_events must not pass.
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "https://api.us-west-2.aws.tinybird.co/v0/events?name=raw_evaluations",
      "https://api.us-west-2.aws.tinybird.co/v0/events?name=raw_events",
    ],
  );
  assert.deepEqual(
    calls.map(({ body }) => body),
    ["", ""],
  );
  assert.equal(calls[0].headers.authorization, "Bearer p.not-a-real-token");
});

test("the ingest probe covers every Data Source the token is scoped to, with no second list", async () => {
  const root = delegationFixture();
  writeIngestDatasources(root, ["raw_events", "raw_evaluations", "raw_conversions"]);
  writeWorker(root, "event-ingest-api", ["TINYBIRD_INGEST_TOKEN"], {
    TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co",
  });

  const probed = [];
  await validateHostedWorkerSecretEnv(
    root,
    "production",
    { ...delegationValues(), TINYBIRD_INGEST_TOKEN: "p.not-a-real-token" },
    {
      fetch: (url) => {
        probed.push(new URL(url).searchParams.get("name"));
        return Promise.resolve(new Response(null, { status: 202 }));
      },
    },
  );

  // A Data Source added to the Tinybird project is probed on the next deploy
  // without editing the deploy script, which is the only way the two stay honest.
  assert.deepEqual(probed, ["raw_conversions", "raw_evaluations", "raw_events"]);
});

test("hosted secret validation exercises TINYBIRD_RUN_SNAPSHOT_TOKEN against its own scope", async () => {
  const root = delegationFixture();
  writeWorker(
    root,
    "control-plane-api",
    ["MCP_CONTROL_PLANE_DELEGATION_SECRET", "TINYBIRD_RUN_SNAPSHOT_TOKEN"],
    { TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co" },
  );
  writeFileSync(
    join(root, "infra", "tinybird", "datasources", "run_snapshots.datasource"),
    "TOKEN run_snapshots_ingest APPEND\n",
  );
  const env = { ...delegationValues(), TINYBIRD_RUN_SNAPSHOT_TOKEN: "p.not-a-real-token" };

  // The probe must exercise THIS token against THIS scope: the ingest-token
  // probe passing proves nothing about a second credential (the outage class
  // that motivated the probe was a present-but-wrong Tinybird token).
  const probed = [];
  await validateHostedWorkerSecretEnv(root, "production", env, {
    fetch: (url, init) => {
      probed.push({
        name: new URL(url).searchParams.get("name"),
        authorization: init.headers.authorization,
      });
      return Promise.resolve(new Response(null, { status: 202 }));
    },
  });
  assert.deepEqual(
    probed.filter(({ authorization }) => authorization === "Bearer p.not-a-real-token"),
    [{ name: "run_snapshots", authorization: "Bearer p.not-a-real-token" }],
  );

  await assert.rejects(
    () =>
      validateHostedWorkerSecretEnv(root, "production", env, {
        fetch: () => Promise.resolve(new Response(null, { status: 403 })),
      }),
    /TINYBIRD_RUN_SNAPSHOT_TOKEN was rejected by api\.us-west-2\.aws\.tinybird\.co for Data Source "run_snapshots" \(HTTP 403\)/,
  );
});

test("hosted secret validation fails loud when the ingest Worker declares no Tinybird API URL", async () => {
  const root = delegationFixture();
  writeWorker(root, "event-ingest-api", ["TINYBIRD_INGEST_TOKEN"]);

  await assert.rejects(
    () =>
      validateHostedWorkerSecretEnv(
        root,
        "production",
        { ...delegationValues(), TINYBIRD_INGEST_TOKEN: "p.not-a-real-token" },
        { fetch: () => assert.fail("must not probe without a resolved API URL") },
      ),
    /event-ingest-api production requires TINYBIRD_INGEST_TOKEN but declares no TINYBIRD_API_URL/,
  );
});
