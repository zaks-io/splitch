// biome-ignore lint/performance/noNamespaceImport: @sentry/node documents namespace import for init APIs
import * as Sentry from "@sentry/node";
import { createScrubbedEmitter, createSentryBeforeSend, secretsFromEnv } from "./emitter.js";
import type { SentryEventLike } from "@splitch/privacy";

let initialized = false;

/** @internal Resets CLI Sentry init state between tests. */
export function __resetCliObservabilityForTests(): void {
  initialized = false;
}

export interface CliObservabilityEnv {
  SENTRY_DSN?: string;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}

/**
 * Initialize Sentry + Axiom for the CLI process. Idempotent — safe to call once
 * at CLI startup. When vendor tokens are absent (local dev), initialization is a
 * no-op except for registering the scrubbed emitters used in tests.
 */
export function initCliObservability(
  env: CliObservabilityEnv = process.env as CliObservabilityEnv,
): ReturnType<typeof createScrubbedEmitter> {
  const secrets = secretsFromEnv(env);
  const scrubbedBeforeSend = createSentryBeforeSend({ surface: "cli" });

  if (!initialized && secrets.sentryDsn) {
    Sentry.init({
      dsn: secrets.sentryDsn,
      environment: secrets.environment,
      beforeSend(event) {
        return scrubbedBeforeSend(event as unknown as SentryEventLike) as unknown as typeof event;
      },
    });
    initialized = true;
  }

  return createScrubbedEmitter({
    surface: "cli",
    ...secrets,
    onSentryCaptureException: secrets.sentryDsn
      ? (error, extra) => {
          Sentry.captureException(error, {
            extra,
            tags: { surface: "cli" },
          });
        }
      : undefined,
  });
}

export function cliEmitter(
  env: CliObservabilityEnv = process.env as CliObservabilityEnv,
  hooks: Omit<Parameters<typeof createScrubbedEmitter>[0], "surface"> = {},
): ReturnType<typeof createScrubbedEmitter> {
  const secrets = secretsFromEnv(env);
  return createScrubbedEmitter({ surface: "cli", ...secrets, ...hooks });
}
