import type { SentryEventLike } from "@splitch/privacy";
import {
  applyResponseHeaders,
  type Observability,
  WORKER_BASELINE_SECURITY_HEADERS,
} from "@splitch/worker-runtime";
import {
  createScrubbedEmitter,
  createSentryBeforeSend,
  createSentryBeforeSendSpan,
  createSentryBeforeSendTransaction,
  type ScrubbedEmitter,
  secretsFromEnv,
} from "./emitter.js";
import {
  type RequestErrorContext,
  type RequestErrorReport,
  reduceRequestError,
  shouldReportRequestErrorToSentry,
} from "./request-error-sentry.js";
import { loadSentry, type SentryCloudflare } from "./sentry-module.js";
import type { ObservabilitySurfaceId } from "./surfaces.js";

type WorkerEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

type SentryErrorEvent = import("@sentry/cloudflare").ErrorEvent;
type SentrySpanJson = Parameters<
  NonNullable<import("@sentry/cloudflare").CloudflareOptions["beforeSendSpan"]>
>[0];
type SentryTransactionEvent = Parameters<
  NonNullable<import("@sentry/cloudflare").CloudflareOptions["beforeSendTransaction"]>
>[0];

export interface WorkerObservabilityOptions {
  readonly surface: ObservabilitySurfaceId;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** Build Worker observability options from request context. */
export function workerObservabilityWithWaitUntil(
  surface: ObservabilitySurfaceId,
  ctx: Pick<ExecutionContext, "waitUntil">,
): WorkerObservabilityOptions {
  return {
    surface,
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
}

const sentryHandlers = new WeakMap<object, ExportedHandler<WorkerEnv>>();

function getSentryWrappedHandler<E extends WorkerEnv, QueueMessage = unknown>(
  handler: ExportedHandler<E, QueueMessage>,
  options: WorkerObservabilityOptions,
  Sentry: SentryCloudflare,
): ExportedHandler<E, QueueMessage> {
  const cacheKey = handler as object;
  const cached = sentryHandlers.get(cacheKey);
  if (cached) {
    return cached as ExportedHandler<E, QueueMessage>;
  }
  const wrapped = Sentry.withSentry<E, QueueMessage, unknown, ExportedHandler<E, QueueMessage>>(
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
  const scrubbedBeforeSendSpan = createSentryBeforeSendSpan({ surface: options.surface });
  const scrubbedBeforeSendTransaction = createSentryBeforeSendTransaction({
    surface: options.surface,
  });
  return {
    dsn: secrets.sentryDsn,
    environment: secrets.environment,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 1,
    enableRpcTracePropagation: true,
    /**
     * Sentry continues an incoming trace from `sentry-trace`/`baggage` by default,
     * including one supplied by a stranger. Every Worker here is reachable from the
     * public internet, and the MCP server takes requests from arbitrary agent
     * clients, so an unauthenticated caller could otherwise choose our trace ids
     * and graft synthetic spans onto our traces. This starts a fresh trace when
     * the incoming baggage names a different org id than ours.
     *
     * `orgId` is deliberately not set: the SDK parses it from the DSN, so
     * hardcoding it here would be a second source of truth that silently disables
     * the check if it ever drifts. The corollary is that the check is only as
     * strong as the DSN -- `shouldContinueTrace` refuses only on a MISMATCH, so a
     * DSN host without an `o<orgid>` prefix leaves continuation wide open. Ours
     * carries one.
     */
    strictTraceContinuation: true,
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
    /**
     * `beforeSend` covers ERROR events only. With `tracesSampleRate: 1` above,
     * every request also ships a transaction and its child spans -- auto-
     * instrumented fetch spans carry the outbound URL, and our MCP spans carry
     * protocol attributes. Without this hook that entire payload bypasses the
     * redaction contract the event path enforces.
     */
    beforeSendSpan(span: SentrySpanJson) {
      return scrubbedBeforeSendSpan(
        span as unknown as SentryEventLike,
      ) as unknown as SentrySpanJson;
    },
    /**
     * `beforeSendSpan` only reaches the span slice of a transaction event. The
     * envelope around it -- `request` (Authorization header, cookies, query
     * string, courtesy of the default `requestDataIntegration`), `breadcrumbs`,
     * `tags`, `extra` -- has no hook of its own, so it needs the event scrubber.
     */
    beforeSendTransaction(event: SentryTransactionEvent) {
      return scrubbedBeforeSendTransaction(
        event as unknown as SentryEventLike,
      ) as unknown as SentryTransactionEvent;
    },
  };
}

/**
 * Wrap a Worker `ExportedHandler` with Sentry initialization and the scrubbed
 * `beforeSend` hook. When `SENTRY_DSN` is absent (local tests/dev), the raw
 * handler is used so waitUntil semantics stay unchanged.
 */
export function wrapWorkerHandler<E extends WorkerEnv, QueueMessage = unknown>(
  handler: ExportedHandler<E, QueueMessage> &
    Required<Pick<ExportedHandler<E, QueueMessage>, "fetch">>,
  options: WorkerObservabilityOptions,
): ExportedHandler<E, QueueMessage> & Required<Pick<ExportedHandler<E, QueueMessage>, "fetch">> {
  const innerFetch = handler.fetch;
  const wrapped: ExportedHandler<E, QueueMessage> &
    Required<Pick<ExportedHandler<E, QueueMessage>, "fetch">> = {
    async fetch(
      request: Parameters<NonNullable<ExportedHandler<E>["fetch"]>>[0],
      env: E,
      ctx: ExecutionContext,
    ) {
      if (!env.SENTRY_DSN) {
        return applyWorkerBaselineHeaders(await innerFetch(request, env, ctx));
      }
      const Sentry = await loadSentry();
      const sentryFetch = getSentryWrappedHandler(handler, options, Sentry).fetch;
      if (!sentryFetch) {
        throw new Error("observability: Sentry-wrapped handler is missing fetch");
      }
      return applyWorkerBaselineHeaders(await sentryFetch(request, env, ctx));
    },
  };

  if (handler.scheduled) {
    const innerScheduled = handler.scheduled;
    wrapped.scheduled = async (event: ScheduledController, env: E, ctx: ExecutionContext) => {
      if (!env.SENTRY_DSN) {
        await innerScheduled(event, env, ctx);
        return;
      }
      const Sentry = await loadSentry();
      const sentryScheduled = getSentryWrappedHandler(handler, options, Sentry).scheduled;
      await sentryScheduled?.(event, env, ctx);
    };
  }

  if (handler.queue) {
    const innerQueue = handler.queue;
    wrapped.queue = async (batch: MessageBatch<QueueMessage>, env: E, ctx: ExecutionContext) => {
      if (!env.SENTRY_DSN) {
        await innerQueue(batch, env, ctx);
        return;
      }
      const Sentry = await loadSentry();
      const sentryQueue = getSentryWrappedHandler(handler, options, Sentry).queue;
      if (!sentryQueue) {
        throw new Error("observability: Sentry-wrapped handler is missing queue");
      }
      await sentryQueue(batch, env, ctx);
    };
  }

  return wrapped;
}

/** Stamp the shared baseline on every Worker fetch response, including health and faults. */
function applyWorkerBaselineHeaders(response: Response): Response {
  return applyResponseHeaders(response, WORKER_BASELINE_SECURITY_HEADERS);
}

/**
 * The id of the trace this request belongs to.
 *
 * Exists so a surface can hand a caller a reference that RESOLVES. A freshly
 * minted UUID correlates with nothing: the operator receiving it has no query
 * that finds it. The trace id opens the trace with the request transaction, the
 * protocol spans, and every downstream call already attached.
 *
 * `undefined` without a DSN is not a fallback for missing data -- with tracing
 * off there is genuinely no trace, and the caller decides what to say instead.
 */
export async function activeTraceId(env: WorkerEnv): Promise<string | undefined> {
  if (!env.SENTRY_DSN) {
    return undefined;
  }
  const Sentry = await loadSentry();
  const span = Sentry.getActiveSpan();
  return span ? Sentry.spanToJSON(span).trace_id : undefined;
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
          keepWorkerAlive(options, captureSentryMessage(options, enriched));
        }
        return;
      }

      emitter.log("warn", "request_error", { ...enriched });
      if (env.SENTRY_DSN) {
        keepWorkerAlive(options, addSentryBreadcrumb(options, enriched));
      }
    },
  };
}

