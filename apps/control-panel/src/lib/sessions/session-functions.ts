import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { readPendingResync } from "#lib/live-updates/pending-resync";
import {
  authorizedEntry,
  lastVisitedEntry,
  lastVisitedOrgId,
  parseLastVisitedCookie,
  recordVisit,
  serializeLastVisitedCookie,
} from "#lib/sessions/last-visited-scope";
import { createEnvironmentResolver, rehydrateLegacySession } from "#lib/sessions/membership";
import { publicSession, type SessionPrincipal } from "#lib/sessions/session";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";
import { retryPendingResync } from "#lib/sessions/session-resync";
import type { StaleSession } from "#lib/sessions/stale-session";
import { type ControlPanelBindings, controlPanelBindings } from "#lib/shared/bindings";
import {
  AccessDeniedError,
  type AppScopedLoaderContext,
  type EnvironmentResolver,
  resolveAppLoaderContext,
  resolveNavigation,
  resolveScopedLoaderContext,
  ScopedNotFoundError,
  type ScopeNavigation,
} from "#lib/shared/loader-context";
import { deferredDestinationAt } from "#lib/shell/app-shell-navigation";

export type CurrentSessionResult =
  | {
      kind: "authenticated";
      session: SessionPrincipal;
      pendingOrgResync: StaleSession | null;
      /** The `__last_visited` hint, unverified against the session: `/` checks membership before redirecting. */
      lastVisitedOrgId: string | null;
    }
  | { kind: "unauthenticated" };

export type ScopedSessionResult =
  | {
      kind: "ok";
      context: Awaited<ReturnType<typeof resolveScopedLoaderContext>>;
    }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "notFound" };

export type AppScopedSessionResult =
  | { kind: "ok"; context: AppScopedLoaderContext }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "notFound" };

export type PanelNavigationResult =
  | {
      kind: "authenticated";
      session: SessionPrincipal;
      navigation: ScopeNavigation;
    }
  | { kind: "unauthenticated" };

/**
 * `bindings`/`request` are explicit parameters (rather than read internally
 * from `workerEnv`/`getRequest()`) so this can be called directly in a test
 * against real Miniflare D1 + KV: `createServerFn`'s wrapped export only
 * behaves correctly through the framework's build-time transform, which
 * plain vitest does not apply.
 */
type HealedSession =
  | {
      kind: "authenticated";
      repo: ReturnType<typeof createRepository>;
      session: Awaited<ReturnType<typeof rehydrateLegacySession>>;
      pendingOrgResync: StaleSession | null;
    }
  | { kind: "unauthenticated" };

/**
 * Every authenticated Panel load goes through here so the pending-Organization
 * self-heal runs on each of them, not only on the `/` chooser.
 */
async function loadHealedSession(
  bindings: ControlPanelBindings,
  request: Request,
): Promise<HealedSession> {
  const spans = createPerformanceSpanRecorder(bindings);
  const loaded = await spans.record({ name: "Panel session load", op: "cache.get" }, () =>
    loadSessionFromRequest(bindings, request),
  );
  if (!loaded.ok) {
    return { kind: "unauthenticated" };
  }
  const repo = createRepository(bindings.DB);
  const rehydrated = await spans.record({ name: "Panel session rehydrate", op: "function" }, () =>
    rehydrateLegacySession(repo, bindings.SESSION_STORE, loaded.tokenHash, loaded.session),
  );

  // The self-heal half of "Reload to check again" (SPL-203 review round 2,
  // Blocker 2), mirrored from `org-app-list-functions.ts`: a pending
  // Organization marker means the last resync failed, so landing here again
  // actually re-attempts it instead of re-reading the identical stale
  // principal forever.
  const pendingBefore = await spans.record(
    { name: "Panel pending resync read", op: "cache.get" },
    () => readPendingResync(bindings.SESSION_STORE, loaded.tokenHash, "organization"),
  );
  const session = await spans.record(
    {
      name: "Panel session resync",
      op: "function",
      attributes: {
        "session.pending_resync": pendingBefore !== null,
        "session.resync_attempted": pendingBefore !== null,
      },
    },
    async (span) => {
      const resolved = pendingBefore
        ? await retryPendingResync(bindings, loaded.tokenHash, rehydrated)
        : rehydrated;
      span.setAttribute(
        "session.resync_succeeded",
        Boolean(pendingBefore && resolved !== rehydrated),
      );
      return resolved;
    },
  );
  // One SESSION_STORE read covers both the retry guard above and the notice
  // below (mirrors org-app-list-functions.ts): `retryPendingResync` clears
  // the marker on success, always handing back a new session reference
  // (never the `rehydrated` one it was given — `session-resync.test.ts` pins
  // this with `toBe`), and leaves the marker untouched, same reference, on
  // failure or when no retry ran at all. So the post-retry marker state is
  // derivable from `pendingBefore` without a second `get`.
  const pendingAfter = pendingBefore && session !== rehydrated ? null : pendingBefore;

  return {
    kind: "authenticated",
    repo,
    session,
    pendingOrgResync: pendingAfter
      ? { slug: pendingAfter.slug, reason: pendingAfter.reason, remedy: pendingAfter.remedy }
      : null,
  };
}

export async function loadCurrentSessionForRequest(
  bindings: ControlPanelBindings,
  request: Request,
): Promise<CurrentSessionResult> {
  const healed = await loadHealedSession(bindings, request);
  if (healed.kind === "unauthenticated") return healed;
  return {
    kind: "authenticated",
    session: publicSession(healed.session),
    pendingOrgResync: healed.pendingOrgResync,
    lastVisitedOrgId: lastVisitedOrgId(
      parseLastVisitedCookie(request.headers.get("cookie"), healed.session.userId),
    ),
  };
}

