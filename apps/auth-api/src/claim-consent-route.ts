import { approveClaimConsent, type ClaimDeps, refuseClaimConsent } from "./claim";
import { OAuthError, renderDoorFault, renderOAuthError } from "./oauth-errors";
import { readJsonRequestBody } from "./read-request-body";
import { ClaimConsentRequestSchema } from "./schemas";
import type { WorkOsAccessTokenVerifier } from "./workos-access-token";

interface ConsentRouteDeps {
  claim: ClaimDeps;
  workosAccessTokens?: WorkOsAccessTokenVerifier;
}

export async function handleConsent(
  deps: ConsentRouteDeps,
  request: Request,
  attemptId: string,
  nowSeconds: () => number,
): Promise<Response> {
  if (!deps.workosAccessTokens) {
    return renderOAuthError(
      new OAuthError("server_error", "WorkOS consent verifier is unavailable"),
    );
  }
  const token = bearerToken(request.headers.get("authorization"));
  if (!token)
    return renderOAuthError(new OAuthError("invalid_token", "missing WorkOS access token"));
  try {
    const principal = await deps.workosAccessTokens.verify(token, nowSeconds());
    const decision = await consentDecision(request);
    if (decision === "deny") {
      await refuseClaimConsent(deps.claim, attemptId, principal.userId);
    } else {
      await approveClaimConsent(deps.claim, attemptId, principal.userId);
    }
    return new Response(null, { status: 204 });
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

function bearerToken(value: string | null) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

async function consentDecision(request: Request): Promise<"approve" | "deny"> {
  const json = await readJsonRequestBody(request);
  if (!json.ok) {
    throw new OAuthError(
      "invalid_request",
      json.reason === "too_large" ? "request body is too large" : "unsupported content type",
    );
  }
  if (json.value === undefined) throw new OAuthError("invalid_request", "missing consent decision");
  const parsed = ClaimConsentRequestSchema.safeParse(json.value);
  if (!parsed.success) throw new OAuthError("invalid_request", "malformed consent decision");
  return parsed.data.decision;
}
