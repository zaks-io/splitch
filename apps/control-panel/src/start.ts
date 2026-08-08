import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/**
 * Explicit CSRF for `createServerFn` POSTs.
 *
 * TanStack Start installs a default CSRF middleware only when this file is
 * absent (`hasStartInstance ? startOptions.requestMiddleware : [default]`).
 * Adding a `src/start.ts` without `createCsrfMiddleware` here silently removes
 * Origin / Sec-Fetch-Site checks from every panel write (`revokeControlPanelApiKey`,
 * Flag mutations, …). Pin the middleware in `requestMiddleware` and prove it
 * with a cross-site POST that must return 403 (see `start.test.ts`).
 *
 * Form POSTs (`/auth/logout`, `/claim/consent/$attemptId`) are not covered by
 * this middleware — they use `rejectCrossOriginWrite` in `panel-csrf.ts`.
 */
export const panelServerFnCsrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [panelServerFnCsrfMiddleware],
}));
