import type { TargetingRule } from "@splitch/contracts";
import { envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import type { ConfigStoreWriter } from "./config-store";
import type { ConfigStoreAccess } from "./config-store-do";
import { requireAppAdmin } from "./app-authz";
import {
  confirmationRequired,
  flagConfigPatchGates,
  promotionGates,
  readEnvironmentPolicy,
} from "./flag-config-policy";
import { objectBody, pathParam } from "./handler-input";
import { makeOrgHandlers, type MemberProfileResolver } from "./org-handlers";

/**
 * Minimal-but-real control-plane handlers for the mounted routes. They run AFTER
 * the guard has resolved the Principal and enforced scopes + App co-scope, so by
 * the time a handler executes the caller is authorized for this App: the guard
 * already rejected a null/mismatched-App principal with FORBIDDEN before any
 * repository call (steps/scopes.ts). The handler reads through the @splitch/db
 * repository seam (the only D1 entry, ADR-0018), never a raw client.
 *
 * Domain breadth is intentionally incremental: Org/member handlers live in their
 * own module, while App and Flag Configuration handlers stay here.
 *
 * The registry erases the route's Zod generics to `unknown` at the registrar
 * boundary, so each handler re-reads the single path param it needs from the
 * already-validated input, failing loud if the expected shape is somehow absent
 * (it cannot be: parseInput validated it against the contract first).
 */

interface HandlerDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  memberProfileResolver?: MemberProfileResolver;
  nowIso?: () => string;
}

export function makeHandlers(deps: HandlerDeps) {
  return {
    ...makeOrgHandlers(deps),

    async getFlagConfig({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const flagId = pathParam(input, "flagId");
      const result = await deps.configStore
        .writerFor(appId, environmentId)
        .readFlagConfig({ appId, environmentId, flagId });

      if (!result.ok) {
        return renderError(
          { code: "FLAG_NOT_FOUND", message: "flag configuration not found", details: {} },
          { requestId },
        );
      }
      return Response.json(result.config);
    },

    async updateFlagConfig({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const flagId = pathParam(input, "flagId");
      const adminError = requireAppAdmin(appId, principal.scopes, requestId);
      if (adminError) return adminError;

      const body = objectBody(input);
      const policy = await readEnvironmentPolicy(deps.repo, appId, environmentId);
      if (!policy) return flagConfigNotFound(requestId);

      const confirmation = confirmationRequired(
        policy,
        flagConfigPatchGates(body),
        body.confirm === true,
        environmentId,
        "PATCH_FLAG_CONFIG",
        requestId,
      );
      if (confirmation) return confirmation;

      const result = await deps.configStore
        .writerFor(appId, environmentId)
        .writeFlagConfig(flagConfigPatchInput(appId, environmentId, flagId, body));
      return renderFlagConfigWriteResult(result, flagId, environmentId, requestId);
    },

    async replaceTargetingRules({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const flagId = pathParam(input, "flagId");
      const adminError = requireAppAdmin(appId, principal.scopes, requestId);
      if (adminError) return adminError;

      const body = objectBody(input);
      const policy = await readEnvironmentPolicy(deps.repo, appId, environmentId);
      if (!policy) return flagConfigNotFound(requestId);

      const confirmation = confirmationRequired(
        policy,
        ["targeting_rollout_value"],
        body.confirm === true,
        environmentId,
        "PUT_TARGETING_RULES",
        requestId,
      );
      if (confirmation) return confirmation;

      const result = await deps.configStore.writerFor(appId, environmentId).replaceTargetingRules({
        appId,
        environmentId,
        flagId,
        targetingRules: body.targetingRules as TargetingRule[],
      });
      return renderFlagConfigWriteResult(result, flagId, environmentId, requestId);
    },

    async promoteFlagConfig({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const targetEnvironmentId = pathParam(input, "targetEnvironmentId");
      const flagId = pathParam(input, "flagId");
      const adminError = requireAppAdmin(appId, principal.scopes, requestId);
      if (adminError) return adminError;

      const body = objectBody(input);
      const fromEnvironmentId = body.fromEnvironmentId as string;
      const policy = await readEnvironmentPolicy(deps.repo, appId, targetEnvironmentId);
      if (!policy) return flagConfigNotFound(requestId);

      const sourceConfig = await deps.repo.flags.getFlagConfig(
        envScope(appId, fromEnvironmentId),
        flagId,
      );
      if (!sourceConfig) return flagConfigNotFound(requestId);

      const gates = promotionGates(body.select as PromotionSelect, sourceConfig.enabled);
      const confirmation = confirmationRequired(
        policy,
        gates,
        body.confirm === true,
        targetEnvironmentId,
        "PROMOTE_FLAG_CONFIG",
        requestId,
      );
      if (confirmation) return confirmation;

      const result = await deps.configStore
        .writerFor(appId, targetEnvironmentId)
        .promoteFlagConfig({
          appId,
          targetEnvironmentId,
          flagId,
          fromEnvironmentId,
          select: body.select as PromotionSelect,
        });
      return renderPromotionResult(result, flagId, targetEnvironmentId, requestId);
    },
  };
}

type FlagConfigWriteResult = Awaited<ReturnType<ConfigStoreWriter["writeFlagConfig"]>>;
type PromotionResult = Awaited<ReturnType<ConfigStoreWriter["promoteFlagConfig"]>>;
type PromotionSelect = Parameters<ConfigStoreWriter["promoteFlagConfig"]>[0]["select"];

function flagConfigPatchInput(
  appId: string,
  environmentId: string,
  flagId: string,
  payload: Record<string, unknown>,
): Parameters<ConfigStoreWriter["writeFlagConfig"]>[0] {
  return {
    appId,
    environmentId,
    flagId,
    ...(payload.enabled !== undefined ? { enabled: payload.enabled as boolean } : {}),
    ...(payload.availableVariantNames !== undefined
      ? { availableVariantNames: payload.availableVariantNames as string[] }
      : {}),
  };
}

function renderFlagConfigWriteResult(
  result: FlagConfigWriteResult,
  flagId: string,
  environmentId: string,
  requestId: string,
): Response {
  if (result.ok) return Response.json(result.config);
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return variantNotAvailable(flagId, environmentId, result.missingVariants, requestId);
  }
  return flagConfigNotFound(requestId);
}

function renderPromotionResult(
  result: PromotionResult,
  flagId: string,
  environmentId: string,
  requestId: string,
): Response {
  if (result.ok) return Response.json({ config: result.config, diff: result.diff });
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return variantNotAvailable(flagId, environmentId, result.missingVariants, requestId);
  }
  return flagConfigNotFound(requestId);
}

function variantNotAvailable(
  flagId: string,
  environmentId: string,
  missingVariants: string[],
  requestId: string,
): Response {
  return renderError(
    {
      code: "VARIANT_NOT_AVAILABLE",
      message: "requested variants are not available for this Flag Configuration",
      details: {
        flagId,
        environmentId,
        missingVariants,
        recommendedAction: "ADD_VARIANT_TO_ENV",
      },
    },
    { requestId },
  );
}

function flagConfigNotFound(requestId: string): Response {
  return renderError(
    { code: "FLAG_NOT_FOUND", message: "flag configuration not found", details: {} },
    { requestId },
  );
}

function configStoreUnavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "config store is not configured",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}
