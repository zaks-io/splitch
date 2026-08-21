import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ControlPanelBindings, controlPanelBindings } from "./bindings";
import {
  AccessDeniedError,
  type AppScopedLoaderContext,
  type AppScopeParams,
  type EnvironmentResolver,
  resolveAppLoaderContext,
  resolveNavigation,
  resolveScopedLoaderContext,
  ScopedNotFoundError,
  type ScopeNavigation,
  type ScopeParams,
} from "./loader-context";
import { createEnvironmentResolver, rehydrateLegacySession } from "./membership";
import { readPendingResync } from "./pending-resync";
import { publicSession, type SessionPrincipal } from "./session";
import { loadSessionFromRequest } from "./session-refresh";
import { retryPendingResync } from "./session-resync";
import type { StaleSession } from "./stale-session";

export type CurrentSessionResult =
  | { kind: "authenticated"; session: SessionPrincipal; pendingOrgResync: StaleSession | null }
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
  const loaded = await loadSessionFromRequest(bindings, request);
  if (!loaded.ok) {
    return { kind: "unauthenticated" };
  }
  const repo = createRepository(bindings.DB);
  const rehydrated = await rehydrateLegacySession(
    repo,
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );

  // The self-heal half of "Reload to check again" (SPL-203 review round 2,
  // Blocker 2), mirrored from `org-app-list-functions.ts`: a pending
  // Organization marker means the last resync failed, so landing here again
  // actually re-attempts it instead of re-reading the identical stale
  // principal forever.
  const pendingBefore = await readPendingResync(
    bindings.SESSION_STORE,
    loaded.tokenHash,
    "organization",
  );
  const session = pendingBefore
    ? await retryPendingResync(bindings, loaded.tokenHash, rehydrated)
    : rehydrated;
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
  return {
    kind: "authenticated",
    session: principal,
    navigation: await resolveNavigation(principal, createEnvironmentResolver(healed.repo)),
  };
}

export const loadPanelNavigation = createServerFn({ method: "GET" }).handler(() =>
  loadPanelNavigationForRequest(controlPanelBindings(workerEnv), getRequest()),
);

export const loadScopedSession = createServerFn({ method: "GET" })
  .validator((data: ScopeParams) => data)
  .handler(
    ({ data }): Promise<ScopedSessionResult> =>
      loadScopedContext((session, resolver) => resolveScopedLoaderContext(session, data, resolver)),
  );

export const loadAppScopedSession = createServerFn({ method: "GET" })
  .validator((data: AppScopeParams) => data)
  .handler(
    ({ data }): Promise<AppScopedSessionResult> =>
      loadScopedContext((session, resolver) => resolveAppLoaderContext(session, data, resolver)),
  );

type AnyScopedSessionResult<T> =
  | { kind: "ok"; context: T }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "notFound" };

async function loadScopedContext<T>(
  resolve: (session: SessionPrincipal, resolver: EnvironmentResolver) => Promise<T>,
): Promise<AnyScopedSessionResult<T>> {
  const bindings = controlPanelBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings, getRequest());
  if (!loaded.ok) return { kind: "unauthenticated" };

  const repo = createRepository(bindings.DB);
  const session = await rehydrateLegacySession(
    repo,
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );
  try {
    return {
      kind: "ok",
      context: await resolve(publicSession(session), createEnvironmentResolver(repo)),
    };
  } catch (error) {
    if (error instanceof AccessDeniedError) return { kind: "forbidden" };
    if (error instanceof ScopedNotFoundError) return { kind: "notFound" };
    throw error;
  }
}
