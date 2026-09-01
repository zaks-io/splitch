import type { ErrorResponse } from "@splitch/contracts";
import { emptyError, renderError, serviceUnavailable, validationError } from "./errors";
import { evaluationCommitOutbox } from "./evaluation-commit-outbox-client";
import {
  confirmEvaluationCommitInventory,
  inventoryEvaluationCommit,
} from "./evaluation-commit-privacy";
import { evaluationUsageScope, requiredIdentity } from "./ingest";
import { ingestAdmissionDenial } from "./ingest-admission";
import { loadRunScope } from "./kv-config";
import { readJsonObject } from "./payload";
import {
  type EvaluationUsageEventInput,
  evaluationUsagePayload,
  exposureEvent,
  toEvaluationUsageTinybirdRow,
  toTinybirdRow,
} from "./tinybird";
import type { Env, EvaluationUsageScope, Outcome } from "./types";

/**
 * Absolute Exposure count for one Evaluation commit. One evaluate emits at most
 * one Exposure; this cap rejects an unbounded `exposures` array before
 * per-item Run-scope work.
 */
export const EVALUATION_COMMIT_MAX_EXPOSURES = 25;

/** Fixed-width stand-in: sealed usage event IDs are `sha256:` plus 64 hex chars. */
const EVALUATION_COMMIT_USAGE_BYTE_COST_EVENT_ID = `sha256:${"0".repeat(64)}`;

/**
 * Seals a remote Evaluation's usage row and any Exposure rows before delivery.
 * Retries replay the same pair and stable dedup keys, never a half-new result.
 */
export async function handleEvaluationCommit(request: Request, env: Env): Promise<Response> {
  const prepared = await prepareEvaluationCommit(request, env);
  if (!prepared.ok) return renderError(prepared.error);
  return Response.json({ ok: true, eventId: prepared.value.eventId }, { status: 202 });
}

interface PreparedEvaluationCommit {
  readonly eventId: string;
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
  const identity = await evaluationCommitIdentity(
    scope,
    payload.usage.identityVersion,
    payload.usage.idempotencyKey,
  );

  try {
    const existing = await outbox.lookup(identity);
    if (existing !== null) {
      return preparedCommit(existing);
    }

    const denied = await chargeNewEvaluationCommit(env, scope, payload);
    if (denied) return { ok: false, error: denied };

    const inventory = { identity, outbox, payload };
    if (await inventoryEvaluationCommit(inventory, env)) {
      throw new Error("Evaluation commit is suppressed by App identity reset");
    }
    const sealed = await outbox.commit(identity, payload);
    await confirmEvaluationCommitInventory(inventory, env);
    return preparedCommit(sealed);
  } catch {
    return { ok: false, error: serviceUnavailable("Evaluation commit outbox is unavailable") };
  }
}

function preparedCommit(sealed: {
  eventId: string;
  payload: unknown;
}): Outcome<PreparedEvaluationCommit> {
  if (!isEvaluationCommitPayload(sealed.payload)) {
    return {
      ok: false,
      error: serviceUnavailable("Evaluation commit outbox returned invalid payload"),
    };
  }
  return {
    ok: true,
    value: { eventId: sealed.eventId },
  };
}

async function chargeNewEvaluationCommit(
  env: Env,
  scope: EvaluationUsageScope,
  payload: EvaluationCommitPayload,
): Promise<ErrorResponse | null> {
  const usageDenied = await ingestAdmissionDenial(
    env.INGEST_ADMISSION_GATE,
    {
      appId: scope.appId,
      environmentId: scope.environmentId,
      ingestStream: "raw_evaluations",
    },
    [
      toEvaluationUsageTinybirdRow({
        eventId: EVALUATION_COMMIT_USAGE_BYTE_COST_EVENT_ID,
        ...payload.usage,
      }),
    ],
    "Evaluation usage ingest admission capacity exceeded",
  );
  if (usageDenied) return usageDenied;

  return ingestAdmissionDenial(
    env.INGEST_ADMISSION_GATE,
    {
      appId: scope.appId,
      environmentId: scope.environmentId,
      ingestStream: "raw_events",
    },
    payload.exposureRows,
    "Exposure ingest admission capacity exceeded",
  );
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
  if (exposures.length > EVALUATION_COMMIT_MAX_EXPOSURES) {
    return {
      ok: false,
      error: validationError(
        `Evaluation commit exposures exceed ${EVALUATION_COMMIT_MAX_EXPOSURES}`,
        ["exposures"],
      ),
    };
  }

  const outcomes = await Promise.all(
    exposures.map((candidate) => evaluationCommitExposureRow(candidate, scope, env)),
  );
  const rows: Record<string, unknown>[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) return outcome;
    rows.push(outcome.value);
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
  identityVersion: string,
  idempotencyKey: string,
): Promise<string> {
  const material = [
    scope.organizationId,
    scope.appId,
    scope.environmentId,
    identityVersion,
    "remote",
    idempotencyKey,
  ].join("\u001f");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
