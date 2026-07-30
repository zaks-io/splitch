import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountRoutes } from "./routes/routes-account";
import { approvalRoutes } from "./routes/routes-approvals";
import { credentialRoutes } from "./routes/routes-credentials";
import { experimentRoutes } from "./routes/routes-experiments";
import { flagRoutes } from "./routes/routes-flags";

/**
 * The emit-only SDK apps select routes by INDEX (hc needs the statically-typed
 * tuple element to infer input/output). Indices silently change meaning under a
 * route reorder, so these tests pin the selected operationIds BY NAME: reorder a
 * route file and the failure names exactly which operation moved.
 *
 * The indices are read out of the source rather than copied here. A copy would
 * only pin the route files: editing which routes the SDK app picks would leave
 * this test green while the exposed surface changed underneath it.
 */
const clientAppSource = readFileSync(
  new URL("./control-plane-client-app.ts", import.meta.url),
  "utf8",
);

/** Indices of the `<name>SdkRoutes` tuple as it is written in the source. */
function sdkIndices(tupleName: string): number[] {
  const tuple = new RegExp(`const ${tupleName} = \\[([\\s\\S]*?)\\] as const;`).exec(
    clientAppSource,
  );
  if (!tuple?.[1]) throw new Error(`control-plane-client-app.ts: no ${tupleName} tuple`);

  const indices = [...tuple[1].matchAll(/Routes\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (indices.length === 0) throw new Error(`control-plane-client-app.ts: ${tupleName} is empty`);
  return indices;
}

const FLAGS_SDK_INDICES = sdkIndices("flagsSdkRoutes");
const EXPERIMENTS_SDK_INDICES = sdkIndices("experimentsSdkRoutes");
const APPS_SDK_INDICES = sdkIndices("appsSdkRoutes");
const ENVIRONMENTS_SDK_INDICES = sdkIndices("environmentsSdkRoutes");
const CREDENTIALS_SDK_INDICES = sdkIndices("credentialsSdkRoutes");
const APPROVALS_SDK_INDICES = sdkIndices("approvalsSdkRoutes");

function operationIdsAt(
  routes: readonly { operationId: string }[],
  indices: readonly number[],
): string[] {
  return indices.map((index) => routes[index]?.operationId ?? `<missing index ${index}>`);
}

describe("control plane SDK route selection", () => {
  it("selects exactly the flag operations the SDK exposes", () => {
    expect(operationIdsAt(flagRoutes, FLAGS_SDK_INDICES)).toEqual([
      "flags_list",
      "flags_create",
      "flags_get",
      "flags_update",
      "flags_delete",
      "flag_variants_create",
      "flag_variants_update",
      "flag_variants_delete",
      "flag_config_get",
      "flag_config_update",
      "flag_targeting_rules_replace",
      "flags_promote",
    ]);
  });

  it("selects exactly the experiment operations the SDK exposes", () => {
    expect(operationIdsAt(experimentRoutes, EXPERIMENTS_SDK_INDICES)).toEqual([
      "experiments_list",
      "experiments_create",
      "experiments_get",
      "experiments_update",
      "experiments_start",
      "experiments_delete",
    ]);
  });

  it("selects exactly the App operations the SDK exposes", () => {
    expect(operationIdsAt(accountRoutes, APPS_SDK_INDICES)).toEqual([
      "apps_list",
      "apps_create",
      "apps_get",
      "apps_update",
      "apps_delete",
    ]);
  });

  it("selects exactly the Environment operations the SDK exposes", () => {
    expect(operationIdsAt(accountRoutes, ENVIRONMENTS_SDK_INDICES)).toEqual([
      "environments_list",
      "environments_create",
      "environments_get",
      "environments_update",
      "environments_delete",
    ]);
  });

  it("selects exactly the credential operations the SDK exposes", () => {
    expect(operationIdsAt(credentialRoutes, CREDENTIALS_SDK_INDICES)).toEqual([
      "client_key_get",
      "client_key_update",
      "client_key_rotate",
      "api_keys_list",
      "api_keys_create",
      "api_keys_revoke",
    ]);
  });

  it("selects exactly the Approval Request operations the SDK exposes", () => {
    expect(operationIdsAt(approvalRoutes, APPROVALS_SDK_INDICES)).toEqual([
      "approval_requests_list",
      "approval_requests_get",
      "approval_request_reviews_create",
    ]);
  });

  it("reads the indices the SDK app actually selects", () => {
    // Proves the coupling: these come from the source, so dropping a route from
    // the SDK app changes them here and fails the by-name assertions above.
    expect(FLAGS_SDK_INDICES).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(EXPERIMENTS_SDK_INDICES).toEqual([0, 1, 2, 3, 4, 5]);
    expect(APPS_SDK_INDICES).toEqual([9, 10, 11, 12, 13]);
    expect(ENVIRONMENTS_SDK_INDICES).toEqual([14, 15, 16, 17, 18]);
    expect(CREDENTIALS_SDK_INDICES).toEqual([0, 1, 2, 3, 4, 5]);
    expect(APPROVALS_SDK_INDICES).toEqual([0, 1, 2]);
  });

  it("fails loudly when the SDK app tuple cannot be found", () => {
    expect(() => sdkIndices("notASdkRoutesTuple")).toThrow("no notASdkRoutesTuple tuple");
  });

  it("fails loudly when a route file is reordered", () => {
    const reordered = [flagRoutes[1], flagRoutes[0], ...flagRoutes.slice(2)];

    expect(operationIdsAt(reordered, FLAGS_SDK_INDICES)).not.toEqual(
      operationIdsAt(flagRoutes, FLAGS_SDK_INDICES),
    );
  });
});
