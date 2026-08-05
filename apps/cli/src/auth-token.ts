import {
  bindingKey,
  bindingParams,
  describeOAuthFault,
  isTokenBindingRefusal,
  type OAuthFault,
  readOAuthFault,
  type TokenBinding,
} from "./auth-binding.js";
import type { CliCredentialFile, CredentialStore } from "./credentials.js";
import { SplitchCliError } from "./errors.js";
import { resolveAuthBaseUrl, type SdkFactoryOptions } from "./sdks.js";

const REFRESH_GRANT = "refresh_token";
const CLI_CLIENT_ID = "splitch-cli";

export interface AuthDeps extends SdkFactoryOptions {
  readonly credentialStore: CredentialStore;
  readonly fetch?: typeof fetch;
}

interface RefreshTokenBody {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  email?: string;
  app_id?: string;
}

export async function refreshAccessToken(
  deps: AuthDeps,
  stored: CliCredentialFile,
  binding: TokenBinding | null,
  explicitBinding: boolean,
  retryOnRotation = true,
): Promise<CliCredentialFile> {
  const response = await formPost(deps.fetch ?? fetch, `${resolveAuthBaseUrl(deps)}/oauth2/token`, {
    grant_type: REFRESH_GRANT,
    refresh_token: stored.credential.refreshToken,
    client_id: CLI_CLIENT_ID,
    ...(explicitBinding ? bindingParams(binding) : {}),
  });
  if (!response.ok) {
    return refreshAccessTokenFault(
      deps,
      stored,
      binding,
      explicitBinding,
      response,
      retryOnRotation,
    );
  }
  const next = mintedCredential(stored, (await response.json()) as RefreshTokenBody, {
    binding,
    explicitBinding,
  });
  await deps.credentialStore.save(next);
  return next;
}

async function refreshAccessTokenFault(
  deps: AuthDeps,
  stored: CliCredentialFile,
  binding: TokenBinding | null,
  explicitBinding: boolean,
  response: Response,
  retryOnRotation: boolean,
): Promise<CliCredentialFile> {
  const fault = await readOAuthFault(response);
  if (fault.error === "email_unverified") {
    // Auth-api rotates the provider token before the email gate and returns
    // the new refresh_token on the 403 — persist it so verify-then-retry
    // still holds a token WorkOS will honor.
    if (fault.refreshToken && fault.refreshToken !== stored.credential.refreshToken) {
      await deps.credentialStore.save({
        ...stored,
        credential: { ...stored.credential, refreshToken: fault.refreshToken },
      });
    }
    throw emailUnverifiedError(fault.description);
  }
  const rotated =
    retryOnRotation && fault.error === "invalid_grant"
      ? await reloadRotatedCredential(deps, stored)
      : null;
  if (!rotated) {
    throw mintFailureError(fault);
  }
  return refreshAccessToken(deps, rotated, binding, explicitBinding, false);
}

/**
 * Map a failed refresh-grant response to the cause the CLI has established.
 * An `invalid_grant` whose reason names a membership/selector refusal is
 * `CLI_TOKEN_BINDING_REFUSED`; only a dead or missing session (or opaque
 * fault) is `CLI_SESSION_EXPIRED`.
 */
export function mintFailureError(fault: OAuthFault): SplitchCliError {
  if (isTokenBindingRefusal(fault)) {
    return tokenBindingRefusedError(fault);
  }
  return sessionExpiredError(describeOAuthFault(fault));
}

export async function formPost(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

export function notAuthenticatedError(): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_NOT_AUTHENTICATED",
    causeSummary: "No CLI login session is available",
    remediation: "Run splitch login before retrying the command",
  });
}

export function sessionExpiredError(detail: string): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_SESSION_EXPIRED",
    causeSummary: `The CLI login session could not mint a usable token: ${detail}`,
    remediation: "Run splitch login again before retrying the command",
  });
}

export function tokenBindingRefusedError(fault: OAuthFault): SplitchCliError {
  // Surface the server's own reason verbatim — never replace it with a session message.
  const reason = fault.description?.trim() || describeOAuthFault(fault);
  return new SplitchCliError({
    code: "CLI_TOKEN_BINDING_REFUSED",
    causeSummary: reason,
    remediation: tokenBindingRemediation(reason),
  });
}

/**
 * Membership refusals need a different next step from ambiguous-selector
 * refusals: the latter already has membership — only the canonical ID fixes it.
 */
function tokenBindingRemediation(reason: string): string {
  if (/matches more than one App/i.test(reason)) {
    return "Pass the canonical App ID instead of the ambiguous key";
  }
  if (/not (authorized|reachable) by live membership/i.test(reason)) {
    return "Run splitch use --app <other-app> (or pass --app) to select a reachable App, or restore membership for the selected resource";
  }
  return "Select an App or Organization your live membership authorizes, or restore membership for the selected resource";
}

export function emailUnverifiedError(detail: string | undefined): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_EMAIL_UNVERIFIED",
    causeSummary:
      detail && detail.length > 0
        ? detail
        : "The identity provider has not verified an email address for this account",
    remediation:
      "Verify your email address with the identity provider, then run splitch login again",
  });
}

/**
 * Refresh tokens are single-use, so a concurrent splitch process may have
 * rotated ours away between our load and this mint. If the file on disk now
 * holds a NEWER token, the session is alive and this mint deserves one retry.
 *
 * The principal must match: a concurrent `splitch login` that switched accounts
 * also leaves a different token on disk, and silently retrying with it would
 * run the command as someone else while the caller believes it is still theirs.
 */
async function reloadRotatedCredential(
  deps: AuthDeps,
  stored: CliCredentialFile,
): Promise<CliCredentialFile | null> {
  const latest = await deps.credentialStore.load();
  if (!latest || latest.credential.refreshToken === stored.credential.refreshToken) {
    return null;
  }
  return latest.principal.userId === stored.principal.userId ? latest : null;
}

function mintedCredential(
  stored: CliCredentialFile,
  body: RefreshTokenBody,
  mint: { binding: TokenBinding | null; explicitBinding: boolean },
): CliCredentialFile {
  // Label the token with what the server actually bound, not what we asked
  // for: a key selector ("checkout") resolves server-side to a canonical ID,
  // so labelling the request would make every later ID-keyed call re-mint.
  const mintedBinding = body.app_id
    ? `app:${body.app_id}`
    : mint.explicitBinding
      ? bindingKey(mint.binding)
      : "";
  // The session's App is its login-time identity. A per-command rebind must
  // not rewrite it, exactly as the server refuses to rewrite the session's
  // selectedAppSelector on a rebind mint.
  const selectedAppId = mint.explicitBinding ? stored.credential.selectedAppId : body.app_id;
  const email = mintEmail(body.email, stored.principal.email);
  const {
    emailBackfillUnavailable: _legacyUnavailable,
    emailBackfillUnavailableUntil: _previousUntil,
    ...credentialRest
  } = stored.credential;
  return {
    ...stored,
    principal: email
      ? { userId: stored.principal.userId, email }
      : { userId: stored.principal.userId },
    credential: {
      ...credentialRest,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? stored.credential.refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      accessTokenBinding: mintedBinding,
      ...(selectedAppId ? { selectedAppId } : {}),
    },
  };
}

function mintEmail(
  bodyEmail: string | undefined,
  storedEmail: string | undefined,
): string | undefined {
  if (typeof bodyEmail === "string" && bodyEmail.length > 0 && bodyEmail !== "unknown") {
    return bodyEmail;
  }
  if (typeof storedEmail === "string" && storedEmail.length > 0 && storedEmail !== "unknown") {
    return storedEmail;
  }
  return undefined;
}
