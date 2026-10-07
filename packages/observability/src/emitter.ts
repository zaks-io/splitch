import {
  type ScrubOptions,
  type SentryEventLike,
  scrubSentryEvent,
  scrubSentrySpan,
  assertSentryEventType,
  scrubValue,
} from "@splitch/privacy";
import { OBSERVABILITY_SCRUB_OPTIONS } from "./scrub-options.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ObservabilitySecrets {
  readonly sentryDsn?: string;
  readonly environment?: string;
}

export interface ScrubbedEmitterConfig extends ObservabilitySecrets {
  readonly surface: string;
  readonly scrubOptions?: ScrubOptions;
  /** Test hook: invoked with the scrubbed Sentry event immediately before emit. */
  readonly onSentryEvent?: (event: SentryEventLike) => void;
  /** Test hook: invoked with the scrubbed Sentry span immediately before emit. */
  readonly onSentrySpan?: (span: SentryEventLike) => void;
  /** Test hook: invoked with scrubbed structured log rows immediately before emit. */
  readonly onStructuredLogEvents?: (events: Record<string, unknown>[]) => void;
  /** When set, delivers scrubbed exceptions to the surface Sentry client. */
  readonly onSentryCaptureException?: (error: unknown, extra: Record<string, unknown>) => void;
}

export interface ScrubbedEmitter {
  readonly beforeSend: (event: SentryEventLike) => SentryEventLike;
  readonly beforeSendSpan: (span: SentryEventLike) => SentryEventLike;
  captureException(error: unknown, extra?: Record<string, unknown>): void;
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/**
 * Shared scrubbed emission seam. Every surface calls this (directly or through
 * the worker/cli/sdk wrappers) so golden-leak and cross-surface tests exercise the
 * same code path production uses.
 */
export function createScrubbedEmitter(config: ScrubbedEmitterConfig): ScrubbedEmitter {
  const scrubOptions = config.scrubOptions ?? OBSERVABILITY_SCRUB_OPTIONS;
  const beforeSend = (event: SentryEventLike): SentryEventLike => {
    const scrubbed = scrubSentryEvent(event, scrubOptions);
    config.onSentryEvent?.(scrubbed);
    return scrubbed;
  };

  const beforeSendSpan = (span: SentryEventLike): SentryEventLike => {
    const scrubbed = scrubSentrySpan(span, scrubOptions);
    config.onSentrySpan?.(scrubbed);
    return scrubbed;
  };

  return {
    beforeSend,
    beforeSendSpan,
    captureException(error, extra = {}) {
      const scrubbedExtra = scrubValue(extra, scrubOptions) as Record<string, unknown>;
      beforeSend({
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        extra: scrubbedExtra,
        tags: { surface: config.surface },
        environment: config.environment,
      });
      config.onSentryCaptureException?.(error, scrubbedExtra);
    },
    log(level, message, fields = {}) {
      const row = scrubValue(
        {
          level,
          message,
          surface: config.surface,
          environment: config.environment,
          ...fields,
        },
        scrubOptions,
      ) as Record<string, unknown>;
      const events = [row];
      config.onStructuredLogEvents?.(events);
    },
  };
}

export function createSentryBeforeSend(
  config: Pick<ScrubbedEmitterConfig, "surface" | "scrubOptions" | "onSentryEvent">,
): (event: SentryEventLike) => SentryEventLike {
  return createScrubbedEmitter({
    surface: config.surface,
    scrubOptions: config.scrubOptions,
    onSentryEvent: config.onSentryEvent,
  }).beforeSend;
}

export function createSentryBeforeSendSpan(
  config: Pick<ScrubbedEmitterConfig, "surface" | "scrubOptions" | "onSentrySpan">,
): <T extends object>(span: T) => T {
  const emitter = createScrubbedEmitter({
    surface: config.surface,
    scrubOptions: config.scrubOptions,
    onSentrySpan: config.onSentrySpan,
  });
  return <T extends object>(span: T): T => emitter.beforeSendSpan(span as SentryEventLike) as T;
}

export function secretsFromEnv(env: {
  SENTRY_DSN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}): ObservabilitySecrets {
  return {
    sentryDsn: env.SENTRY_DSN,
    environment: env.SPLITCH_PLATFORM_TARGET ?? "local",
  };
}

/** Disable automatic payload collection; explicit events and spans still use scrubbers. */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  genAI: { inputs: false, outputs: false },
  graphQL: { document: false, variables: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
} satisfies NonNullable<import("@sentry/cloudflare").CloudflareOptions["dataCollection"]>;

/** Event processors also see transactions, which bypass Sentry's error-only hook. */
export function sentryPrivacyIntegration() {
  return {
    name: "SplitchPrivacy",
    processEvent<T extends object>(event: T): T {
      assertSentryEventType(event as SentryEventLike);
      return event;
    },
  };
}
