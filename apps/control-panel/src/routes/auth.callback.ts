import { env as workerEnv } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import {
  AuthKitEmailUnverifiedError,
  completeAuthKitCallback,
  createAuthKitClient,
  createControlPanelRepository,
} from "#lib/authkit";
import { controlPanelBindings } from "#lib/bindings";
import { consumeOAuthState } from "#lib/oauth-state";
import { appendHttpOnlyCookie, type SerializedHttpOnlyCookie } from "#lib/session-cookie";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const bindings = controlPanelBindings(workerEnv);
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const consumedState = await consumeOAuthState(
          bindings.SESSION_STORE,
          request,
          url.searchParams.get("state"),
        );

        if (!code || !consumedState.ok) {
          return unauthorizedResponse([consumedState.clearCookie]);
        }

        try {
          const callback = await completeAuthKitCallback({
            authKit: createAuthKitClient(bindings),
            clientId: bindings.WORKOS_CLIENT_ID,
            code,
            kv: bindings.SESSION_STORE,
            repo: createControlPanelRepository(bindings),
            request,
          });

          return redirectResponse(consumedState.returnTo, [
            consumedState.clearCookie,
            callback.cookie,
          ]);
        } catch (error) {
          if (error instanceof AuthKitEmailUnverifiedError) {
            return textResponse(error.message, 403, [consumedState.clearCookie]);
          }
          throw error;
        }
      },
    },
  },
});

function unauthorizedResponse(cookies: Array<SerializedHttpOnlyCookie>): Response {
  return textResponse("Unauthorized", 401, cookies);
}

function redirectResponse(location: string, cookies: Array<SerializedHttpOnlyCookie>): Response {
  const headers = responseHeaders(cookies);
  headers.set("location", location);
  return new Response(null, { headers, status: 302 });
}

function textResponse(
  body: string,
  status: number,
  cookies: Array<SerializedHttpOnlyCookie>,
): Response {
  return new Response(body, { headers: responseHeaders(cookies), status });
}

function responseHeaders(cookies: Array<SerializedHttpOnlyCookie>): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const cookie of cookies) {
    appendHttpOnlyCookie(headers, cookie);
  }
  return headers;
}