export const loadCurrentSession = createServerFn({ method: "GET" }).handler(() =>
  loadCurrentSessionForRequest(controlPanelBindings(workerEnv), getRequest()),
);

export async function loadPanelNavigationForRequest(
  bindings: ControlPanelBindings,
  request: Request,
): Promise<PanelNavigationResult> {
  const healed = await loadHealedSession(bindings, request);
  if (healed.kind === "unauthenticated") return healed;
  const principal = publicSession(healed.session);
  const spans = createPerformanceSpanRecorder(bindings);
  return {
    kind: "authenticated",
    session: principal,
    navigation: await spans.record({ name: "Panel navigation resolve", op: "db.query" }, () =>
      resolveNavigation(principal, createEnvironmentResolver(healed.repo)),
    ),
  };
}

export const loadPanelNavigation = createServerFn({ method: "GET" }).handler(() =>
  loadPanelNavigationForRequest(controlPanelBindings(workerEnv), getRequest()),
);

const ScopedSessionInputSchema = z.object({
  orgSlug: z.string().min(1),
  appSlug: z.string().min(1),
  env: z.string().min(1),
  visitPath: z
    .string()
    .regex(/^\/(?!\/)[^\\?#\s]*$/)
    .nullable(),
});

export type ScopedSessionInput = z.infer<typeof ScopedSessionInputSchema>;

export const loadScopedSession = createServerFn({ method: "GET" })
  .validator((data: unknown) => ScopedSessionInputSchema.parse(data))
  .handler(async ({ data }): Promise<ScopedSessionResult> => {
    const request = getRequest();
    const result = await loadScopedSessionForRequest(
      controlPanelBindings(workerEnv),
      request,
      data,
    );
    const cookie = scopedVisitCookie(result, request, data);
    if (cookie) setResponseHeader("set-cookie", cookie);
    return result;
  });

async function loadScopedSessionForRequest(
  bindings: ControlPanelBindings,
  request: Request,
  data: ScopedSessionInput,
): Promise<ScopedSessionResult> {
  return loadScopedContextForRequest(bindings, request, (session, resolver) =>
    resolveScopedLoaderContext(session, data, resolver),
  );
}

function scopedVisitCookie(
  result: ScopedSessionResult,
  request: Request,
  data: ScopedSessionInput,
): string | null {
  if (
    result.kind !== "ok" ||
    data.visitPath === null ||
    deferredDestinationAt(data.visitPath, data)
  ) {
    return null;
  }

  const { scope, session } = result.context;
  return serializeLastVisitedCookie(
    recordVisit(
      parseLastVisitedCookie(request.headers.get("cookie"), session.userId),
      session.userId,
      scope.orgId,
      lastVisitedEntry(scope.appSlug, scope.env, data.visitPath, Date.now()),
    ),
  );
}

const AppScopedSessionInputSchema = z.object({
  orgSlug: z.string().min(1),
  appSlug: z.string().min(1),
  visitPath: z
    .string()
    .regex(/^\/(?!\/)[^\\?#\s]*$/)
    .nullable(),
});

export type AppScopedSessionInput = z.infer<typeof AppScopedSessionInputSchema>;

export const loadAppScopedSession = createServerFn({ method: "GET" })
  .validator((data: unknown) => AppScopedSessionInputSchema.parse(data))
  .handler(async ({ data }): Promise<AppScopedSessionResult> => {
    const request = getRequest();
    const result = await loadAppScopedSessionForRequest(
      controlPanelBindings(workerEnv),
      request,
      data,
    );
    const cookie = appScopedVisitCookie(result, request, data);
    if (cookie) setResponseHeader("set-cookie", cookie);
    return result;
  });

async function loadAppScopedSessionForRequest(
  bindings: ControlPanelBindings,
  request: Request,
  data: AppScopedSessionInput,
): Promise<AppScopedSessionResult> {
  return loadScopedContextForRequest(bindings, request, (session, resolver) =>
    resolveAppLoaderContext(session, data, resolver),
  );
}

export function appScopedVisitCookie(
  result: AppScopedSessionResult,
  request: Request,
  data: AppScopedSessionInput,
): string | null {
  if (result.kind !== "ok" || data.visitPath === null) return null;

  const { scope, session } = result.context;
  const entry = lastVisitedEntry(scope.appSlug, null, data.visitPath, Date.now());
  const authorized = authorizedEntry(entry, {
    orgSlug: scope.orgSlug,
    apps: [
      {
        appSlug: scope.appSlug,
        environments: scope.environments,
      },
    ],
  });
  if (!authorized) throw new Error("Cannot record a visit outside the resolved App scope");

  return serializeLastVisitedCookie(
    recordVisit(
      parseLastVisitedCookie(request.headers.get("cookie"), session.userId),
      session.userId,
      scope.orgId,
      authorized,
    ),
  );
}

type AnyScopedSessionResult<T> =
  | { kind: "ok"; context: T }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "notFound" };

export async function loadScopedContextForRequest<T>(
  bindings: ControlPanelBindings,
  request: Request,
  resolve: (session: SessionPrincipal, resolver: EnvironmentResolver) => Promise<T>,
): Promise<AnyScopedSessionResult<T>> {
  const healed = await loadHealedSession(bindings, request);
  if (healed.kind === "unauthenticated") return healed;
  try {
    const spans = createPerformanceSpanRecorder(bindings);
    return {
      kind: "ok",
      context: await spans.record({ name: "Panel scoped context resolve", op: "db.query" }, () =>
        resolve(publicSession(healed.session), createEnvironmentResolver(healed.repo)),
      ),
    };
  } catch (error) {
    if (error instanceof AccessDeniedError) return { kind: "forbidden" };
    if (error instanceof ScopedNotFoundError) return { kind: "notFound" };
    throw error;
  }
}
