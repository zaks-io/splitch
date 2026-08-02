import type { Observability } from "@splitch/worker-runtime";
import type { SentryEventLike } from "@splitch/privacy";
import {
  createScrubbedEmitter,
  createSentryBeforeSend,
  secretsFromEnv,
  type ScrubbedEmitter,
} from "./emitter.js";
import {
  reduceRequestError,
  shouldReportRequestErrorToSentry,
  type RequestErrorContext,
  type RequestErrorReport,
} from "./request-error-sentry.js";
import type { ObservabilitySurfaceId } from "./surfaces.js";

type WorkerEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

type SentryCloudflare = typeof import("@sentry/cloudflare");
type SentryErrorEvent = import("@sentry/cloudflare").ErrorEvent;

export interface WorkerObservabilityOptions {
  readonly surface: ObservabilitySurfaceId;
}

/** Build Worker observability options from request context. */
export function workerObservabilityWithWaitUntil(
  surface: ObservabilitySurfaceId,
  _ctx: Pick<ExecutionContext, "waitUntil">,
): WorkerObservabilityOptions {
  return {
    surface,
  };
}

let sentryModule: SentryCloudflare | undefined;
let sentryModuleOverride: SentryCloudflare | undefined;
const sentryHandlers = new WeakMap<object, ExportedHandler<WorkerEnv>>();

/** @internal Injects a Sentry client for unit tests. */
export function __setSentryModuleForTests(module: SentryCloudflare | undefined): void {
  sentryModuleOverride = module;
  sentryModule = module;
}

async function loadSentry(): Promise<SentryCloudflare> {
  if (sentryModuleOverride) {
    return sentryModuleOverride;
  }
  sentryModule ??= await import("@sentry/cloudflare");
  return sentryModule;
}

function getSentryWrappedHandler<E extends WorkerEnv>(
  handler: ExportedHandler<E>,
  options: WorkerObservabilityOptions,
  Sentry: SentryCloudflare,
): ExportedHandler<E> {
  const cacheKey = handler as object;
  const cached = sentryHandlers.get(cacheKey);
  if (cached) {
    return cached as ExportedHandler<E>;
  }
  const wrapped = Sentry.withSentry<E, unknown, unknown, ExportedHandler<E>>(
    (env) => workerSentryOptions(env, options, Sentry),
    handler,
  );
  sentryHandlers.set(cacheKey, wrapped as ExportedHandler<WorkerEnv>);
  return wrapped;
}

/**
 * Sentry options for `withSentry`, including the shared PII scrubber `beforeSend`.
 */
export function workerSentryOptions(
  env: WorkerEnv,
  options: WorkerObservabilityOptions,
  _Sentry: SentryCloudflare,
) {
  const secrets = secretsFromEnv(env);
  const scrubbedBeforeSend = createSentryBeforeSend({ surface: options.surface });
  return {
    dsn: secrets.sentryDsn,
    environment: secrets.environment,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: secrets.environment === "production" ? 0.1 : 1,
    /**
     * `@sentry/cloudflare` enables `consoleIntegration()` by default, which would
     * capture our own fault row (emitToWorkersLogs) as a breadcrumb and attach it
     * to the `captureMessage` fired immediately after -- every fault event would
     * carry a duplicate of its own payload. The row already reaches Sentry as
     * `extra`, so the breadcrumb is pure duplication.
     */
    integrations: (defaults: { name: string }[]) => defaults.filter((i) => i.name !== "Console"),
    beforeSend(event: SentryErrorEvent) {
      return scrubbedBeforeSend(event as unknown as SentryEventLike) as unknown as SentryErrorEvent;
    },
  };
}

/**
 * Wrap a Worker `ExportedHandler` with Sentry initialization and the scrubbed
 * `beforeSend` hook. When `SENTRY_DSN` is absent (local tests/dev), the raw
 * handler is used so waitUntil semantics stay unchanged.
 */
