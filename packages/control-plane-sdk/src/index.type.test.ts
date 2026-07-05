import { createControlPlaneSdk } from "./index";

/**
 * Compile-time checks: typed route groups reject invalid inputs inferred from
 * contract route schemas. These `@ts-expect-error` lines are enforced by `tsc`.
 */
async function typeChecks() {
  const sdk = createControlPlaneSdk({ baseUrl: "https://control-plane.test" });

  await sdk.flags.list({ appId: "app_local" });
  // @ts-expect-error flags_list requires appId
  await sdk.flags.list({});

  await sdk.experiments.list({ appId: "app_local", environmentId: "env_local" });
  // @ts-expect-error experiments_list requires environmentId
  await sdk.experiments.list({ appId: "app_local" });
}

void typeChecks;
