import { join } from "node:path";
import { check } from "./cli-pat-local-fixture.mjs";

const configOperations = ["flag_config_update", "flag_targeting_rules_replace", "flags_promote"];

// Expected permissions are literals from the spec, independent of the registry.
export async function checkTemporaryPermissionRefusals(context) {
  const { appId, flag } = context;
  const cases = [
    ["flag_config_update", ["flag-config", "update", flag], { enabled: false }, "write"],
    [
      "flag_targeting_rules_replace",
      ["flag-targeting-rules", "replace", flag],
      { targetingRules: [] },
      "write",
    ],
    ["client_key_rotate", ["client-key", "rotate"], undefined, "credentials"],
    ["api_keys_create", ["api-keys", "create"], { scopes: ["data-plane:evaluate"] }, "credentials"],
    [
      "flags_promote",
      ["flags", "promote", flag],
      { fromEnvironmentId: "prod", select: { enabled: true } },
      "write",
    ],
  ];
  const foreignCases = [
    ...cases,
    [
      "environments_create",
      ["envs", "create"],
      { key: "refused", temporary: { fromEnvironmentId: "prod" } },
      "write",
    ],
    ["environments_update", ["envs", "update"], { name: "Refused" }, "write"],
    ["environments_delete", ["envs", "delete"], undefined, "delete"],
    ["environments_sync", ["envs", "sync"], { fromEnvironmentId: "prod" }, "write"],
    ["client_key_get", ["client-key", "get"], undefined, "write"],
    ["client_key_update", ["client-key", "update"], { rateLimitRps: 20 }, "credentials"],
    ["api_keys_revoke", ["api-keys", "revoke", "cred_refused"], {}, "credentials"],
  ];
  await checkPermanentRefusals(context, cases);
  await checkForeignRefusals(context, foreignCases);
  console.log(
    "PASS CLI and MCP permanent writes refused by key, id and by=id; every opted-in route refused on another App's Temporary Environment",
  );
  const permanent = [
    "environments_create",
    ["envs", "create"],
    { key: "permanent-refused" },
    "write",
  ];
  await refuse(context, permanent, undefined, appId);
  console.log(
    "PASS CLI and MCP refuse permanent Environment creation with temporary-only authority",
  );
}

async function checkPermanentRefusals(context, cases) {
  for (const environment of ["dev", "prod"]) {
    for (const [selector, by] of [
      [environment, false],
      [`env_checkout_${environment}_e2e`, false],
      [`env_checkout_${environment}_e2e`, true],
    ]) {
      for (const entry of cases) await refuse(context, entry, selector, context.appId, by);
    }
  }
}

async function checkForeignRefusals(context, cases) {
  for (const [selector, by] of [
    ["pr-foreign", false],
    ["env_temporary_foreign_e2e", false],
    ["env_temporary_foreign_e2e", true],
  ]) {
    for (const entry of cases) {
      await refuse(context, entry, selector, "app_billing_e2e", by);
      if (entry[0] !== "environments_create")
        await refuse(context, entry, selector, context.appId, by);
    }
  }
}

function environmentInput(operation, environment, by) {
  if (operation === "environments_create") return {};
  return {
    [operation === "flags_promote" ? "targetEnvironmentId" : "environmentId"]: environment,
    ...(by ? { by: "id" } : {}),
  };
}

function operationInput(operation, flag) {
  return {
    ...(configOperations.includes(operation)
      ? { flagId: flag, idempotency_key: "temporary-refusal" }
      : {}),
    ...(operation === "api_keys_revoke" ? { keyId: "cred_refused" } : {}),
  };
}

function cliArguments(entry, environment, targetApp, by, root) {
  const [operation, command, body] = entry;
  const needsEnvironment = operation !== "environments_create";
  return [
    ...command,
    "--app",
    targetApp,
    ...(needsEnvironment ? ["--env", environment] : []),
    ...(by && needsEnvironment ? ["--by", "id"] : []),
    ...(body ? ["--body-json", JSON.stringify(body)] : []),
    ...(operation === "api_keys_create" ? ["--output-file", join(root, "refused-key.txt")] : []),
  ];
}

async function refuse(
  { client, secret, mcp, flag, root },
  entry,
  environment,
  targetApp,
  by = false,
) {
  const [operation, , body, permission] = entry;
  const cli = await client.cli(secret, cliArguments(entry, environment, targetApp, by, root), 4);
  const tool = await mcp(
    operation,
    {
      appId: targetApp,
      ...environmentInput(operation, environment, by),
      ...operationInput(operation, flag),
      ...(body ?? {}),
    },
    "FORBIDDEN",
  );
  for (const result of [cli, tool]) {
    check(result.code === "FORBIDDEN", `${operation} did not return FORBIDDEN`);
    check(
      JSON.stringify(result).includes(`${permission} permission`),
      `${operation} did not name ${permission} permission`,
    );
  }
}
