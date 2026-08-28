import {
  type ErrorResponse,
  type EvaluateAllEntry,
  type EvaluateAllRequest,
  EvaluateAllResponseSchema,
} from "@splitch/contracts";
import { type HandlerArgs, type Principal, renderError } from "@splitch/worker-runtime";
import { appIdentityTrafficError } from "./app-identity-traffic";
import { memoizeGetAll } from "./assignment/memoize-get-all";
import { evaluateAllFlag } from "./evaluate/accessor-paths";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types";
import {
  exposureTicketRefreshWindow,
  type MintExposureTicketDeps,
} from "./evaluate/exposure-ticket";
import { entryFor } from "./evaluate-all-entry";
import { etagMaterial, ifNoneMatchMatches, strongEtag } from "./evaluate-all-exposure-identity";
import { sdkRuntime } from "./evaluate-response";
import { errorResponse } from "./evaluation-error-response";
import type { EvaluationUsageScope } from "./evaluation-usage";
import type { EvaluationUsageSink } from "./evaluation-usage-sink";
import { EvaluationUsageSinkError } from "./evaluation-usage-sink";
import type { FlagConfig } from "./provider/provider";

/**
 * Batch Flag Key used on the Evaluation usage row for an evaluate-all fetch.
 * Per-Flag breakdown for batches is a reporting concern on `is_batch` + count;
 * the Idempotency-Key is the single billing replay identity (ADR-0033).
 */
const BATCH_USAGE_FLAG_KEY = "*";

interface EvaluateAllRouteDeps extends EvaluatePathDeps {
  readonly evaluationUsageSink: EvaluationUsageSink;
  readonly exposureTicket: MintExposureTicketDeps;
}

type CredentialScope = EvaluationUsageScope;

export function makeEvaluateAllHandler(deps: EvaluateAllRouteDeps) {
  return async ({
    input,
    principal,
    requestId,
    request,
  }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = evaluateAllInput(input);
    const checked = await checkedEvaluationScope(
      principal,
      parsed.body.appId,
      deps.exposureTicket.saltStore,
      requestId,
    );
    if (!checked.ok) return checked.response;
    const scope = checked.scope;

    const payload = await resolveAll(parsed.body, scope, deps);
    if (!payload.ok) return renderError(payload.error, { requestId });

    const body = EvaluateAllResponseSchema.parse({ evaluations: payload.evaluations });
    const etag = await strongEtag(
      etagMaterial(
        body,
        {
          appId: scope.appId,
          environmentId: scope.environmentId,
          targetingKey: parsed.body.targetingKey,
          idType: parsed.body.idType,
          attributes: parsed.body.attributes,
        },
        payload.ticketRefreshWindow,
      ),
    );
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          "access-control-expose-headers": "etag, x-request-id",
        },
      });
    }

    const billed = await writeBatchUsage(body, scope, request, deps);
    if (!billed.ok) return renderError(billed.error, { requestId });

    return Response.json(body, {
      headers: {
        etag,
        "access-control-expose-headers": "etag, x-request-id",
      },
    });
  };
}

async function checkedEvaluationScope(
  principal: Principal,
  assertedAppId: string | undefined,
  saltStore: MintExposureTicketDeps["saltStore"],
  requestId: string,
): Promise<{ ok: true; scope: CredentialScope } | { ok: false; response: Response }> {
  const scope = credentialScope(principal);
  if (!scope.ok) return { ok: false, response: renderError(scope.error, { requestId }) };
  const assertionError = appAssertionError(assertedAppId, scope.value.appId);
  if (assertionError !== null) {
    return { ok: false, response: renderError(assertionError, { requestId }) };
  }
  const identityError = await appIdentityTrafficError(saltStore, scope.value.appId);
  return identityError === null
    ? { ok: true, scope: scope.value }
    : { ok: false, response: renderError(identityError, { requestId }) };
}

async function resolveAll(
  body: EvaluateAllRequest,
  scope: CredentialScope,
  deps: EvaluateAllRouteDeps,
): Promise<
  | {
      ok: true;
      evaluations: Record<string, EvaluateAllEntry>;
      ticketRefreshWindow: number | null;
    }
  | { ok: false; error: ErrorResponse }
