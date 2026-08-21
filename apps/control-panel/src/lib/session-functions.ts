import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ControlPanelBindings, controlPanelBindings } from "./bindings";
import {
  AccessDeniedError,
  resolveScopedLoaderContext,
  ScopedNotFoundError,
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

/**
 * `bindings`/`request` are explicit parameters (rather than read internally
 * from `workerEnv`/`getRequest()`) so this can be called directly in a test
 * against real Miniflare D1 + KV: `createServerFn`'s wrapped export only
 * behaves correctly through the framework's build-time transform, which
 * plain vitest does not apply.
 */
export async function loadCurrentSessionForRequest(
  bindings: ControlPanelBindings,
  request: Request,
): Promise<CurrentSessionResult> {
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
    session: publicSession(session),
    pendingOrgResync: pendingAfter
      ? { slug: pendingAfter.slug, reason: pendingAfter.reason, remedy: pendingAfter.remedy }
      : null,
  };
}

export const loadCurrentSession = createServerFn({ method: "GET" }).handler(() =>
  loadCurrentSessionForRequest(controlPanelBindings(workerEnv), getRequest()),
);

export const loadScopedSession = createServerFn({ method: "GET" })
  .validator((data: ScopeParams) => data)
  .handler(async ({ data }): Promise<ScopedSessionResult> => {
    const bindings = controlPanelBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings, getRequest());
    if (!loaded.ok) {
      return { kind: "unauthenticated" };
    }

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
        context: await resolveScopedLoaderContext(
          publicSession(session),
          data,
          createEnvironmentResolver(repo),
        ),
      };
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        return { kind: "forbidden" };
      }
      if (error instanceof ScopedNotFoundError) {
        return { kind: "notFound" };
      }
      throw error;
    }
  });
