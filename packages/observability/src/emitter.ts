import {
  scrubSentryEvent,
  scrubValue,
  type ScrubOptions,
  type SentryEventLike,
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
  /** Test hook: invoked with scrubbed structured log rows immediately before emit. */
  readonly onStructuredLogEvents?: (events: Record<string, unknown>[]) => void;
  /** When set, delivers scrubbed exceptions to the surface Sentry client. */
  readonly onSentryCaptureException?: (error: unknown, extra: Record<string, unknown>) => void;
}

export interface ScrubbedEmitter {
  readonly beforeSend: (event: SentryEventLike) => SentryEventLike;
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

  return {
    beforeSend,
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

export function secretsFromEnv(env: {
  SENTRY_DSN?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}): ObservabilitySecrets {
  return {
    sentryDsn: env.SENTRY_DSN,
    environment: env.SPLITCH_PLATFORM_TARGET ?? "local",
  };
}
