import { emptyError, renderError, serviceUnavailable } from "./errors";
import { evaluationCommitOutbox } from "./evaluation-commit-outbox";
import { evaluationUsageScope, requiredIdentity } from "./ingest";
import { loadRunScope } from "./kv-config";
import { readJsonObject } from "./payload";
import {
  appendRawEvent,
  type EvaluationUsageEventInput,
  evaluationUsagePayload,
  exposureEvent,
  tinybirdDelivery,
  toEvaluationUsageTinybirdRow,
  toTinybirdRow,
} from "./tinybird";
import type { Env, EvaluationUsageScope, Outcome } from "./types";

/**
 * Seals a remote Evaluation's usage row and any Exposure rows before delivery.
 * Retries replay the same pair and stable dedup keys, never a half-new result.
 */
export async function handleEvaluationCommit(request: Request, env: Env): Promise<Response> {
  const prepared = await prepareEvaluationCommit(request, env);
  if (!prepared.ok) return renderError(prepared.error);

  const { commit } = prepared.value;
  if (commit.delivered)
    return Response.json({ ok: true, eventId: commit.eventId }, { status: 202 });

  return deliverEvaluationCommit(prepared.value, env);
}

interface PreparedEvaluationCommit {
  readonly scope: EvaluationUsageScope;
  readonly identity: string;
  readonly outbox: NonNullable<ReturnType<typeof evaluationCommitOutbox>>;
  readonly commit: {
    readonly eventId: string;
    readonly payload: EvaluationCommitPayload;
    readonly delivered: boolean;
  };
}

async function prepareEvaluationCommit(
  request: Request,
  env: Env,
): Promise<Outcome<PreparedEvaluationCommit>> {
  const input = await evaluationCommitInput(request, env);
  if (!input.ok) return input;

  const outbox = evaluationCommitOutbox(env.EVALUATION_COMMIT_OUTBOX);
  if (outbox === undefined) {
    return { ok: false, error: serviceUnavailable("Evaluation commit outbox is unavailable") };
  }
  const { scope, payload } = input.value;
  const identity = await evaluationCommitIdentity(scope, payload.usage.idempotencyKey);

  try {
    const sealed = await outbox.commit(identity, payload);
    if (!isEvaluationCommitPayload(sealed.payload)) {
      return {
        ok: false,
        error: serviceUnavailable("Evaluation commit outbox returned invalid payload"),
      };
    }
    return {
      ok: true,
      value: {
        scope,
        identity,
        outbox,
        commit: { eventId: sealed.eventId, payload: sealed.payload, delivered: sealed.delivered },
      },
    };
  } catch {
    return { ok: false, error: serviceUnavailable("Evaluation commit outbox is unavailable") };
  }
}

async function evaluationCommitInput(
  request: Request,
  env: Env,
): Promise<Outcome<{ scope: EvaluationUsageScope; payload: EvaluationCommitPayload }>> {
  const scope = await evaluationUsageScope(request, env);
  if (!scope.ok) return scope;

  const payload = await readJsonObject(request);
  if (!payload.ok) return payload;

  const usage = evaluationUsagePayload(payload.value, scope.value);
  if (!usage.ok) return usage;
  if (usage.value.isCached) {
    return {
      ok: false,
      error: emptyError("INTERNAL_SERVER_ERROR", "cached usage cannot use Evaluation commit"),
    };
  }

  const exposureRows = await evaluationCommitExposureRows(payload.value, scope.value, env);
  if (!exposureRows.ok) return exposureRows;
  return {
    ok: true,
    value: {
      scope: scope.value,
      payload: { usage: usage.value, exposureRows: exposureRows.value },
    },
  };
}

async function deliverEvaluationCommit(
  prepared: PreparedEvaluationCommit,
  env: Env,
): Promise<Response> {
  const { commit, identity, outbox, scope } = prepared;
  const usageDelivery = tinybirdDelivery(env, "raw_evaluations");
  const exposureDelivery = commit.payload.exposureRows.length > 0 ? tinybirdDelivery(env) : null;
  if (!usageDelivery.ok) return renderError(usageDelivery.error);
  if (exposureDelivery !== null && !exposureDelivery.ok) return renderError(exposureDelivery.error);

  try {
    await appendRawEvent(
      toEvaluationUsageTinybirdRow({ eventId: commit.eventId, ...commit.payload.usage }),
      usageDelivery.value,
    );
    if (exposureDelivery?.ok) {
      for (const row of commit.payload.exposureRows) {
        await appendRawEvent(row, exposureDelivery.value);
      }
    }
    await outbox.acknowledge(identity);
  } catch (error) {
    console.error("event-ingest-api Evaluation commit delivery failed", {
      organizationId: scope.organizationId,
      appId: scope.appId,
      environmentId: scope.environmentId,
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
    return renderError(serviceUnavailable("Evaluation commit delivery failed"));
  }

  return Response.json({ ok: true, eventId: commit.eventId }, { status: 202 });
}

interface EvaluationCommitPayload {
  readonly usage: EvaluationUsageEventInput;
  readonly exposureRows: readonly Record<string, unknown>[];
}

async function evaluationCommitExposureRows(
  payload: Record<string, unknown>,
  scope: EvaluationUsageScope,
  env: Env,
): Promise<Outcome<readonly Record<string, unknown>[]>> {
  const exposures = payload.exposures;
  if (!Array.isArray(exposures)) {
    return {
      ok: false,
      error: emptyError("INTERNAL_SERVER_ERROR", "Evaluation commit exposures are required"),
    };
  }

  const rows: Record<string, unknown>[] = [];
  for (const candidate of exposures) {
    const row = await evaluationCommitExposureRow(candidate, scope, env);
    if (!row.ok) return row;
    rows.push(row.value);
  }
  return { ok: true, value: rows };
}

async function evaluationCommitExposureRow(
  candidate: unknown,
  scope: EvaluationUsageScope,
  env: Env,
): Promise<Outcome<Record<string, unknown>>> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return {
      ok: false,
      error: emptyError("INTERNAL_SERVER_ERROR", "Evaluation commit Exposure is invalid"),
    };
  }
  const exposurePayload = candidate as Record<string, unknown>;
  const fields = requiredIdentity(exposurePayload);
  if (!fields.ok) return fields;
  const runScope = await loadRunScope(
    env,
    scope,
    fields.value.experimentId,
    fields.value.idType,
    fields.value.runId,
  );
  if (!runScope.ok) return runScope;
  const event = await exposureEvent(exposurePayload, scope, runScope.value, env);
  return event.ok ? { ok: true, value: toTinybirdRow(event.value, exposurePayload) } : event;
}

function isEvaluationCommitPayload(value: unknown): value is EvaluationCommitPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.usage === "object" &&
    payload.usage !== null &&
    !Array.isArray(payload.usage) &&
    Array.isArray(payload.exposureRows)
  );
}

async function evaluationCommitIdentity(
  scope: EvaluationUsageScope,
  idempotencyKey: string,
): Promise<string> {
  const material = [
    scope.organizationId,
    scope.appId,
    scope.environmentId,
    "remote",
    idempotencyKey,
  ].join("\u001f");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
