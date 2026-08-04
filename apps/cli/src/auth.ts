import {
  bindingKey,
  bindingParams,
  describeOAuthFault,
  deviceAuthorizationError,
  readOAuthFault,
  type TokenBinding,
} from "./auth-binding.js";
import { openDeviceApproval } from "./auth-device-approval.js";
import type { CliCredentialFile, CredentialStore } from "./credentials.js";
import { isAccessTokenExpired, principalNeedsEmailBackfill } from "./credentials.js";
import { SplitchCliError } from "./errors.js";
import { resolveAuthBaseUrl, type SdkFactoryOptions } from "./sdks.js";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT = "refresh_token";
const CLI_CLIENT_ID = "splitch-cli";

export interface AuthSession {
  readonly authorization: string;
  readonly principal: CliCredentialFile["principal"];
  readonly selectedAppId: string | null;
}

export interface AuthDeps extends SdkFactoryOptions {
  readonly credentialStore: CredentialStore;
  readonly fetch?: typeof fetch;
}

export async function loginWithDeviceFlow(
  deps: AuthDeps,
  appSelector: string | null,
): Promise<AuthSession> {
  const fetchImpl = deps.fetch ?? fetch;
  const authBaseUrl = resolveAuthBaseUrl(deps);
  const auth = await formPost(fetchImpl, `${authBaseUrl}/oauth2/device_authorization`, {
    client_id: CLI_CLIENT_ID,
    ...(appSelector ? { app: appSelector } : {}),
  });
  if (!auth.ok) {
    throw deviceAuthorizationError(await readOAuthFault(auth));
  }
  const grant = (await auth.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
  };

  await openDeviceApproval({
    verificationUri: grant.verification_uri,
    verificationUriComplete: grant.verification_uri_complete,
    userCode: grant.user_code,
  });

  const intervalMs = (grant.interval ?? 5) * 1000;
  const maxAttempts = 30;
  const tokenBody = await pollDeviceApproval(
    fetchImpl,
    authBaseUrl,
    grant.device_code,
    intervalMs,
    maxAttempts,
  );
  const file = buildCredentialFile(tokenBody);
  await deps.credentialStore.save(file);
  return {
    authorization: `Bearer ${file.credential.accessToken}`,
    principal: file.principal,
    selectedAppId: file.credential.selectedAppId ?? null,
  };
}

interface DeviceTokenBody {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user_id?: string;
  email?: string;
  app_id?: string;
}

async function pollDeviceApproval(
  fetchImpl: typeof fetch,
  authBaseUrl: string,
  deviceCode: string,
  intervalMs: number,
  maxAttempts: number,
): Promise<DeviceTokenBody> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(intervalMs);
    const token = await formPost(fetchImpl, `${authBaseUrl}/oauth2/token`, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: CLI_CLIENT_ID,
    });
    if (token.status === 200) {
      return (await token.json()) as DeviceTokenBody;
    }
    const fault = await readOAuthFault(token);
    if (fault.error !== "authorization_pending" && fault.error !== "slow_down") {
      throw new SplitchCliError({
        code: "CLI_DEVICE_TOKEN_EXCHANGE_FAILED",
        causeSummary: `Device token exchange failed with ${describeOAuthFault(fault)}`,
        remediation: "Restart splitch login and complete the new device authorization",
      });
    }
  }
  throw new SplitchCliError({
    code: "CLI_DEVICE_APPROVAL_TIMEOUT",
    causeSummary: "Device approval timed out",
    remediation: "Run splitch login again and approve the request before it expires",
  });
}

function buildCredentialFile(body: DeviceTokenBody): CliCredentialFile {
  if (!body.user_id) {
    // Storing a placeholder identity is worse than failing: every later command
    // reads this file, so an unnamed principal turns a broken token response
    // into a mystery three commands downstream.
    throw new SplitchCliError({
      code: "CLI_DEVICE_TOKEN_EXCHANGE_FAILED",
      causeSummary: "Device token response carried no user_id to identify the session",
      remediation:
        "Retry splitch login; if it repeats, the auth service is returning a bad token response",
    });
  }
  if (!body.email || body.email === "unknown") {
    throw new SplitchCliError({
      code: "CLI_DEVICE_TOKEN_EXCHANGE_FAILED",
      causeSummary: "Device token response carried no verified email for the session principal",
      remediation:
        "Retry splitch login; if it repeats, the auth service is returning a bad token response",
    });
  }
  return {
    version: 1,
    principal: {
      userId: body.user_id,
      email: body.email,
    },
    credential: {
      type: "device_flow",
      refreshToken: body.refresh_token,
      accessToken: body.access_token,
      accessTokenExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      accessTokenBinding: body.app_id ? `app:${body.app_id}` : "",
      ...(body.app_id ? { selectedAppId: body.app_id } : {}),
    },
  };
}

