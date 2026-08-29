import type {
  FlagConfigGetInput,
  FlagConfigGetOutput,
  FlagConfigUpdateInput,
  FlagConfigUpdateOutput,
  FlagsPromoteInput,
  FlagsPromoteOutput,
  FlagTargetingRulesReplaceInput,
  FlagTargetingRulesReplaceOutput,
} from "@splitch/contracts/route-types";
import { environmentSelectorQuery } from "./environment-selector-query";
import {
  type ControlPlaneHcOptions,
  type FlagsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import { withIdempotencyHeader } from "./idempotency-header";
import type { ControlPlaneOperationOptions } from "./operation-result";

export function getFlagConfig(
  client: FlagsHcClient,
  options: ControlPlaneHcOptions,
  input: FlagConfigGetInput,
  callOptions?: ControlPlaneOperationOptions,
) {
  const param = {
    appId: input.appId,
    environmentId: input.environmentId,
    flagId: input.flagId,
  };
  return invokeHcRoute<FlagConfigGetOutput>("flag_config_get", () =>
    client.apps[":appId"].envs[":environmentId"].flags[":flagId"].config.$get(
      { param, ...environmentSelectorQuery(input) } as never,
      hcRequestOptions(withAuthorization(options, callOptions)),
    ),
  );
}

export function updateFlagConfig(
  client: FlagsHcClient,
  options: ControlPlaneHcOptions,
  input: FlagConfigUpdateInput,
  callOptions?: ControlPlaneOperationOptions,
) {
  const { appId, environmentId, flagId, by, ...body } = input;
  return invokeHcRoute<FlagConfigUpdateOutput>("flag_config_update", () =>
    client.apps[":appId"].envs[":environmentId"].flags[":flagId"].config.$patch(
      {
        param: { appId, environmentId, flagId },
        ...environmentSelectorQuery({ by }),
        json: body,
      } as never,
      withIdempotencyHeader(
        "flag_config_update",
        hcRequestOptions(withAuthorization(options, callOptions)),
        body.idempotency_key,
      ),
    ),
  );
}

export function replaceFlagTargetingRules(
  client: FlagsHcClient,
  options: ControlPlaneHcOptions,
  input: FlagTargetingRulesReplaceInput,
  callOptions?: ControlPlaneOperationOptions,
) {
  const { appId, environmentId, flagId, by, ...body } = input;
  return invokeHcRoute<FlagTargetingRulesReplaceOutput>("flag_targeting_rules_replace", () =>
    client.apps[":appId"].envs[":environmentId"].flags[":flagId"]["targeting-rules"].$put(
      {
        param: { appId, environmentId, flagId },
        ...environmentSelectorQuery({ by }),
        json: body,
      } as never,
      withIdempotencyHeader(
        "flag_targeting_rules_replace",
        hcRequestOptions(withAuthorization(options, callOptions)),
        body.idempotency_key,
      ),
    ),
  );
}

export function promoteFlag(
  client: FlagsHcClient,
  options: ControlPlaneHcOptions,
  input: FlagsPromoteInput,
  callOptions?: ControlPlaneOperationOptions,
) {
  const { appId, targetEnvironmentId, flagId, by, ...body } = input;
  return invokeHcRoute<FlagsPromoteOutput>("flags_promote", () =>
    client.apps[":appId"].envs[":targetEnvironmentId"].flags[":flagId"].promote.$post(
      {
        param: { appId, targetEnvironmentId, flagId },
        ...environmentSelectorQuery({ by }),
        json: body,
      } as never,
      withIdempotencyHeader(
        "flags_promote",
        hcRequestOptions(withAuthorization(options, callOptions)),
        body.idempotency_key,
      ),
    ),
  );
}
