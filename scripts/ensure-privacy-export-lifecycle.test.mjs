import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ensurePrivacyExportLifecycle,
  PRIVACY_EXPORT_ABORT_RULE_ID,
} from "./ensure-privacy-export-lifecycle.mjs";

const desiredRule = {
  id: PRIVACY_EXPORT_ABORT_RULE_ID,
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { maxAge: 86_400, type: "Age" } },
};

test("leaves an exact one-day multipart abort rule unchanged", async () => {
  const calls = [];
  const result = await ensurePrivacyExportLifecycle({
    accountId: "account",
    apiToken: "token",
    bucketName: "privacy-exports",
    fetchImpl: fakeFetch([{ success: true, result: { rules: [desiredRule] } }], calls),
  });

  assert.deepEqual(result, { changed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, undefined);
});

test("replaces a stale named rule without dropping unrelated lifecycle rules", async () => {
  const calls = [];
  const unrelatedRule = {
    id: "expire-objects",
    enabled: true,
    conditions: { prefix: "exports/" },
    deleteObjectsTransition: { condition: { maxAge: 86_400, type: "Age" } },
  };
  const staleRule = {
    ...desiredRule,
    abortMultipartUploadsTransition: { condition: { maxAge: 604_800, type: "Age" } },
  };
  const result = await ensurePrivacyExportLifecycle({
    accountId: "account",
    apiToken: "token",
    bucketName: "privacy-exports",
    fetchImpl: fakeFetch(
      [
        { success: true, result: { rules: [unrelatedRule, staleRule] } },
        { success: true, result: {} },
        { success: true, result: { rules: [unrelatedRule, desiredRule] } },
      ],
      calls,
    ),
  });

  assert.deepEqual(result, { changed: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].init.body), { rules: [unrelatedRule, desiredRule] });
});

test("fails if Cloudflare does not persist the required rule", async () => {
  await assert.rejects(
    ensurePrivacyExportLifecycle({
      accountId: "account",
      apiToken: "token",
      bucketName: "privacy-exports",
      fetchImpl: fakeFetch([
        { success: true, result: { rules: [] } },
        { success: true, result: {} },
        { success: true, result: { rules: [] } },
      ]),
    }),
    /did not persist/u,
  );
});

test("every hosted Control Plane deploy enforces the lifecycle before deploying", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../apps/control-plane-api/package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts.deploy,
    "node ../../scripts/ensure-privacy-export-lifecycle.mjs $CLOUDFLARE_ENV && node ../../scripts/deploy-worker-with-sentry.mjs",
  );
});

function fakeFetch(payloads, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const payload = payloads.shift();
    assert.notEqual(payload, undefined, "unexpected request");
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
