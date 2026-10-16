import open from "open";
import {
  describeOAuthFault,
  deviceAuthorizationError,
  type OAuthFault,
  readOAuthFault,
} from "./auth-binding.js";
import { type AuthDeps, emailUnverifiedError, formPost } from "./auth-token.js";
import { SplitchCliError } from "./errors.js";
import { redactPersonalAccessTokenSecrets } from "./personal-access-token-redaction.js";
import { authOriginRequiresHttps, resolveAuthBaseUrl } from "./sdks.js";

const CLI_CLIENT_ID = "splitch-cli";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceTokenBody {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: string;
  email?: string;
  app_id?: string;
}

/** Step-up approval uses this exchange without saving its response as a session. */
export async function requestDeviceApproval(
  deps: AuthDeps,
  options: { app?: string; authorization?: "pat-management" } = {},
): Promise<DeviceTokenBody> {
  const fetchImpl = deps.fetch ?? fetch;
  const authBaseUrl = resolveAuthBaseUrl(deps);
  const auth = await formPost(fetchImpl, `${authBaseUrl}/oauth2/device_authorization`, {
    client_id: CLI_CLIENT_ID,
    ...options,
  });
  if (!auth.ok) throw deviceAuthorizationError(await readOAuthFault(auth));
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
  return pollDeviceApproval(deps, authBaseUrl, grant, options.authorization);
}

async function pollDeviceApproval(
  deps: AuthDeps,
  authBaseUrl: string,
  grant: { device_code: string; interval?: number },
  authorization?: "pat-management",
): Promise<DeviceTokenBody> {
  const fetchImpl = deps.fetch ?? fetch;
  const pause = deps.sleep ?? sleep;
  const intervalMs = (grant.interval ?? 5) * 1000;
  const body = {
    grant_type: DEVICE_CODE_GRANT,
    device_code: grant.device_code,
    client_id: CLI_CLIENT_ID,
    ...(authorization ? { authorization } : {}),
  };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await pause(intervalMs);
    const token = await formPost(fetchImpl, `${authBaseUrl}/oauth2/token`, body);
    if (token.status === 200) return (await token.json()) as DeviceTokenBody;
    rejectDeviceTokenFault(await readOAuthFault(token), authorization);
  }
  throw new SplitchCliError({
    code: "CLI_DEVICE_APPROVAL_TIMEOUT",
    causeSummary: "Device approval timed out",
    remediation: approvalRemediation(authorization),
  });
}

function rejectDeviceTokenFault(fault: OAuthFault, authorization?: "pat-management"): void {
  if (fault.error === "email_unverified") throw emailUnverifiedError(fault.description);
  if (fault.error === "authorization_pending" || fault.error === "slow_down") return;
  throw new SplitchCliError({
    code: "CLI_DEVICE_TOKEN_EXCHANGE_FAILED",
    causeSummary: `Device token exchange failed with ${describeOAuthFault(fault)}`,
    remediation: approvalRemediation(authorization),
  });
}

function approvalRemediation(authorization?: "pat-management"): string {
  return authorization
    ? "Rerun the same splitch tokens command and approve the request in the browser"
    : "Run splitch login again and approve the request before it expires";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DeviceApproval {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  authBaseUrl: string;
  requireHttps: boolean;
}

async function openDeviceApproval(approval: DeviceApproval): Promise<void> {
  const verificationUri = requireVerificationUrl(
    approval.verificationUri,
    "verification_uri",
    approval.requireHttps,
    approval.requireHttps ? undefined : new URL(approval.authBaseUrl).origin,
  );
  const verificationUrl =
    approval.verificationUriComplete === undefined
      ? verificationUri
      : requireVerificationUrl(
          approval.verificationUriComplete,
          "verification_uri_complete",
          approval.requireHttps,
          new URL(verificationUri).origin,
        );

  console.error(redactPersonalAccessTokenSecrets(`Opening ${verificationUrl} in your browser.`));
  console.error(
    redactPersonalAccessTokenSecrets(
      `If it does not open, visit ${verificationUri} and enter code ${approval.userCode}.`,
    ),
  );

  try {
    await open(verificationUrl);
  } catch {
    console.error(
      "Could not open the browser automatically. Continue with the URL and code above.",
    );
  }
}

/**
 * WorkOS hosts device approval on the configured AuthKit domain, not the
 * splitch Auth API origin. The base URL comes from the trusted authorization
 * response; the complete URL must remain on that same origin.
 */
export function requireVerificationUrl(
  value: string,
  field: string,
  requireHttps: boolean,
  expectedOrigin?: string,
): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error("credential-bearing url");
    }
    if (requireHttps && url.protocol !== "https:") {
      throw new Error("hosted target requires https");
    }
    if (expectedOrigin !== undefined && url.origin !== expectedOrigin) {
      throw new Error("unexpected origin");
    }
    return url.href;
  } catch {
    throw new SplitchCliError({
      code: "CLI_DEVICE_AUTHORIZATION_FAILED",
      causeSummary: `Device authorization returned an invalid ${field}`,
      remediation: "Check the auth service response, then run splitch login again",
    });
  }
}
