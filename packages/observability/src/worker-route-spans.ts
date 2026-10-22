import { loadedSentry } from "./sentry-module.js";
import type { WorkerObservabilityOptions } from "./worker.js";

/** Name matched routes without loading Sentry from this synchronous hook. */
export function nameWorkerRouteSpans(
  env: { SENTRY_DSN?: string },
  options: WorkerObservabilityOptions,
  ctx: { method: string; path: string },
): void {
  // Registrars supply templates. MCP has only fixed paths, resolved against a
  // closed list so an unmatched request never contributes caller text.
  const path =
    options.surface === "mcp-server"
      ? [
          "/",
          "/mcp",
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-protected-resource/mcp",
        ].find((path) => path === ctx.path)
      : ["control-plane-api", "evaluation-api", "analysis-api"].includes(options.surface)
        ? ctx.path
        : undefined;
  if (!path) return;
  const name = `${ctx.method} ${path}`;
  const nativeSpan = options.tracing?.getActiveSpan?.();
  nativeSpan?.updateName(name);
  nativeSpan?.setAttribute("http.route", path);
  const Sentry = env.SENTRY_DSN ? loadedSentry() : undefined;
  const activeSpan = Sentry?.getActiveSpan?.();
  if (Sentry && activeSpan) {
    const rootSpan = Sentry.getRootSpan(activeSpan);
    Sentry.updateSpanName(rootSpan, name);
    rootSpan.setAttribute("http.route", path);
  }
}
