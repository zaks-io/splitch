import open from "open";
import { SplitchCliError } from "./errors.js";

interface DeviceApproval {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
}

export async function openDeviceApproval(approval: DeviceApproval): Promise<void> {
  const verificationUri = requireVerificationUrl(approval.verificationUri, "verification_uri");
  const verificationUrl =
    approval.verificationUriComplete === undefined
      ? verificationUri
      : requireVerificationUrl(approval.verificationUriComplete, "verification_uri_complete");

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

function requireVerificationUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
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
