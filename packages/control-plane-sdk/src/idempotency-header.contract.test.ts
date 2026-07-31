import { routeRegistry } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { captureOutboundRequest } from "./idempotency-probe-capture";
import { type ControlPlaneSdk, createControlPlaneSdk } from "./index";

/**
 * SPL-261 regression contract.
 *
 * `worker-runtime/steps/idempotency.ts` reads the `Idempotency-Key` HEADER and
 * nothing else, so a route declaring `idempotency: "required"` is unusable by
 * any client that carries the key in the request body alone. #208 flipped four
 * Flag routes to `required` and every Control Panel Flag create started failing
 * with `Idempotency-Key header is required for this route`.
 *
 * This table is exhaustive BY CONSTRUCTION: the coverage assertion below fails
 * when a `required` Control Plane route has no probe, so a newly-required route
 * cannot ship without a client that proves it sends the header.
 */

const BASE_URL = "https://control-plane.test";
const KEY = "idem_contract_probe";
const SCOPE = { appId: "app_probe", environmentId: "env_probe", flagId: "flag_probe" } as const;

const probes: Record<string, (sdk: ControlPlaneSdk) => Promise<unknown>> = {
  flags_create: (sdk) =>
    sdk.flags.create({
      appId: SCOPE.appId,
      name: "Probe",
      key: "probe",
      schema: null,
      variants: [{ name: "on", value: true, isDefault: true }],
      idempotency_key: KEY,
    }),
  flags_delete: (sdk) =>
    sdk.flags.delete({ appId: SCOPE.appId, flagId: SCOPE.flagId }, { idempotencyKey: KEY }),
  flag_variants_create: (sdk) =>
    sdk.flags.createVariant({
      appId: SCOPE.appId,
      flagId: SCOPE.flagId,
      name: "off",
      value: false,
      idempotency_key: KEY,
    }),
  flag_variants_update: (sdk) =>
    sdk.flags.updateVariant({
      appId: SCOPE.appId,
      flagId: SCOPE.flagId,
      variantName: "off",
      description: "probe",
      idempotency_key: KEY,
    }),
  flag_variants_delete: (sdk) =>
    sdk.flags.deleteVariant(
      { appId: SCOPE.appId, flagId: SCOPE.flagId, variantName: "off" },
      { idempotencyKey: KEY },
    ),
  flag_config_update: (sdk) =>
    sdk.flags.updateConfig({ ...SCOPE, enabled: true, idempotency_key: KEY }),
  flag_targeting_rules_replace: (sdk) =>
    sdk.flags.replaceTargetingRules({ ...SCOPE, targetingRules: [], idempotency_key: KEY }),
  flags_promote: (sdk) =>
    sdk.flags.promote({
      appId: SCOPE.appId,
      targetEnvironmentId: SCOPE.environmentId,
      flagId: SCOPE.flagId,
      fromEnvironmentId: "env_source",
      select: { enabled: true },
      idempotency_key: KEY,
    }),
  experiments_start: (sdk) =>
    sdk.experiments.start({
      appId: SCOPE.appId,
      environmentId: SCOPE.environmentId,
      experimentId: "exp_probe",
      idempotency_key: KEY,
    }),
  approval_request_reviews_create: (sdk) =>
    sdk.approvals.review({
      appId: SCOPE.appId,
      id: `apr_${"0".repeat(26)}`,
      action: "decline",
      reason: "probe",
      idempotency_key: KEY,
    }),
};

/** Routes this SDK is the client for. Data-plane routes belong to `@splitch/sdk`. */
const requiredControlPlaneOperations = routeRegistry
  .filter((route) => route.idempotency === "required" && route.owner === "control-plane-api")
  .map((route) => route.operationId);

describe("control plane sdk idempotency header contract", () => {
  it("probes every required-idempotency Control Plane route", () => {
    const unprobed = requiredControlPlaneOperations.filter((id) => !(id in probes));
    expect(
      unprobed,
      `these routes declare idempotency: "required" but no SDK probe proves the client sends the Idempotency-Key header`,
    ).toEqual([]);
  });

  it.each(requiredControlPlaneOperations)("%s sends the Idempotency-Key header", async (id) => {
    const probe = probes[id];
    if (!probe) throw new Error(`no probe for "${id}"`);
    const request = await captureRequest(probe);
    expect(request.headers.get("idempotency-key")).toBe(KEY);
  });
});

function captureRequest(probe: (sdk: ControlPlaneSdk) => Promise<unknown>): Promise<Request> {
  return captureOutboundRequest((fetchImpl) =>
    probe(createControlPlaneSdk({ baseUrl: BASE_URL, fetch: fetchImpl })),
  );
}
