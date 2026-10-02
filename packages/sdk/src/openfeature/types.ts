import type { ErrorCode } from "@openfeature/server-sdk";

/**
 * OpenFeature `JsonValue` shape, declared locally so `@splitch/sdk/openfeature`
 * stays free of a runtime OpenFeature dependency while remaining assignable to
 * the official Provider object-resolution generic.
 */
export type OfrepJsonValue =
  | null
  | boolean
  | number
  | string
  | OfrepJsonValue[]
  | { readonly [key: string]: OfrepJsonValue };

export type OfrepErrorCode = ErrorCode;

export interface OfrepEvaluationContext {
  readonly targetingKey?: string;
  readonly idType?: string;
  readonly [attribute: string]: unknown;
}

export interface OfrepResolutionDetails<T> {
  readonly value: T;
  readonly variant?: string;
  readonly reason?: string;
  readonly errorCode?: OfrepErrorCode;
  readonly errorMessage?: string;
  readonly flagMetadata?: Readonly<Record<string, boolean | string | number>>;
}

export interface OfrepTrackingDetails {
  readonly value?: number;
  readonly eventId?: string;
  readonly [attribute: string]: unknown;
}

export interface OfrepLogger {
  error(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

export interface SplitchOfrepProviderOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly logger?: OfrepLogger;
}
