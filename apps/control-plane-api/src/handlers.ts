import type { Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import type { ConfigStoreWriter } from "./config-store.js";
import type { ConfigStoreAccess } from "./config-store-do.js";
import { objectBody, pathParam } from "./handler-input.js";
import { makeOrgHandlers, type MemberProfileResolver } from "./org-handlers.js";
import { appAdminScope } from "./scope-binding.js";

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

    async getApp({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const app = await deps.repo.identity.getApp(pathParam(input, "appId"));
      if (!app) {
        return renderError(
          { code: "APP_NOT_FOUND", message: "app not found", details: {} },
          { requestId },
        );
      }
      return Response.json({
        id: app.id,
        organizationId: app.organizationId,
        name: app.name,
        key: app.key,
        ...(app.description ? { description: app.description } : {}),
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
      });
    },

    async getOrg({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const org = await deps.repo.identity.getOrg(pathParam(input, "orgId"));
      if (!org) {
        return renderError(
          { code: "ORGANIZATION_NOT_FOUND", message: "organization not found", details: {} },
          { requestId },
        );
      }
      return Response.json({
        id: org.id,
        name: org.name,
        plan: org.plan,
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
      });
    },

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

      const result = await deps.configStore
        .writerFor(appId, environmentId)
        .writeFlagConfig(flagConfigPatchInput(appId, environmentId, flagId, objectBody(input)));
      return renderFlagConfigWriteResult(result, flagId, environmentId, requestId);
    },
  };
}

type FlagConfigWriteResult = Awaited<ReturnType<ConfigStoreWriter["writeFlagConfig"]>>;

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
    ...(payload.availableVariantNames
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
    return renderError(
      {
        code: "VARIANT_NOT_AVAILABLE",
        message: "requested variants are not in the Flag catalog",
        details: {
          flagId,
          environmentId,
          missingVariants: result.missingVariants,
          recommendedAction: "ADD_VARIANT_TO_ENV",
        },
      },
      { requestId },
    );
  }
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

function requireAppAdmin(
  appId: string,
  heldScopes: readonly string[],
  requestId: string,
): Response | null {
  const requiredScope = appAdminScope(appId);
  if (heldScopes.includes(requiredScope)) return null;
  return renderError(
    {
      code: "INSUFFICIENT_SCOPES",
      message: "credential lacks required scopes",
      details: { requiredScopes: [requiredScope], heldScopes: [...heldScopes] },
    },
    { requestId },
  );
}
