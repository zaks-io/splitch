import { createFileRoute } from "@tanstack/react-router";
import { env as workerEnv } from "cloudflare:workers";
import { controlPanelBindings } from "#lib/shared/bindings";
import { destroyPanelSession, refuseSafeLogout } from "#lib/auth/logout";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      GET: () => refuseSafeLogout(),
      POST: ({ request }) => destroyPanelSession(controlPanelBindings(workerEnv), request),
    },
  },
});
