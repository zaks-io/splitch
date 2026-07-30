import type { ErrorCode, ResolutionDetails, VariantValue } from "./generated/contract-surface.js";

/**
 * Allowed evaluation-attribute values: scalars or arrays, never a nested
 * object. Matching the wire contract at the type level makes a nested-object
 * attribute a compile error at the call site instead of a runtime 400
 * VALIDATION_ERROR.
 */
export type AttributeValue = boolean | string | number | readonly unknown[];

/**
 * The network seam behind the client. The default adapter is an HTTP `fetch`
 * call against the splitch edge; substitute your own for tests.
 *
 * A transport returns a STRUCTURED outcome, never a raw Response: the SDK core
 * never inspects HTTP status or parses bodies itself. `status` is the HTTP
 * status for an HTTP outcome, or `null` for a transport-level failure (network
 * error, timeout, body-parse failure); both fold into `reason: ERROR`.
 *
 * `runId` identifies the live experiment Run. It arrives as response metadata
 * (a header in the real adapter), never inside the wire body, and is present
 * only on a successful (`status: 200`) resolution; the client keys its
 * Exposure-dedup cache on it so a Run boundary fires a fresh Exposure.
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