/**
 * Report a fault that corrupts no response: the request itself succeeded, but a
 * side-channel obligation (e.g. shipping a Run Snapshot to Tinybird) did not.
 * `onError` cannot carry it -- its Sentry routing keys on the response status,
 * and here the status is honestly 200. Same sinks as the request fault path:
 * a scrubbed Workers Logs row always, Sentry only where `SENTRY_DSN` is set.
 */
export function createWorkerFaultReporter(
  env: WorkerEnv,
  options: WorkerObservabilityOptions,
): (code: string, detail: Record<string, unknown>) => void {
  const emitter = workerEmitter(env, options, { onStructuredLogEvents: emitToWorkersLogs });
  return (code, detail) => {
    emitter.log("error", code, detail);
    if (env.SENTRY_DSN) {
      keepWorkerAlive(options, captureSentryMessage(options, { code, ...detail }));
    }
  };
}

function keepWorkerAlive(options: WorkerObservabilityOptions, promise: Promise<unknown>): void {
  if (options.waitUntil) {
    options.waitUntil(promise);
    return;
  }
  void promise;
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
  ctx: { readonly code: string },
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
    "onSentryEvent" | "onSentrySpan" | "onSentryTransaction" | "onStructuredLogEvents"
  > = {},
): ScrubbedEmitter {
  return createScrubbedEmitter({
    surface: options.surface,
    sentryDsn: env.SENTRY_DSN,
    environment: env.SPLITCH_PLATFORM_TARGET ?? "local",
    ...hooks,
  });
}
