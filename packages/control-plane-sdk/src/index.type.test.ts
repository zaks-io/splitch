import { createControlPlaneSdk } from "./index";

/**
 * Compile-time checks: typed route groups reject invalid inputs inferred from
 * contract route schemas. These `@ts-expect-error` lines are enforced by `tsc`.
 */
async function typeChecks() {
  const sdk = createControlPlaneSdk({ baseUrl: "https://control-plane.test" });

  await sdk.apps.create({
    orgId: "org_local",
    name: "Checkout",
    key: "checkout",
  });
  // @ts-expect-error apps_create requires the path orgId
  await sdk.apps.create({ name: "Checkout", key: "checkout" });

  await sdk.flags.list({ appId: "app_local" });
  // @ts-expect-error flags_list requires appId
  await sdk.flags.list({});

  await sdk.flags.getConfig({
    appId: "app_local",
    environmentId: "env_local",
    flagId: "flag_local",
  });
  // @ts-expect-error flag_config_get requires environmentId
  await sdk.flags.getConfig({ appId: "app_local", flagId: "flag_local" });

  await sdk.experiments.list({ appId: "app_local", environmentId: "env_local" });
  // @ts-expect-error experiments_list requires environmentId
  await sdk.experiments.list({ appId: "app_local" });

  // The body-less required-idempotency routes carry the key out-of-band, so the
  // options argument holds the requirement other routes get from their schema (SPL-266).
  const flagRef = { appId: "app_local", flagId: "flag_local" };
  await sdk.flags.delete(flagRef, { idempotencyKey: "idem_1" });
  // @ts-expect-error flags_delete requires an idempotency key
  await sdk.flags.delete(flagRef);
  // @ts-expect-error flags_delete requires an idempotency key
  await sdk.flags.delete(flagRef, {});

  const variantRef = { ...flagRef, variantName: "on" };
  await sdk.flags.deleteVariant(variantRef, { idempotencyKey: "idem_2" });
  // @ts-expect-error flag_variants_delete requires an idempotency key
  await sdk.flags.deleteVariant(variantRef);
  // @ts-expect-error flag_variants_delete requires an idempotency key
  await sdk.flags.deleteVariant(variantRef, {});
}

void typeChecks;
