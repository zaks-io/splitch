import type { Observability } from "@splitch/worker-runtime";
import type { SentryEventLike } from "@splitch/privacy";
import {
  createScrubbedEmitter,
  createSentryBeforeSend,
  secretsFromEnv,
  type ScrubbedEmitter,
} from "./emitter.js";
import {
  resolveRequestErrorStatus,
  shouldReportRequestErrorToSentry,
  type RequestErrorContext,
} from "./request-error-sentry.js";
import type { ObservabilitySurfaceId } from "./surfaces.js";

type WorkerEnv = {
  SENTRY_DSN?: string;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

type SentryCloudflare = typeof import("@sentry/cloudflare");
type SentryErrorEvent = import("@sentry/cloudflare").ErrorEvent;

export interface WorkerObservabilityOptions {
  readonly surface: ObservabilitySurfaceId;
  readonly scheduleBackgroundWork?: (work: Promise<unknown>) => void;
}

/** Bind Worker observability background work to `ctx.waitUntil`. */
export function workerObservabilityWithWaitUntil(
  surface: ObservabilitySurfaceId,
  ctx: Pick<ExecutionContext, "waitUntil">,
): WorkerObservabilityOptions {
  return {
    surface,
    scheduleBackgroundWork: (work) => ctx.waitUntil(work),
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
  const wrapped = Sentry.withSentry((env) => workerSentryOptions(env, options, Sentry), handler);
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
    tracesSampleRate: secrets.environment === "production" ? 0.1 : 1,
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
 * Worker-runtime observability hooks that log scrubbed structured events to Axiom
 * (when configured) and leave error capture to Sentry's automatic instrumentation.
 */
export function createWorkerObservability(
  env: WorkerEnv,
  options: WorkerObservabilityOptions,
): Observability {
  const emitter = workerEmitter(env, options);
  return {
    onRequest(ctx: { requestId: string; method: string; path: string }) {
      emitter.log("info", "request", ctx);
    },
    onError(ctx: RequestErrorContext) {
      const status = resolveRequestErrorStatus(ctx);
      const enriched = { ...ctx, status };

      if (shouldReportRequestErrorToSentry(ctx)) {
        emitter.log("error", "request_fault", enriched);
        if (env.SENTRY_DSN) {
          void captureSentryMessage(options, enriched);
        }
        return;
      }

      emitter.log("warn", "request_error", enriched);
      if (env.SENTRY_DSN) {
        void addSentryBreadcrumb(options, enriched);
      }
    },
  };
}

async function captureSentryMessage(
  options: WorkerObservabilityOptions,
  ctx: RequestErrorContext & { status: number },
): Promise<void> {
  const Sentry = await loadSentry();
  Sentry.captureMessage(`worker fault ${ctx.code}`, {
    level: "error",
    tags: { surface: options.surface, code: ctx.code },
    extra: { requestId: ctx.requestId, code: ctx.code, status: ctx.status },
  });
}

async function addSentryBreadcrumb(
  options: WorkerObservabilityOptions,
  ctx: RequestErrorContext & { status: number },
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
  hooks: Pick<Parameters<typeof createScrubbedEmitter>[0], "onSentryEvent" | "onAxiomEvents"> = {},
): ScrubbedEmitter {
  const secrets = secretsFromEnv(env);
  return createScrubbedEmitter({
    surface: options.surface,
    ...secrets,
    scheduleBackgroundWork: options.scheduleBackgroundWork,
    ...hooks,
  });
}
