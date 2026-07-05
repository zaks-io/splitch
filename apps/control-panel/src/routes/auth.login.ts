import { createFileRoute } from "@tanstack/react-router";
import { env as workerEnv } from "cloudflare:workers";
import { callbackRedirectUri, createAuthKitClient } from "#lib/authkit";
import { controlPanelBindings } from "#lib/bindings";
import { createOAuthState } from "#lib/oauth-state";
import { safeReturnPath } from "#lib/return-path";

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

function redirectResponse(location: string, cookies: Array<string>): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
  });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { headers, status: 302 });
}
