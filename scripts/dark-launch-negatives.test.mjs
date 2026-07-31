import assert from "node:assert/strict";
import test from "node:test";
import { proveWrongAppIsolation } from "./dark-launch/app-isolation-proof.mjs";
import { assertStructuredAuthFailure } from "./dark-launch/cleanup.mjs";
import { buildSeedSql } from "./seed-shared-preview-smoke-sql.mjs";

test("shared-preview seed provides a live foreign Organization with a different owner", () => {
  const sql = buildSeedSql("2026-07-31T00:00:00.000Z");
  assert.match(sql, /org_shared_preview_isolation/);
  assert.match(sql, /app_shared_preview_isolation/);
  assert.match(sql, /user_shared_preview_isolation_owner/);
  assert.match(
    sql,
    /VALUES\s*\(\s*'org_shared_preview_isolation',\s*'user_shared_preview_isolation_owner',\s*'owner'/,
  );
  assert.doesNotMatch(
    sql,
    /VALUES\s*\(\s*'org_shared_preview_isolation',\s*'user_shared_preview_smoke'/,
  );
});

test("hosted wrong-App proof covers same-key resolution and a scoped KV miss", async () => {
  const calls = [];
  const deps = {
    orgId: "org-smoke",
    runId: "run-1",
    propagationWindowMs: 1,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "apps_create") {
        return {
          app: { id: "app-wrong" },
          environments: [{ id: "env-wrong", key: "dev" }],
        };
      }
      if (name === "client_key_get") return { keyMaterial: "wrong-client-key" };
      if (name === "flags_create") return { id: `flag-${args.key}` };
      if (name === "flag_config_update") return { enabled: true };
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const resources = {
    appId: "app-journey",
    environmentId: "env-journey",
    transientAppKeys: [],
  };
  const keys = {
    appKey: "dark-launch-app-run-1",
    appName: "Dark Launch run-1",
    flagKey: "dark-launch-run-1",
    targetedKey: "dark-launch-user-targeted-run-1",
  };
  const probes = { apps: [], flags: [] };
  const resolutions = [];
  const result = await proveWrongAppIsolation(
    deps,
    resources,
    keys,
    probes,
    async (_action, options) => {
      resolutions.push(options);
      if (options.flagKey.endsWith("-journey-only") && options.clientKey) {
        return { reason: "ERROR", errorCode: "FLAG_NOT_FOUND", value: false };
      }
      const variantName = options.clientKey ? "wrong-app-only" : "journey-app-only";
      return { reason: "DEFAULT", variantName, value: variantName };
    },
    "on",
  );

  assert.equal(result.resolvedVariant, "wrong-app-only");
  assert.equal(result.scopedMissErrorCode, "FLAG_NOT_FOUND");
  assert.equal(resolutions.at(-1).flagKey, "dark-launch-run-1-journey-only");
  assert.equal(resolutions.at(-1).clientKey, "wrong-client-key");
  assert.equal(probes.flags.length, 2);
  assert.deepEqual(probes.apps, ["app-wrong"]);
  assert.deepEqual(resources.transientAppKeys, ["dark-launch-app-run-1-wrong"]);
  assert.equal(calls.filter(({ name }) => name === "flags_create").length, 2);
});

test("assertStructuredAuthFailure requires the expected errorCode", async () => {
  await assertStructuredAuthFailure(
    async () => ({ reason: "ERROR", errorCode: "FLAG_NOT_FOUND", value: false }),
    "FLAG_NOT_FOUND",
    "wrong-App",
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => ({ reason: "ERROR", errorCode: "UNAUTHORIZED", value: false }),
        "FLAG_NOT_FOUND",
        "wrong-App",
      ),
    /expected errorCode FLAG_NOT_FOUND/,
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => {
          throw new Error("network down");
        },
        "CREDENTIAL_REVOKED",
        "revoked",
      ),
    /but the call threw/,
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => ({ reason: "DEFAULT", value: false }),
        "CREDENTIAL_REVOKED",
        "revoked",
      ),
    /expected reason ERROR/,
  );
});
