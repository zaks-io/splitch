import { describe, expect, it } from "vitest";
import { accountRoutes } from "./routes/routes-account";
import { credentialRoutes } from "./routes/routes-credentials";
import { experimentRoutes } from "./routes/routes-experiments";
import { flagRoutes } from "./routes/routes-flags";

/**
 * The emit-only SDK apps select routes by INDEX (hc needs the statically-typed
 * tuple element to infer input/output). Indices silently change meaning under a
 * route reorder, so these tests pin the selected operationIds BY NAME: reorder a
 * route file and the failure names exactly which operation moved.
 */

const FLAGS_SDK_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
const EXPERIMENTS_SDK_INDICES = [0, 1, 2, 3, 4, 5] as const;
const APPS_SDK_INDICES = [8, 9, 10, 11, 12] as const;
const ENVIRONMENTS_SDK_INDICES = [13, 14, 15, 16, 17] as const;
const CREDENTIALS_SDK_INDICES = [0, 1, 2, 3, 4, 5] as const;

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

  it("fails loudly when a route file is reordered", () => {
    const reordered = [flagRoutes[1], flagRoutes[0], ...flagRoutes.slice(2)];

    expect(operationIdsAt(reordered, FLAGS_SDK_INDICES)).not.toEqual(
      operationIdsAt(flagRoutes, FLAGS_SDK_INDICES),
    );
  });
});
