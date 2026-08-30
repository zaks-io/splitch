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
