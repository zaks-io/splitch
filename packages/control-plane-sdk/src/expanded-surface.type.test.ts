import type { ApiKeysCreateOutput, ApiKeysListOutput } from "@splitch/contracts/route-types";
import { createControlPlaneSdk } from "./index";

/**
 * Compile-time checks for the route groups added alongside the panel screens:
 * environments, credentials, variant CRUD, targeting rules, and promotion.
 * The `@ts-expect-error` lines are enforced by `tsc` — each one fails the build
 * if the operation stops requiring that field.
 */
async function typeChecks() {
  const sdk = createControlPlaneSdk({ baseUrl: "https://control-plane.test" });

  // --- Environments (ADR-0027) -------------------------------------------
  await sdk.environments.list({ appId: "app_local" });
  // @ts-expect-error environments_list requires appId
  await sdk.environments.list({});

  await sdk.environments.create({ appId: "app_local", key: "staging" });
  // @ts-expect-error environments_create requires the Environment key
  await sdk.environments.create({ appId: "app_local" });

  await sdk.environments.get({ appId: "app_local", environmentId: "env_local" });
  // @ts-expect-error environments_get requires environmentId
  await sdk.environments.get({ appId: "app_local" });

  await sdk.environments.update({
    appId: "app_local",
    environmentId: "env_local",
    name: "Staging",
  });
  await sdk.environments.delete({ appId: "app_local", environmentId: "env_local" });

  // --- Credentials (ADR-0022) --------------------------------------------
  await sdk.credentials.clientKey.get({ appId: "app_local", environmentId: "env_local" });
  await sdk.credentials.clientKey.update({
    appId: "app_local",
    environmentId: "env_local",
    originAllowlist: ["https://example.test"],
  });
  await sdk.credentials.clientKey.update({
    appId: "app_local",
    environmentId: "env_local",
    // @ts-expect-error client_key_update takes no key material (.strict())
    keyMaterial: "pk_attacker_supplied",
  });

  await sdk.credentials.clientKey.rotate({ appId: "app_local", environmentId: "env_local" });
  // @ts-expect-error client_key_rotate requires environmentId
  await sdk.credentials.clientKey.rotate({ appId: "app_local" });

  await sdk.credentials.apiKeys.list({ appId: "app_local", environmentId: "env_local" });
  await sdk.credentials.apiKeys.create({
    appId: "app_local",
    environmentId: "env_local",
    scopes: ["flags:read"],
  });
  await sdk.credentials.apiKeys.revoke({
    appId: "app_local",
    environmentId: "env_local",
    keyId: "key_local",
  });
  // @ts-expect-error api_keys_revoke requires keyId
  await sdk.credentials.apiKeys.revoke({ appId: "app_local", environmentId: "env_local" });

  // --- Variant catalog ----------------------------------------------------
  await sdk.flags.createVariant({
    appId: "app_local",
    flagId: "flag_local",
    name: "treatment",
    value: true,
    idempotency_key: "idem_create_variant",
  });
  await sdk.flags.updateVariant({
    appId: "app_local",
    flagId: "flag_local",
    variantName: "treatment",
    description: "the new checkout",
    idempotency_key: "variant-update-1",
  });
  // @ts-expect-error flag_variants_update requires variantName
  await sdk.flags.updateVariant({
    appId: "app_local",
    flagId: "flag_local",
    description: "x",
    idempotency_key: "variant-update-2",
  });

  await sdk.flags.deleteVariant(
    {
      appId: "app_local",
      flagId: "flag_local",
      variantName: "treatment",
    },
    { idempotencyKey: "variant-delete-2" },
  );

  // --- Targeting rules and promotion --------------------------------------
  await sdk.flags.replaceTargetingRules({
    appId: "app_local",
    environmentId: "env_local",
    flagId: "flag_local",
    targetingRules: [],
    idempotency_key: "targeting-replace-1",
  });
  // @ts-expect-error flag_targeting_rules_replace requires the rule list
  await sdk.flags.replaceTargetingRules({
    appId: "app_local",
    environmentId: "env_local",
    flagId: "flag_local",
    idempotency_key: "targeting-replace-2",
  });

  await sdk.flags.promote({
    appId: "app_local",
    targetEnvironmentId: "env_prod",
    flagId: "flag_local",
    fromEnvironmentId: "env_dev",
    select: { enabled: true },
    idempotency_key: "promote-1",
  });
  // @ts-expect-error flags_promote requires the source Environment
  await sdk.flags.promote({
    appId: "app_local",
    targetEnvironmentId: "env_prod",
    flagId: "flag_local",
    select: { enabled: true },
    idempotency_key: "promote-2",
  });

  // --- Apps ---------------------------------------------------------------
  await sdk.apps.list({ orgId: "org_local" });
  await sdk.apps.get({ appId: "app_local" });
  await sdk.apps.update({ appId: "app_local", name: "Renamed" });
  // @ts-expect-error apps_update cannot change the immutable App key (.strict())
  await sdk.apps.update({ appId: "app_local", key: "new-key" });

  await sdk.apps.delete({ appId: "app_local" });
}

/**
 * Secret discipline (ADR-0018 / ADR-0022): the minted API Key's raw secret is a
 * once-only field on the CREATE response. Listing keys must expose no path back
 * to key material — if someone adds a secret field to the APIKey leaf, the
 * `@ts-expect-error` below stops erroring and this test fails to compile.
 */
function apiKeySecretStaysOnCreateOnly(
  created: ApiKeysCreateOutput,
  listed: ApiKeysListOutput,
): string {
  const onceOnlySecret: string = created.value;

  const [first] = listed.items;
  // @ts-expect-error a listed credential has no once-only raw secret to read
  void first?.value;
  // @ts-expect-error the APIKey leaf carries no key material at all
  void first?.keyMaterial;

  return onceOnlySecret;
}

void typeChecks;
void apiKeySecretStaysOnCreateOnly;
