import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ensurePrivacyExportResources } from "./ensure-privacy-export-resources.mjs";

test("leaves existing privacy export resources unchanged", async () => {
  const calls = [];
  const result = await ensurePrivacyExportResources({
    accountId: "account",
    apiToken: "token",
    bucketName: "privacy-exports",
    queueNames: ["privacy-jobs", "privacy-jobs-dlq"],
    fetchImpl: fakeFetch(
      [
        response({ success: true, result: { name: "privacy-exports" } }),
        response({ success: true, result: { name: "privacy-exports" } }),
        queueList(["privacy-jobs", "privacy-jobs-dlq"]),
        queueList(["privacy-jobs", "privacy-jobs-dlq"]),
      ],
      calls,
    ),
    waitImpl: noWait,
  });

  assert.deepEqual(result, { created: [] });
  assert.equal(
    calls.every((call) => call.init.method === undefined),
    true,
  );
});

test("checks every queue list page", async () => {
  const result = await ensurePrivacyExportResources({
    accountId: "account",
    apiToken: "token",
    bucketName: "privacy-exports",
    queueNames: ["privacy-jobs", "privacy-jobs-dlq"],
    fetchImpl: fakeFetch([
      response({ success: true, result: { name: "privacy-exports" } }),
      response({ success: true, result: { name: "privacy-exports" } }),
      queueList(["privacy-jobs"], 2),
      queueList(["privacy-jobs-dlq"], 2),
      queueList(["privacy-jobs"], 2),
      queueList(["privacy-jobs-dlq"], 2),
    ]),
    waitImpl: noWait,
  });

  assert.deepEqual(result, { created: [] });
});

test("creates and verifies each missing resource", async () => {
  const calls = [];
  const result = await ensurePrivacyExportResources({
    accountId: "account",
    apiToken: "token",
    bucketName: "privacy-exports",
    queueNames: ["privacy-jobs", "privacy-jobs-dlq"],
    fetchImpl: fakeFetch(
      [
        response({ errors: [{ message: "not found" }], success: false }, 404),
        response({ success: true, result: { name: "privacy-exports" } }),
        response({ success: true, result: { name: "privacy-exports" } }),
        queueList([]),
        response({ success: true, result: { queue_name: "privacy-jobs" } }),
        response({ success: true, result: { queue_name: "privacy-jobs-dlq" } }),
        queueList(["privacy-jobs", "privacy-jobs-dlq"]),
      ],
      calls,
    ),
    waitImpl: noWait,
  });

  assert.deepEqual(result, {
    created: ["privacy-exports", "privacy-jobs", "privacy-jobs-dlq"],
  });
  assert.deepEqual(
    calls.filter((call) => call.init.method === "POST").map((call) => JSON.parse(call.init.body)),
    [
      { name: "privacy-exports" },
      { queue_name: "privacy-jobs" },
      { queue_name: "privacy-jobs-dlq" },
    ],
  );
});

test("retries queue verification while Cloudflare list results converge", async () => {
  const waits = [];
  const result = await ensurePrivacyExportResources({
    accountId: "account",
    apiToken: "token",
    bucketName: "privacy-exports",
    queueNames: ["privacy-jobs", "privacy-jobs-dlq"],
    fetchImpl: fakeFetch([
      response({ success: true, result: { name: "privacy-exports" } }),
      response({ success: true, result: { name: "privacy-exports" } }),
      queueList([]),
      response({ success: true, result: { queue_name: "privacy-jobs" } }),
      response({ success: true, result: { queue_name: "privacy-jobs-dlq" } }),
      queueList(["privacy-jobs"]),
      queueList(["privacy-jobs", "privacy-jobs-dlq"]),
    ]),
    waitImpl: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(result.created, ["privacy-jobs", "privacy-jobs-dlq"]);
  assert.deepEqual(waits, [1_000]);
});

test("fails when a created queue is absent from verification", async () => {
  await assert.rejects(
    ensurePrivacyExportResources({
      accountId: "account",
      apiToken: "token",
      bucketName: "privacy-exports",
      queueNames: ["privacy-jobs", "privacy-jobs-dlq"],
      fetchImpl: fakeFetch([
        response({ success: true, result: { name: "privacy-exports" } }),
        response({ success: true, result: { name: "privacy-exports" } }),
        queueList(["privacy-jobs"]),
        response({ success: true, result: { queue_name: "privacy-jobs-dlq" } }),
        ...Array.from({ length: 10 }, () => queueList(["privacy-jobs"])),
      ]),
      waitImpl: noWait,
    }),
    /did not persist queues: privacy-jobs-dlq/u,
  );
});

test("every hosted Control Plane deploy provisions resources before lifecycle policy", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../apps/control-plane-api/package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts.deploy,
    "node ../../scripts/ensure-privacy-export-resources.mjs $CLOUDFLARE_ENV && node ../../scripts/ensure-privacy-export-lifecycle.mjs $CLOUDFLARE_ENV && node ../../scripts/deploy-worker-with-sentry.mjs",
  );
});

function queueList(names, totalPages = 1) {
  return response({
    success: true,
    result: names.map((queue_name) => ({ queue_name })),
    result_info: { total_pages: totalPages },
  });
}

async function noWait() {}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(responses, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    assert.notEqual(next, undefined, "unexpected request");
    return next;
  };
}
