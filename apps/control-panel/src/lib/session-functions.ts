import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env as workerEnv } from "cloudflare:workers";
import { controlPanelBindings } from "./bindings";
import {
  AccessDeniedError,
  ScopedNotFoundError,
  type ScopeParams,
  resolveScopedLoaderContext,
} from "./loader-context";
import { createEnvironmentResolver, rehydrateLegacySession } from "./membership";
import { type SessionPrincipal, loadSessionFromRequest, publicSession } from "./session";

export type CurrentSessionResult =
  | { kind: "authenticated"; session: SessionPrincipal }
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
    const session = await rehydrateLegacySession(
      repo,
      bindings.SESSION_STORE,
      loaded.tokenHash,
      loaded.session,
    );
    return { kind: "authenticated", session: publicSession(session) };
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
