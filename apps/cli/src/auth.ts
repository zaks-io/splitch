import type { CliCredentialFile, CredentialStore } from "./credentials.js";
import { isAccessTokenExpired } from "./credentials.js";
import { resolveAuthBaseUrl, type SdkFactoryOptions } from "./sdks.js";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT = "refresh_token";
const CLI_CLIENT_ID = "splitch-cli";

export interface AuthSession {
  readonly authorization: string;
  readonly principal: CliCredentialFile["principal"];
}

export interface AuthDeps extends SdkFactoryOptions {
  readonly credentialStore: CredentialStore;
  readonly fetch?: typeof fetch;
}

export async function loginWithDeviceFlow(deps: AuthDeps, appId: string): Promise<AuthSession> {
  const fetchImpl = deps.fetch ?? fetch;
  const authBaseUrl = resolveAuthBaseUrl(deps);
  const auth = await formPost(fetchImpl, `${authBaseUrl}/oauth2/device_authorization`, {
    client_id: CLI_CLIENT_ID,
    scope: selectedAppScope(appId),
  });
  if (!auth.ok) {
    throw new Error(`splitch login: device authorization failed (${auth.status})`);
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
    selectedAppScope(appId),
    intervalMs,
    maxAttempts,
  );
  const file = buildCredentialFile(tokenBody);
  await deps.credentialStore.save(file);
  return {
    authorization: `Bearer ${file.credential.accessToken}`,
    principal: file.principal,
  };
}

async function pollDeviceApproval(
  fetchImpl: typeof fetch,
  authBaseUrl: string,
  deviceCode: string,
  scope: string,
  intervalMs: number,
  maxAttempts: number,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user_id?: string;
  email?: string;
}> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(intervalMs);
    const token = await formPost(fetchImpl, `${authBaseUrl}/oauth2/token`, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: CLI_CLIENT_ID,
      scope,
    });
    if (token.status === 200) {
      return (await token.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in?: number;
        user_id?: string;
        email?: string;
      };
    }
    const pending = (await token.json()) as { error?: string };
    if (pending.error !== "authorization_pending" && pending.error !== "slow_down") {
      throw new Error(`splitch login: token exchange failed (${pending.error ?? token.status})`);
    }
  }
  throw new Error("splitch login: timed out waiting for device approval");
}

function selectedAppScope(appId: string): string {
  return `app:${appId}:owner`;
}

function buildCredentialFile(body: {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user_id?: string;
  email?: string;
}): CliCredentialFile {
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

async function loadAuthorization(
  deps: AuthDeps,
  options: { readonly allowMissing?: boolean } = {},
): Promise<AuthSession | null> {
  const stored = await deps.credentialStore.load();
  if (!stored) {
    if (options.allowMissing) {
      return null;
    }
    throw new Error("splitch: not logged in — run `splitch login`");
  }
  if (!isAccessTokenExpired(stored.credential.accessTokenExpiresAt)) {
    return {
      authorization: `Bearer ${stored.credential.accessToken}`,
      principal: stored.principal,
    };
  }
  const refreshed = await refreshAccessToken(deps, stored);
  return {
    authorization: `Bearer ${refreshed.credential.accessToken}`,
    principal: refreshed.principal,
  };
}

export async function withAuthorizationRetry<T>(
  deps: AuthDeps,
  run: (authorization: string) => Promise<{ status: number; value: T }>,
): Promise<T> {
  const session = await loadAuthorization(deps);
  if (!session) {
    throw new Error("splitch: not logged in — run `splitch login`");
  }
  const first = await run(session.authorization);
  if (first.status !== 401) {
    return first.value;
  }
  const stored = await deps.credentialStore.load();
  if (!stored) {
    throw new Error("splitch: session expired — run `splitch login`");
  }
  const refreshed = await refreshAccessToken(deps, stored);
  const retry = await run(`Bearer ${refreshed.credential.accessToken}`);
  if (retry.status === 401) {
    throw new Error("splitch: session expired — run `splitch login`");
  }
  return retry.value;
}

async function refreshAccessToken(
  deps: AuthDeps,
  stored: CliCredentialFile,
): Promise<CliCredentialFile> {
  const fetchImpl = deps.fetch ?? fetch;
  const authBaseUrl = resolveAuthBaseUrl(deps);
  const response = await formPost(fetchImpl, `${authBaseUrl}/oauth2/token`, {
    grant_type: REFRESH_GRANT,
    refresh_token: stored.credential.refreshToken,
    client_id: CLI_CLIENT_ID,
  });
  if (!response.ok) {
    throw new Error("splitch: session expired — run `splitch login`");
  }
  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const next: CliCredentialFile = {
    ...stored,
    credential: {
      ...stored.credential,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? stored.credential.refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
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
