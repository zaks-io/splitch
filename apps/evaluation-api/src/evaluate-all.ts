import {
  type ErrorResponse,
  type EvaluateAllEntry,
  type EvaluateAllRequest,
  EvaluateAllResponseSchema,
} from "@splitch/contracts";
import { type HandlerArgs, type Principal, renderError } from "@splitch/worker-runtime";
import { memoizeGetAll } from "./assignment/memoize-get-all";
import { evaluateAllFlag } from "./evaluate/accessor-paths";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types";
import type { MintExposureTicketDeps } from "./evaluate/exposure-ticket";
import { entryFor } from "./evaluate-all-entry";
import { setOwnEvaluation } from "./evaluate-all-map";
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
    const scope = credentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });

    const assertionError = appAssertionError(parsed.body.appId, scope.value.appId);
    if (assertionError !== null) return renderError(assertionError, { requestId });

    const payload = await resolveAll(parsed.body, scope.value, deps);
    if (!payload.ok) return renderError(payload.error, { requestId });

    const body = EvaluateAllResponseSchema.parse({ evaluations: payload.evaluations });
    const etag = await strongEtag(
      etagMaterial(body, {
        appId: scope.value.appId,
        environmentId: scope.value.environmentId,
        targetingKey: parsed.body.targetingKey,
        idType: parsed.body.idType,
        attributes: parsed.body.attributes,
      }),
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

    const billed = await writeBatchUsage(body, scope.value, request, deps);
    if (!billed.ok) return renderError(billed.error, { requestId });

    return Response.json(body, {
      headers: {
        etag,
        "access-control-expose-headers": "etag, x-request-id",
      },
    });
  };
}

async function resolveAll(
  body: EvaluateAllRequest,
  scope: CredentialScope,
  deps: EvaluateAllRouteDeps,
): Promise<
  { ok: true; evaluations: Record<string, EvaluateAllEntry> } | { ok: false; error: ErrorResponse }
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

  for (const flag of flags) {
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
    setOwnEvaluation(
      evaluations,
      flag.flagKey,
      await entryFor(output.result, flag, deps.exposureTicket),
    );
  }

  return { ok: true, evaluations };
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

/**
 * ETag material excludes Exposure Tickets: tickets embed issued_at and would
 * make every revalidation miss (ADR-0048 freshness is config+context, not remint).
 * Evaluation Context is included so a tag is never reusable across contexts
 * (docs/spec/sdk/evaluate-all-endpoint.md).
 */
function etagMaterial(
  body: ReturnType<typeof EvaluateAllResponseSchema.parse>,
  context: {
    appId: string;
    environmentId: string;
    targetingKey: string;
    idType: string;
    attributes: EvaluateAllRequest["attributes"];
  },
): string {
  const keys = Object.keys(body.evaluations).sort();
  const evaluations: Record<
    string,
    {
      variant: EvaluateAllEntry["variant"];
      variantName: EvaluateAllEntry["variantName"];
      reason: EvaluateAllEntry["reason"];
      errorCode: EvaluateAllEntry["errorCode"];
    }
  > = {};
  for (const key of keys) {
    const entry = body.evaluations[key];
    if (entry === undefined) continue;
    evaluations[key] = {
      variant: entry.variant,
      variantName: entry.variantName,
      reason: entry.reason,
      errorCode: entry.errorCode,
    };
  }
  return JSON.stringify({
    appId: context.appId,
    environmentId: context.environmentId,
    targetingKey: context.targetingKey,
    idType: context.idType,
    attributes: canonicalizeJson(context.attributes),
    evaluations,
  });
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(recordValue).sort()) {
      out[key] = canonicalizeJson(recordValue[key]);
    }
    return out;
  }
  return value;
}

async function strongEtag(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (header === null || header.trim() === "") return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === etag || part === `W/${etag}`);
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
