import type { ErrorCode, ResolutionDetails, VariantValue } from "./generated/contract-surface.js";

/**
 * Mirrors the contract's `EvaluationContext.attributes` value union
 * (leaf-schemas-runtime.ts `AttributeValueSchema`, not exported from contracts):
 * scalars or arrays only, never a nested object. Defining it here makes a
 * nested-object attribute a COMPILE error at the call site instead of a runtime
 * 400 VALIDATION_ERROR on the wire.
 */
export type AttributeValue = boolean | string | number | readonly unknown[];

/**
 * The network seam the SDK accessors use. The real adapter is an HTTP `fetch`
 * call (see client.ts); tests substitute a fake that records each distinct path.
 *
 * The transport returns a STRUCTURED outcome, never a raw Response: the SDK must
 * never inspect HTTP status or parse bodies itself (that branching lives in
 * resolution.ts). `status` is the HTTP status for an HTTP outcome, or `null` for
 * a transport-level failure (network error, timeout, body-parse failure) — both
 * of which the mapping table folds into `reason: ERROR`.
 *
 * `runId` rides ALONGSIDE the bare `{ variant }` wire body as non-revealing
 * operational metadata (a response header in the real adapter), not inside it:
 * the data-plane response schema stays the closed `{ variant }` shape (ADR-0018),
 * yet the seen-set key needs `runId` to reset at a Run boundary (seen-set.md).
 * `runId` is present only on a successful (`status: 200`) resolution.
 */
export interface TransportRequest {
  readonly flagKey: string;
  readonly targetingKey: string;
  readonly idType: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  /** Reused by a caller that retries an uncertain response. */
  readonly idempotencyKey?: string;
}

export interface TransportFailure {
  /** HTTP status for an HTTP response, or `null` for a transport-level failure. */
  readonly status: number | null;
  /** Wire error code when the endpoint returned one; otherwise SDK-synthesized. */
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
}

export interface TransportResult extends TransportFailure {
  /** The bare wire body's `variant`, or `null` when absent / unparseable. */
  readonly variant: VariantValue | null;
  /** Live Run id from response metadata; present only on a 200 resolution. */
  readonly runId: string | null;
}

export interface VerifyTransportResult extends TransportFailure {
  /** The endpoint's ResolutionDetails on a parsed 200 response, else null. */
  readonly details: ResolutionDetails | null;
}

export interface CachedEvaluationTelemetry {
  readonly flagKey: string;
  readonly idempotencyKey: string;
}

export interface Transport {
  evaluate(request: TransportRequest): Promise<TransportResult>;
  peek(request: TransportRequest): Promise<TransportResult>;
  verify(request: TransportRequest): Promise<VerifyTransportResult>;
  /** Best-effort non-billable telemetry for a local cache result. */
  recordCachedEvaluation?(event: CachedEvaluationTelemetry): Promise<void>;
}