> {
  let flags: FlagConfig[];
  try {
    flags = await deps.provider.getFlags(scope.appId, scope.environmentId);
  } catch (cause) {
    deps.logger?.error("evaluate_all_get_flags_failed", { cause });
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "provider config is temporarily unavailable"),
    };
  }

  const assignmentStore = memoizeGetAll(deps.assignmentStore);
  const pathDeps: EvaluatePathDeps = { ...deps, assignmentStore };
  const evaluations: Record<string, EvaluateAllEntry> = {};
  const ticketNow = (deps.exposureTicket.now ?? (() => new Date()))();
  const ticketDeps: MintExposureTicketDeps = {
    ...deps.exposureTicket,
    now: () => ticketNow,
  };
  let hasExposureTicket = false;

  for (const flag of flags) {
    if (flag.flagKey === "__proto__") {
      return {
        ok: false,
        error: errorResponse(
          "UNSUPPORTED_OBJECT_KEY",
          'Flag Key "__proto__" cannot be included in Precomputed Evaluations',
        ),
      };
    }
    const routeInput: EvaluatePathInput = {
      appId: scope.appId,
      environmentId: scope.environmentId,
      flagKey: flag.flagKey,
      evaluationContext: {
        targetingKey: body.targetingKey,
        idType: body.idType,
        attributes: body.attributes,
      },
    };
    const output = await evaluateAllFlag(routeInput, pathDeps);
    const entry = await entryFor(output.result, flag, ticketDeps);
    evaluations[flag.flagKey] = entry;
    hasExposureTicket ||= entry.exposureTicket !== null;
  }

  return {
    ok: true,
    evaluations,
    ticketRefreshWindow: hasExposureTicket ? exposureTicketRefreshWindow(ticketNow) : null,
  };
}

function credentialScope(
  principal: Principal,
): { ok: true; value: CredentialScope } | { ok: false; error: ErrorResponse } {
  if (principal.orgId === null || principal.appId === null || principal.environmentId === null) {
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "credential cache migration is required"),
    };
  }
  return {
    ok: true,
    value: {
      organizationId: principal.orgId,
      appId: principal.appId,
      environmentId: principal.environmentId,
    },
  };
}

function appAssertionError(appId: string | undefined, scopedAppId: string): ErrorResponse | null {
  return appId !== undefined && appId !== scopedAppId
    ? errorResponse("APP_MISMATCH", "credential does not belong to appId")
    : null;
}

function evaluateAllInput(input: unknown): { body: EvaluateAllRequest } {
  const root = record(input);
  const body = record(root.body);
  return {
    body: {
      appId: optionalStringField(body, "appId"),
      targetingKey: stringField(body, "targetingKey"),
      idType: stringField(body, "idType"),
      attributes: record(body.attributes ?? {}) as EvaluateAllRequest["attributes"],
    },
  };
}

async function writeBatchUsage(
  body: ReturnType<typeof EvaluateAllResponseSchema.parse>,
  scope: CredentialScope,
  request: Request,
  deps: EvaluateAllRouteDeps,
): Promise<{ ok: true } | { ok: false; error: ErrorResponse }> {
  const flagCount = Object.keys(body.evaluations).length;
  if (flagCount === 0) return { ok: true };

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null) {
    return {
      ok: false,
      error: errorResponse("VALIDATION_ERROR", "Idempotency-Key is required for Evaluation usage"),
    };
  }

  try {
    await deps.evaluationUsageSink.write({
      idempotencyKey,
      organizationId: scope.organizationId,
      appId: scope.appId,
      identityVersion: await deps.exposureTicket.saltStore.currentKeyVersion(scope.appId),
      environmentId: scope.environmentId,
      flagKey: BATCH_USAGE_FLAG_KEY,
      sdkRuntime: sdkRuntime(request),
      evaluationCount: flagCount,
      isBatch: true,
      isCached: false,
      hasExposure: false,
    });
    return { ok: true };
  } catch (cause) {
    if (!(cause instanceof EvaluationUsageSinkError)) throw cause;
    deps.logger?.error("evaluate_all_usage_sink_failed", { cause });
    return {
      ok: false,
      error: errorResponse(
        "SERVICE_UNAVAILABLE",
        "evaluation usage commit is temporarily unavailable",
      ),
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evaluation-api: expected parsed object input");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`evaluation-api: missing ${key}`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`evaluation-api: invalid ${key}`);
  }
  return field;
}
