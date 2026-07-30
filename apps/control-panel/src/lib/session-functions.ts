import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelBindings } from "./bindings";
import {
  AccessDeniedError,
  resolveScopedLoaderContext,
  ScopedNotFoundError,
  type ScopeParams,
} from "./loader-context";
import { createEnvironmentResolver, rehydrateLegacySession } from "./membership";
import { readPendingResync } from "./pending-resync";
import { loadSessionFromRequest, publicSession, type SessionPrincipal } from "./session";
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

export const loadCurrentSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<CurrentSessionResult> => {
    const bindings = controlPanelBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
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

    const pendingAfter = await readPendingResync(
      bindings.SESSION_STORE,
      loaded.tokenHash,
      "organization",
    );
    return {
      kind: "authenticated",
      session: publicSession(session),
      pendingOrgResync: pendingAfter
        ? { slug: pendingAfter.slug, reason: pendingAfter.reason, remedy: pendingAfter.remedy }
        : null,
    };
  },
);

export const loadScopedSession = createServerFn({ method: "GET" })
  .validator((data: ScopeParams) => data)
  .handler(async ({ data }): Promise<ScopedSessionResult> => {
    const bindings = controlPanelBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
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
