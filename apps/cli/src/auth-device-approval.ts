import open from "open";
import { SplitchCliError } from "./errors.js";

interface DeviceApproval {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  authBaseUrl: string;
  requireHttps: boolean;
}

export async function openDeviceApproval(approval: DeviceApproval): Promise<void> {
  const verificationUri = requireVerificationUrl(
    approval.verificationUri,
    "verification_uri",
    approval.authBaseUrl,
    approval.requireHttps,
  );
  const verificationUrl =
    approval.verificationUriComplete === undefined
      ? verificationUri
      : requireVerificationUrl(
          approval.verificationUriComplete,
          "verification_uri_complete",
          approval.authBaseUrl,
          approval.requireHttps,
        );

  console.error(`Opening ${verificationUrl} in your browser.`);
  console.error(
    `If it does not open, visit ${verificationUri} and enter code ${approval.userCode}.`,
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
 * Device-approval URLs must stay on the configured Auth origin. Foreign hosts,
 * userinfo credentials, port changes, and HTTP on hosted targets are rejected
 * before anything is printed or opened.
 */
export function requireVerificationUrl(
  value: string,
  field: string,
  authBaseUrl: string,
  requireHttps: boolean,
): string {
  try {
    const url = new URL(value);
    const authOrigin = new URL(authBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error("credential-bearing url");
    }
    if (requireHttps && url.protocol !== "https:") {
      throw new Error("hosted target requires https");
    }
    if (url.origin !== authOrigin.origin) {
      throw new Error("foreign origin");
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