/**
 * Ensure the stored principal carries a real email. Sessions minted before the
 * auth-api identity-cache write (or files that still hold `"unknown"`) are
 * backfilled by one refresh grant — the same path that rewrites
 * member-profile:{userId} server-side.
 */
export async function ensurePrincipalEmail(deps: AuthDeps): Promise<CliCredentialFile> {
  const stored = await deps.credentialStore.load();
  if (!stored) {
    throw notAuthenticatedError();
  }
  if (!principalNeedsEmailBackfill(stored.principal)) {
    return stored;
  }
  return refreshAccessToken(deps, stored, null, false);
}

/**
 * Clear the local credential first, then fail loud if the server kept the
 * session: dropping the local file is what the caller asked for and must always
 * happen, but "logged out" while a live refresh session survives on the server
 * is exactly the silent half-failure the credential holder must not be told.
 */
export async function logout(deps: AuthDeps): Promise<void> {
  const stored = await deps.credentialStore.load();
  let revocation: Response | null = null;
  if (stored?.credential.type === "device_flow") {
    const fetchImpl = deps.fetch ?? fetch;
    const authBaseUrl = resolveAuthBaseUrl(deps);
    revocation = await formPost(fetchImpl, `${authBaseUrl}/oauth2/revoke`, {
      token: stored.credential.refreshToken,
      client_id: CLI_CLIENT_ID,
    });
  }
  await deps.credentialStore.clear();
  if (revocation && !revocation.ok) {
    throw new SplitchCliError({
      code: "CLI_LOGOUT_REVOKE_FAILED",
      causeSummary: `The local credential was removed but the server refused to revoke the session: ${describeOAuthFault(
        await readOAuthFault(revocation),
      )}`,
      remediation:
        "The refresh session may still be live; revoke it from the Control Panel or retry splitch logout",
    });
  }
}

/**
 * Run an authorized call with a token bound to `binding` (or the session's
 * default when no binding is named), minting through the refresh grant when
 * the stored token is expired or bound elsewhere. A 401 buys exactly one
 * fresh mint and retry before failing loud.
 */
export async function withAuthorizationRetry<T>(
  deps: AuthDeps,
  run: (authorization: string) => Promise<{ status: number; value: T }>,
  binding?: TokenBinding,
): Promise<T> {
  const stored = await deps.credentialStore.load();
  if (!stored) {
    throw notAuthenticatedError();
  }
  const usable = binding === undefined || storedBinding(stored) === bindingKey(binding);
  const current =
    usable && !isAccessTokenExpired(stored.credential.accessTokenExpiresAt)
      ? stored
      : await refreshAccessToken(deps, stored, binding ?? null, binding !== undefined);
  const first = await run(`Bearer ${current.credential.accessToken}`);
  if (first.status !== 401) {
    return first.value;
  }
  const latest = await deps.credentialStore.load();
  if (!latest) {
    throw sessionExpiredError("the stored credential disappeared");
  }
  const refreshed = await refreshAccessToken(deps, latest, binding ?? null, binding !== undefined);
  const retry = await run(`Bearer ${refreshed.credential.accessToken}`);
  if (retry.status === 401) {
    throw sessionExpiredError("the control plane rejected a freshly minted token");
  }
  return retry.value;
}

/**
 * Credential files written before rebinding existed carry no binding label;
 * their access token was always bound to the login-selected App.
 */
function storedBinding(stored: CliCredentialFile): string {
  return (
    stored.credential.accessTokenBinding ??
    (stored.credential.selectedAppId ? `app:${stored.credential.selectedAppId}` : "")
  );
}

interface RefreshTokenBody {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  email?: string;
  app_id?: string;
}

async function refreshAccessToken(
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
  const email =
    typeof body.email === "string" && body.email.length > 0 && body.email !== "unknown"
      ? body.email
      : stored.principal.email;
  return {
    ...stored,
    principal: email
      ? { userId: stored.principal.userId, email }
      : { userId: stored.principal.userId },
    credential: {
      ...stored.credential,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? stored.credential.refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      accessTokenBinding: mintedBinding,
      ...(selectedAppId ? { selectedAppId } : {}),
    },
  };
}

async function formPost(
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function notAuthenticatedError(): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_NOT_AUTHENTICATED",
    causeSummary: "No CLI login session is available",
    remediation: "Run splitch login before retrying the command",
  });
}

function sessionExpiredError(detail: string): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_SESSION_EXPIRED",
    causeSummary: `The CLI login session could not mint a usable token: ${detail}`,
    remediation: "Run splitch login again before retrying the command",
  });
}
