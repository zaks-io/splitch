import { loadedSentry } from "./sentry-module.js";
import type { WorkerObservabilityOptions } from "./worker.js";

/** Name matched routes without loading Sentry from this synchronous hook. */
export function nameWorkerRouteSpans(
  env: { SENTRY_DSN?: string },
  options: WorkerObservabilityOptions,
  ctx: { method: string; path: string },
): void {
  // These registrars supply templates. Other surfaces still pass concrete paths.
  if (["control-plane-api", "evaluation-api", "analysis-api"].includes(options.surface)) {
    const name = `${ctx.method} ${ctx.path}`;
    const nativeSpan = options.tracing?.getActiveSpan?.();
    nativeSpan?.updateName(name);
    nativeSpan?.setAttribute("http.route", ctx.path);
    const Sentry = env.SENTRY_DSN ? loadedSentry() : undefined;
    const activeSpan = Sentry?.getActiveSpan?.();
    if (Sentry && activeSpan) {
      const rootSpan = Sentry.getRootSpan(activeSpan);
      Sentry.updateSpanName(rootSpan, name);
      rootSpan.setAttribute("http.route", ctx.path);
    }
  }
}
