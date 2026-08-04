import {
  bindingKey,
  bindingParams,
  describeOAuthFault,
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
    const fault = await readOAuthFault(response);
    if (fault.error === "email_unverified") {
      throw emailUnverifiedError(fault.description);
    }
    const rotated =
      retryOnRotation && fault.error === "invalid_grant"
        ? await reloadRotatedCredential(deps, stored)
        : null;
    if (!rotated) {
      throw sessionExpiredError(describeOAuthFault(fault));
    }
    return refreshAccessToken(deps, rotated, binding, explicitBinding, false);
  }
  const next = mintedCredential(stored, (await response.json()) as RefreshTokenBody, {
    binding,
    explicitBinding,
  });
  await deps.credentialStore.save(next);
  return next;
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
  const mintedBinding = body.app_id
    ? `app:${body.app_id}`
    : mint.explicitBinding
      ? bindingKey(mint.binding)
      : "";
  const selectedAppId = mint.explicitBinding ? stored.credential.selectedAppId : body.app_id;
  const email = mintEmail(body.email, stored.principal.email);
  const { emailBackfillUnavailable, ...credentialRest } = stored.credential;
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
      ...(!email && emailBackfillUnavailable ? { emailBackfillUnavailable: true } : {}),
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
