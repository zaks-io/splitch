import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

/**
 * Explicit CSRF for `createServerFn` POSTs.
 *
 * TanStack Start installs a default CSRF middleware only when this file is
 * absent (`hasStartInstance ? startOptions.requestMiddleware : [default]`).
 * Adding a `src/start.ts` without this middleware silently removes Origin and
 * Sec-Fetch-Site checks from every panel write. Do not set
 * `allowRequestsWithoutOriginCheck`; `start.test.ts` pins the fail-closed path.
 */
export const panelServerFnCsrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

const serverFunctionTracing = createMiddleware({ type: "function" })
  .client(async ({ method, next }) => {
    const Sentry = await import("@sentry/react");
    return Sentry.startSpan(
      {
        name: `${method} server function`,
        op: "function.client",
        attributes: { "rpc.system": "tanstack.start" },
      },
      () => next(),
    );
  })
  .server(async ({ method, next, serverFnMeta }) => {
    const Sentry = await import("@sentry/cloudflare");
    const { getRequest } = await import("@tanstack/react-start/server");
    const activeSpan = Sentry.getActiveSpan();
    const rootSpan = activeSpan ? Sentry.getRootSpan(activeSpan) : undefined;
    if (rootSpan && getRequest().headers.get("x-tsr-serverFn") === "true") {
      Sentry.updateSpanName(rootSpan, `${method} ${serverFnMeta.name}`);
      rootSpan.setAttributes({
        "code.function.name": serverFnMeta.name,
        "rpc.system": "tanstack.start",
      });
    }
    return Sentry.startSpan(
      {
        name: serverFnMeta.name,
        op: "function.server",
        attributes: {
          "code.file.path": serverFnMeta.filename,
          "code.function.name": serverFnMeta.name,
          "rpc.system": "tanstack.start",
        },
      },
      () => next(),
    );
  });

export const startInstance = createStart(() => ({
  requestMiddleware: [panelServerFnCsrfMiddleware],
  functionMiddleware: [serverFunctionTracing],
}));