export function wrapWorkerHandler<E extends WorkerEnv>(
  handler: ExportedHandler<E> & Required<Pick<ExportedHandler<E>, "fetch">>,
  options: WorkerObservabilityOptions,
): ExportedHandler<E> & Required<Pick<ExportedHandler<E>, "fetch">> {
  const innerFetch = handler.fetch;
  const wrapped: ExportedHandler<E> & Required<Pick<ExportedHandler<E>, "fetch">> = {
    async fetch(
      request: Parameters<NonNullable<ExportedHandler<E>["fetch"]>>[0],
      env: E,
      ctx: ExecutionContext,
    ) {
      if (!env.SENTRY_DSN) {
        return innerFetch(request, env, ctx);
      }
      const Sentry = await loadSentry();
      const sentryFetch = getSentryWrappedHandler(handler, options, Sentry).fetch;
      if (!sentryFetch) {
        throw new Error("observability: Sentry-wrapped handler is missing fetch");
      }
      return sentryFetch(request, env, ctx);
    },
  };

  if (handler.scheduled) {
    const innerScheduled = handler.scheduled;
    wrapped.scheduled = async (event: ScheduledController, env: E, ctx: ExecutionContext) => {
      if (!env.SENTRY_DSN) {
        innerScheduled(event, env, ctx);
        return;
      }
      const Sentry = await loadSentry();
      const sentryScheduled = getSentryWrappedHandler(handler, options, Sentry).scheduled;
      sentryScheduled?.(event, env, ctx);
    };
  }

  return wrapped;
}

/**
 * Worker-runtime observability hooks that keep the shared scrubber path in-process
 * and leave external log export to Cloudflare Observability destinations.
 */
export function createWorkerObservability(
  env: WorkerEnv,
  options: WorkerObservabilityOptions,
): Observability {
  const emitter = workerEmitter(env, options, { onStructuredLogEvents: emitToWorkersLogs });
  return {
    onRequest(ctx: { requestId: string; method: string; path: string }) {
      emitter.log("info", "request", ctx);
    },
    onError(ctx: RequestErrorContext) {
      const enriched = reduceRequestError(ctx);

      if (shouldReportRequestErrorToSentry(ctx)) {
        emitter.log("error", "request_fault", { ...enriched });
        if (env.SENTRY_DSN) {
          void captureSentryMessage(options, enriched);
        }
        return;
      }

      emitter.log("warn", "request_error", { ...enriched });
      if (env.SENTRY_DSN) {
        void addSentryBreadcrumb(options, enriched);
      }
    },
  };
}

/**
 * Workers Logs and `wrangler tail` collect console output, and the scrubbed
 * emitter has no sink of its own -- without this a fault row is built, scrubbed,
 * and dropped, so the thrown value reaches an operator only where `SENTRY_DSN`
 * is set. That is false in local dev and in the e2e fleet, which is exactly
 * where a blank 500 has to be diagnosable.
 *
 * `error` only, and the line is exactly "what the caller cannot see for itself".
 * A 4xx already returns a contract-shaped body carrying its code and request id,
 * so an operator log adds nothing an attacker-driven flood of 401s or 429s does
 * not also multiply -- Workers Logs bills per event, and the volume there is
 * chosen by the caller. A 500's body is deliberately opaque, so this is its only
 * channel. Rows arrive already scrubbed from `createScrubbedEmitter`.
 */
function emitToWorkersLogs(events: Record<string, unknown>[]): void {
  for (const event of events) {
    if (event.level === "error") {
      console.error(event);
    }
  }
}

async function captureSentryMessage(
  options: WorkerObservabilityOptions,
  ctx: RequestErrorReport,
): Promise<void> {
  const Sentry = await loadSentry();
  Sentry.captureMessage(`worker fault ${ctx.code}`, {
    level: "error",
    tags: { surface: options.surface, code: ctx.code },
    extra: { ...ctx },
  });
}

async function addSentryBreadcrumb(
  options: WorkerObservabilityOptions,
  ctx: RequestErrorReport,
): Promise<void> {
  const Sentry = await loadSentry();
  Sentry.addBreadcrumb({
    category: "request_error",
    level: "info",
    message: ctx.code,
    data: { surface: options.surface, ...ctx },
  });
}

/** Surface-scoped scrubbed emitter used by Workers and cross-surface tests. */
export function workerEmitter(
  env: WorkerEnv,
  options: WorkerObservabilityOptions,
  hooks: Pick<
    Parameters<typeof createScrubbedEmitter>[0],
    "onSentryEvent" | "onStructuredLogEvents"
  > = {},
): ScrubbedEmitter {
  return createScrubbedEmitter({
    surface: options.surface,
    sentryDsn: env.SENTRY_DSN,
    environment: env.SPLITCH_PLATFORM_TARGET ?? "local",
    ...hooks,
  });
}
