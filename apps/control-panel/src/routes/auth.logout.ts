import { createFileRoute } from "@tanstack/react-router";
import { env as workerEnv } from "cloudflare:workers";
import { controlPanelBindings } from "#lib/bindings";
import { createAuthKitClient } from "#lib/authkit";
import { destroySession } from "#lib/session";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const bindings = controlPanelBindings(workerEnv);
        const destroyed = await destroySession(bindings.SESSION_STORE, request);
        const returnTo = new URL("/", request.url).toString();
        const location = destroyed.session?.workosSessionId
          ? createAuthKitClient(bindings).getLogoutUrl({
              sessionId: destroyed.session.workosSessionId,
              returnTo,
            })
          : returnTo;

        return redirectResponse(location, destroyed.cookie);
      },
    },
  },
});

function redirectResponse(location: string, cookie: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: location,
  });
  headers.append("Set-Cookie", cookie);
  return new Response(null, { headers, status: 302 });
}
