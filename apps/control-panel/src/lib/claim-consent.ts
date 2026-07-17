import type { ControlPanelBindings } from "./bindings";
import { loadSessionFromRequest } from "./session";

/** Browser sends only its opaque cookie. The WorkOS JWT stays in the KV record. */
export async function forwardClaimConsent(
  bindings: ControlPanelBindings,
  request: Request,
  attemptId: string,
) {
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, request);
  if (!loaded.ok || !loaded.session.workosAccessToken)
    return new Response("Unauthorized", { status: 401 });
  const response = await fetch(
    `${bindings.AUTH_API_ORIGIN}/claim/consent/${encodeURIComponent(attemptId)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${loaded.session.workosAccessToken}` },
    },
  );
  return new Response(null, { status: response.status, headers: { "cache-control": "no-store" } });
}
