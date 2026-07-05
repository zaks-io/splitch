import { createFileRoute } from "@tanstack/react-router";
import { env as workerEnv } from "cloudflare:workers";
import {
  completeAuthKitCallback,
  createAuthKitClient,
  createControlPanelRepository,
} from "#lib/authkit";
import { controlPanelBindings } from "#lib/bindings";
import { consumeOAuthState } from "#lib/oauth-state";

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
      },
    },
  },
});

function unauthorizedResponse(cookies: Array<string>): Response {
  return textResponse("Unauthorized", 401, cookies);
}

function redirectResponse(location: string, cookies: Array<string>): Response {
  const headers = responseHeaders(cookies);
  headers.set("location", location);
  return new Response(null, { headers, status: 302 });
}

function textResponse(body: string, status: number, cookies: Array<string>): Response {
  return new Response(body, { headers: responseHeaders(cookies), status });
}

function responseHeaders(cookies: Array<string>): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return headers;
}
