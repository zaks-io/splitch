import { createFileRoute } from "@tanstack/react-router";
import { env as workerEnv } from "cloudflare:workers";
import { callbackRedirectUri, createAuthKitClient } from "#lib/auth/authkit";
import { controlPanelBindings } from "#lib/shared/bindings";
import { createOAuthState } from "#lib/auth/oauth-state";
import { safeReturnPath } from "#lib/auth/return-path";
import { appendHttpOnlyCookie, type SerializedHttpOnlyCookie } from "#lib/sessions/session-cookie";

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const bindings = controlPanelBindings(workerEnv);
        const returnTo = safeReturnPath(
          new URL(request.url).searchParams.get("returnTo"),
          request.url,
        );
        const oauthState = await createOAuthState(bindings.SESSION_STORE, returnTo);
        const authKit = createAuthKitClient(bindings);
        const authorizationUrl = authKit.getAuthorizationUrl({
          clientId: bindings.WORKOS_CLIENT_ID,
          redirectUri: callbackRedirectUri(request),
          state: oauthState.state,
        });

        return redirectResponse(authorizationUrl, [oauthState.cookie]);
      },
    },
  },
});

function redirectResponse(location: string, cookies: Array<SerializedHttpOnlyCookie>): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
  });
  for (const cookie of cookies) {
    appendHttpOnlyCookie(headers, cookie);
  }
  return new Response(null, { headers, status: 302 });
}
