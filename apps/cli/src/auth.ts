import {
  bindingKey,
  describeOAuthFault,
  deviceAuthorizationError,
  readOAuthFault,
  type TokenBinding,
} from "./auth-binding.js";
import { openDeviceApproval } from "./auth-device-approval.js";
import { ensurePrincipalEmail } from "./auth-email-backfill.js";
import {
  type AuthDeps,
  emailUnverifiedError,
  formPost,
  refreshAccessToken,
  sessionExpiredError,
} from "./auth-token.js";
import type { CliCredentialFile } from "./credentials.js";
import { isAccessTokenExpired } from "./credentials.js";
import { SplitchCliError } from "./errors.js";
import { authOriginRequiresHttps, resolveAuthBaseUrl } from "./sdks.js";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CLI_CLIENT_ID = "splitch-cli";

export interface AuthSession {
  readonly authorization: string;
  readonly principal: CliCredentialFile["principal"];
  readonly selectedAppId: string | null;
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
    authBaseUrl,
    requireHttps: authOriginRequiresHttps(deps),
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
    if (fault.error === "email_unverified") {
      throw emailUnverifiedError(fault.description);
    }
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
    throw emailUnverifiedError(
      "Device token response carried no verified email for the session principal",
    );
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
  // Refresh first when the principal lacks a real email so member-profile
  // backfill runs before any control-plane call (SPL-293). The command itself
  // only needs the credential; a swallowed unverified reason is `context`'s
  // concern, not this call's.
  const { session: stored } = await ensurePrincipalEmail(deps);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
