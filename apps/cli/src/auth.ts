import {
  bindingKey,
  bindingParams,
  deviceAuthorizationError,
  describeOAuthFault,
  readOAuthFault,
  type TokenBinding,
} from "./auth-binding.js";
import type { CliCredentialFile, CredentialStore } from "./credentials.js";
import { isAccessTokenExpired } from "./credentials.js";
import { resolveAuthBaseUrl, type SdkFactoryOptions } from "./sdks.js";
import { SplitchCliError } from "./errors.js";

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

  const verificationUrl = grant.verification_uri_complete ?? grant.verification_uri;
  console.error(`Open ${verificationUrl} and enter code ${grant.user_code}`);

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
  return {
    version: 1,
    principal: {
      userId: body.user_id ?? "unknown",
      email: body.email ?? "unknown",
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

export async function logout(deps: AuthDeps): Promise<void> {
  const stored = await deps.credentialStore.load();
  if (stored?.credential.type === "device_flow") {
    const fetchImpl = deps.fetch ?? fetch;
    const authBaseUrl = resolveAuthBaseUrl(deps);
    await formPost(fetchImpl, `${authBaseUrl}/oauth2/revoke`, {
      token: stored.credential.refreshToken,
      client_id: CLI_CLIENT_ID,
    });
  }
  await deps.credentialStore.clear();
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

async function refreshAccessToken(
  deps: AuthDeps,
  stored: CliCredentialFile,
  binding: TokenBinding | null,
  explicitBinding: boolean,
): Promise<CliCredentialFile> {
  const fetchImpl = deps.fetch ?? fetch;
  const authBaseUrl = resolveAuthBaseUrl(deps);
  const response = await formPost(fetchImpl, `${authBaseUrl}/oauth2/token`, {
    grant_type: REFRESH_GRANT,
    refresh_token: stored.credential.refreshToken,
    client_id: CLI_CLIENT_ID,
    ...(explicitBinding ? bindingParams(binding) : {}),
  });
  if (!response.ok) {
    throw sessionExpiredError(describeOAuthFault(await readOAuthFault(response)));
  }
  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    app_id?: string;
  };
  const mintedBinding = explicitBinding
    ? bindingKey(binding)
    : body.app_id
      ? `app:${body.app_id}`
      : "";
  const next: CliCredentialFile = {
    ...stored,
    credential: {
      ...stored.credential,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? stored.credential.refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      accessTokenBinding: mintedBinding,
      ...(body.app_id ? { selectedAppId: body.app_id } : {}),
    },
  };
  await deps.credentialStore.save(next);
  return next;
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
