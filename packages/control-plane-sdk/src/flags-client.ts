import type {
  FlagConfigGetInput,
  FlagConfigGetOutput,
  FlagConfigUpdateInput,
  FlagConfigUpdateOutput,
  FlagsCreateInput,
  FlagsCreateOutput,
  FlagsDeleteInput,
  FlagsDeleteOutput,
  FlagsGetInput,
  FlagsGetOutput,
  FlagsListInput,
  FlagsListOutput,
  FlagsPromoteInput,
  FlagsPromoteOutput,
  FlagsUpdateInput,
  FlagsUpdateOutput,
  FlagTargetingRulesReplaceInput,
  FlagTargetingRulesReplaceOutput,
  FlagVariantsCreateInput,
  FlagVariantsCreateOutput,
  FlagVariantsDeleteInput,
  FlagVariantsDeleteOutput,
  FlagVariantsUpdateInput,
  FlagVariantsUpdateOutput,
} from "@splitch/contracts/route-types";
import {
  type ControlPlaneHcOptions,
  createFlagsHcClient,
  type FlagsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import { withIdempotencyHeader } from "./idempotency-header";
import type {
  ControlPlaneIdempotentOperationOptions,
  ControlPlaneOperationOptions,
  ControlPlaneOperationResult,
} from "./operation-result";

export interface FlagsClient {
  list(
    input: FlagsListInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsListOutput>>;
  create(
    input: FlagsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsCreateOutput>>;
  get(
    input: FlagsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsGetOutput>>;
  update(
    input: FlagsUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsUpdateOutput>>;
  delete(
    input: FlagsDeleteInput,
    options: ControlPlaneIdempotentOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsDeleteOutput>>;
  createVariant(
    input: FlagVariantsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagVariantsCreateOutput>>;
  updateVariant(
    input: FlagVariantsUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagVariantsUpdateOutput>>;
  deleteVariant(
    input: FlagVariantsDeleteInput,
    options: ControlPlaneIdempotentOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagVariantsDeleteOutput>>;
  getConfig(
    input: FlagConfigGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagConfigGetOutput>>;
  updateConfig(
    input: FlagConfigUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagConfigUpdateOutput>>;
  replaceTargetingRules(
    input: FlagTargetingRulesReplaceInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagTargetingRulesReplaceOutput>>;
  promote(
    input: FlagsPromoteInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsPromoteOutput>>;
}

export function createFlagsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: FlagsHcClient,
): FlagsClient {
  const hcClient = client ?? createFlagsHcClient(hcOptions);

  return {
    list: (input, callOptions) =>
      invokeHcRoute<FlagsListOutput>("flags_list", () =>
        hcClient.apps[":appId"].flags.$get(
          { param: { appId: input.appId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    create: (input, callOptions) =>
      invokeHcRoute<FlagsCreateOutput>("flags_create", () =>
        hcClient.apps[":appId"].flags.$post(
          { param: { appId: input.appId }, json: input } as never,
          withIdempotencyHeader(
            "flags_create",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            input.idempotency_key,
          ),
        ),
      ),
    get: (input, callOptions) => flagsGet(hcClient, hcOptions, input, callOptions),
    update: (input, callOptions) => {
      const { appId, flagId, ...body } = input;
      return invokeHcRoute<FlagsUpdateOutput>("flags_update", () =>
        hcClient.apps[":appId"].flags[":flagId"].$patch(
          { param: { appId, flagId }, json: body } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    delete: (input, callOptions) =>
      invokeHcRoute<FlagsDeleteOutput>("flags_delete", () =>
        hcClient.apps[":appId"].flags[":flagId"].$delete(
          { param: { appId: input.appId, flagId: input.flagId } },
          withIdempotencyHeader(
            "flags_delete",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            callOptions?.idempotencyKey,
          ),
        ),
      ),
    // CreateVariantRequestSchema is `.strict()` and itself requires appId/flagId,
    // so the whole input is the body — stripping the path params would fail the
    // Worker's body validation.
    createVariant: (input, callOptions) =>
      invokeHcRoute<FlagVariantsCreateOutput>("flag_variants_create", () =>
        hcClient.apps[":appId"].flags[":flagId"].variants.$post(
          { param: { appId: input.appId, flagId: input.flagId }, json: input } as never,
          withIdempotencyHeader(
            "flag_variants_create",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            input.idempotency_key,
          ),
        ),
      ),
    updateVariant: (input, callOptions) => {
      const { appId, flagId, variantName, ...body } = input;
      return invokeHcRoute<FlagVariantsUpdateOutput>("flag_variants_update", () =>
        hcClient.apps[":appId"].flags[":flagId"].variants[":variantName"].$patch(
          {
            param: {
              appId,
              flagId,
              // Variant names are unconstrained z.string(); hc does not encode.
              variantName: encodeURIComponent(variantName),
            },
            json: body,
          } as never,
          withIdempotencyHeader(
            "flag_variants_update",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            body.idempotency_key,
          ),
        ),
      );
    },
    deleteVariant: (input, callOptions) =>
      invokeHcRoute<FlagVariantsDeleteOutput>("flag_variants_delete", () =>
        hcClient.apps[":appId"].flags[":flagId"].variants[":variantName"].$delete(
          {
            param: {
              appId: input.appId,
              flagId: input.flagId,
              // Variant names are unconstrained z.string(); hc does not encode.
              variantName: encodeURIComponent(input.variantName),
            },
          },
          withIdempotencyHeader(
            "flag_variants_delete",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            callOptions?.idempotencyKey,
          ),
        ),
      ),
    getConfig: (input, callOptions) =>
      invokeHcRoute<FlagConfigGetOutput>("flag_config_get", () =>
        hcClient.apps[":appId"].envs[":environmentId"].flags[":flagId"].config.$get(
          {
            param: {
              appId: input.appId,
              environmentId: input.environmentId,
              flagId: input.flagId,
            },
          },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    updateConfig: (input, callOptions) => {
      const { appId, environmentId, flagId, ...body } = input;
      return invokeHcRoute<FlagConfigUpdateOutput>("flag_config_update", () =>
        hcClient.apps[":appId"].envs[":environmentId"].flags[":flagId"].config.$patch(
          { param: { appId, environmentId, flagId }, json: body } as never,
          withIdempotencyHeader(
            "flag_config_update",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            body.idempotency_key,
          ),
        ),
      );
    },
    replaceTargetingRules: (input, callOptions) => {
      const { appId, environmentId, flagId, ...body } = input;
      return invokeHcRoute<FlagTargetingRulesReplaceOutput>("flag_targeting_rules_replace", () =>
        hcClient.apps[":appId"].envs[":environmentId"].flags[":flagId"]["targeting-rules"].$put(
          { param: { appId, environmentId, flagId }, json: body } as never,
          withIdempotencyHeader(
            "flag_targeting_rules_replace",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            body.idempotency_key,
          ),
        ),
      );
    },
    promote: (input, callOptions) => {
      const { appId, targetEnvironmentId, flagId, ...body } = input;
      return invokeHcRoute<FlagsPromoteOutput>("flags_promote", () =>
        hcClient.apps[":appId"].envs[":targetEnvironmentId"].flags[":flagId"].promote.$post(
          { param: { appId, targetEnvironmentId, flagId }, json: body } as never,
          withIdempotencyHeader(
            "flags_promote",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            body.idempotency_key,
          ),
        ),
      );
    },
  };
}

function flagsGet(
  hcClient: FlagsHcClient,
  hcOptions: ControlPlaneHcOptions,
  input: FlagsGetInput,
  callOptions?: ControlPlaneOperationOptions,
): Promise<ControlPlaneOperationResult<FlagsGetOutput>> {
  // Flag keys are unconstrained z.string() and may contain `/`, `?`, `#`, etc.
  // `hc` does not percent-encode path params (MCP's buildPath does); encode here
  // so ?by=key addresses the Flag the Panel named.
  //
  // Dot-segment keys (`.`, `..`, and percent-encoded spellings) survive
  // encodeURIComponent and are collapsed by the WHATWG URL parser onto a
  // different route — reject them before building the path.
  assertAddressableFlagSelector(input.flagId);
  const param = { appId: input.appId, flagId: encodeURIComponent(input.flagId) };
  return invokeHcRoute<FlagsGetOutput>("flags_get", () =>
    hcClient.apps[":appId"].flags[":flagId"].$get(
      // Omit `query` when `by` is absent so the id path stays byte-identical to
      // main (no trailing bare `?`). `as never` is the house hc pattern.
      (input.by === undefined ? { param } : { param, query: { by: input.by } }) as never,
      hcRequestOptions(withAuthorization(hcOptions, callOptions)),
    ),
  );
}

/**
 * A Flag key that cannot be placed in a URL path segment without the WHATWG
 * parser rewriting the request onto a different resource (collection root, App
 * root, or an empty segment). Percent-encoding is not a fix: `%2e` / `%2e%2e`
 * collapse the same way. Fail loud here rather than silently mis-address.
 */
class FlagSelectorUnaddressableError extends Error {
  constructor(selector: string) {
    super(
      `control-plane-sdk: Flag selector ${JSON.stringify(selector)} cannot be addressed as a path segment`,
    );
    this.name = "FlagSelectorUnaddressableError";
  }
}

function assertAddressableFlagSelector(selector: string): void {
  if (isUnaddressableFlagSelector(selector)) {
    throw new FlagSelectorUnaddressableError(selector);
  }
}

/**
 * Rejects `""`, `"."`, and `".."`, including any percent-encoded spelling
 * (case-insensitive hex) and multi-segment forms that contain one of those.
 */
function isUnaddressableFlagSelector(selector: string): boolean {
  return selector.split("/").some(isUnaddressablePathSegment);
}

function isUnaddressablePathSegment(segment: string): boolean {
  const normalized = fullyDecodePathSegment(segment);
  return normalized === "" || normalized === "." || normalized === "..";
}

function fullyDecodePathSegment(segment: string): string {
  let current = segment;
  for (;;) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (decoded === current) return current;
    current = decoded;
  }
}
