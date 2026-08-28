import type { SplitchSdkErrorCode } from "./errors";
import type {
  EvaluateAllEntry,
  EvaluateAllReason,
  ResolutionDetails,
  VariantValue,
} from "./generated/contract-surface.js";

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
 * error, timeout, body-parse failure); both fold into `reason: ERROR`. Client
 * failures carry a distinct `SDK_TRANSPORT_*` code — never the server's
 * `SERVICE_UNAVAILABLE` — and preserve the underlying `cause` for loud logging.
 *
 * `runId` and the non-revealing resolution reason arrive as response metadata
 * (headers in the real adapter), never inside the wire body. `runId` is present
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
  /**
   * Wire `ErrorCode` when the endpoint returned one, or an `SDK_TRANSPORT_*`
   * code when the failure was local (throw / timeout / unparseable body).
   */
  readonly errorCode?: SplitchSdkErrorCode;
  readonly errorMessage?: string;
  /** Underlying throw / parse rejection; passed to `logger.error` without truncation. */
  readonly cause?: unknown;
}

export interface TransportResult extends TransportFailure {
  /** The bare wire body's `variant`, or `null` when absent / unparseable. */
  readonly variant: VariantValue | null;
  /**
   * The resolved arm's name from the wire body. Null on a no-match, on any
   * error, and on `peek` (whose body carries the value only). Not derivable
   * from `variant` — two arms may hold the same value.
   */
  readonly variantName: string | null;
  /** Live Run id from response metadata; present only on a 200 resolution. */
  readonly runId: string | null;
  /** Non-revealing resolution reason from response metadata. Absent on older adapters. */
  readonly reason?: Exclude<EvaluateAllReason, "ERROR">;
}

export interface VerifyTransportResult extends TransportFailure {
  /** The endpoint's ResolutionDetails on a parsed 200 response, else null. */
  readonly details: ResolutionDetails | null;
}

/**
 * Request for the bulk Precomputed Evaluations fetch. It carries no `flagKey`:
 * the Flag set is every Flag in the credential's App and Environment, so there
 * is nothing per-Flag to name. `idempotencyKey` is required rather than optional
 * because the route bills N Evaluations for N resolved Flags and uses the key as
 * the billing replay identity (ADR-0033).
 */
export interface EvaluateAllTransportRequest {
  readonly targetingKey: string;
  readonly idType: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly idempotencyKey: string;
}

export interface EvaluateAllTransportResult extends TransportFailure {
  /** The wire body's `evaluations` map on a parsed 200 response, else null. */
  readonly evaluations: Readonly<Record<string, EvaluateAllEntry>> | null;
  /**
   * The strong validator from the `ETag` response header, verbatim (quotes
   * included). Null on any failure; a 200 that omits it is a failure, not a
   * payload with one field missing.
   */
  readonly etag: string | null;
}

export interface CachedEvaluationTelemetry {
  readonly flagKey: string;
  readonly idempotencyKey: string;
}

export interface TrackRequest {
  readonly eventName: string;
  readonly targetingKey: string;
  readonly idType: string;
  readonly eventId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly dimensions: Readonly<Record<string, boolean | string | number>>;
}

export interface TrackResult extends TransportFailure {
  readonly accepted: boolean;
  readonly eventId: string | null;
  readonly duplicate: boolean;
}

export interface Transport {
  evaluate(request: TransportRequest): Promise<TransportResult>;
  peek(request: TransportRequest): Promise<TransportResult>;
  verify(request: TransportRequest): Promise<VerifyTransportResult>;
  evaluateAll(request: EvaluateAllTransportRequest): Promise<EvaluateAllTransportResult>;
  track(request: TrackRequest): Promise<TrackResult>;
  /** Best-effort non-billable telemetry for a local cache result. */
  recordCachedEvaluation?(event: CachedEvaluationTelemetry): Promise<void>;
}
