export interface OfrepEvaluationContext {
  readonly targetingKey?: string;
  readonly idType?: string;
  readonly [attribute: string]: unknown;
}

export interface OfrepResolutionDetails<T> {
  readonly value: T;
  readonly variant?: string;
  readonly reason?: string;
  readonly errorCode?: string;
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
