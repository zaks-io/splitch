import type { ControlPanelBindings } from "./bindings";
import { rejectCrossOriginWrite } from "./panel-csrf";
import { loadSessionFromRequest } from "./session-refresh";

/** Browser sends only its opaque cookie. The WorkOS JWT stays in the KV record. */
export async function forwardClaimConsent(
  bindings: ControlPanelBindings,
  request: Request,
  attemptId: string,
) {
  const rejected = rejectCrossOriginWrite(request);
  if (rejected) return rejected;

  const loaded = await loadSessionFromRequest(bindings, request);
  if (!loaded.ok || !loaded.session.workosAccessToken)
    return new Response("Unauthorized", { status: 401 });
  const decision = await consentDecision(request);
  if (!decision) return new Response("Invalid consent decision", { status: 400 });
  const response = await fetch(
    `${bindings.AUTH_API_ORIGIN}/claim/consent/${encodeURIComponent(attemptId)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${loaded.session.workosAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision }),
    },
  );
  const body = response.status === 204 ? null : await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "cache-control": "no-store",
      "content-type": response.headers.get("content-type") ?? "text/plain; charset=utf-8",
    },
  });
}

export function consentLoginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    },
  });
}

export function renderConsentPage(attemptId: string): Response {
  const escapedAttemptId = escapeHtml(attemptId);
  return new Response(
    `<!doctype html><html><head><title>Approve account linking</title></head><body>
      <main><h1>Approve account linking</h1>
      <p>This approval links the provisional Organization to your signed-in identity.</p>
      <form method="post" action="/claim/consent/${escapedAttemptId}">
        <button type="submit" name="decision" value="approve">Approve linking</button>
        <button type="submit" name="decision" value="deny">Refuse linking</button>
      </form></main></body></html>`,
    { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" } },
  );
}

async function consentDecision(request: Request): Promise<"approve" | "deny" | null> {
  try {
    const form = await request.clone().formData();
    const decision = form.get("decision");
    if (decision === "approve" || decision === "deny") return decision;
  } catch {
    // Treat malformed form data as an invalid decision.
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
