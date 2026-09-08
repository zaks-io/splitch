import type { ControlPanelBindings } from "#lib/shared/bindings";
import { DEFAULT_MUTATING_JSON_BODY_MAX_BYTES } from "@splitch/contracts";
import { readBoundedRequestBody } from "@splitch/worker-runtime";
import { rejectCrossOriginWrite } from "#lib/auth/panel-csrf";
import { documentTitle } from "#lib/shell/document-title";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";

export const CLAIM_CONSENT_MAX_BODY_BYTES = DEFAULT_MUTATING_JSON_BODY_MAX_BYTES;
const FORM_MEDIA_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data"];

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
  const parsed = await consentDecision(request);
  if (!parsed.ok) {
    return new Response("Invalid consent decision", { status: 400 });
  }
  const response = await fetch(
    `${bindings.AUTH_API_ORIGIN}/claim/consent/${encodeURIComponent(attemptId)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${loaded.session.workosAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: parsed.decision }),
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
  const title = documentTitle("Approve account linking");
  return new Response(
    `<!doctype html><html><head><title>${title}</title></head><body>
      <main><h1>Approve account linking</h1>
      <p>This approval links the provisional Organization to your signed-in identity.</p>
      <form method="post" action="/claim/consent/${escapedAttemptId}">
        <button type="submit" name="decision" value="approve">Approve linking</button>
        <button type="submit" name="decision" value="deny">Refuse linking</button>
      </form></main></body></html>`,
    { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" } },
  );
}

type ConsentDecisionResult = { ok: true; decision: "approve" | "deny" } | { ok: false };

async function consentDecision(request: Request): Promise<ConsentDecisionResult> {
  const bounded = await readBoundedRequestBody(request, {
    maxBytes: CLAIM_CONSENT_MAX_BODY_BYTES,
    allowedMediaTypes: FORM_MEDIA_TYPES,
  });
  if (!bounded.ok) return { ok: false };
  let decision: FormDataEntryValue | null;
  try {
    const form = await new Response(Uint8Array.from(bounded.bytes).buffer, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
    decision = form.get("decision");
  } catch {
    return { ok: false };
  }
  return decision === "approve" || decision === "deny" ? { ok: true, decision } : { ok: false };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
