import { SplitchSdkError } from "./errors";

type CredentialOption = "clientKey" | "apiKey";

const expectedPrefixes: Record<CredentialOption, string> = {
  clientKey: "pk_",
  apiKey: "sk_",
};

export function requireCredentialPrefix(credential: string, option: CredentialOption): string {
  const expectedPrefix = expectedPrefixes[option];
  if (!credential.startsWith(expectedPrefix)) {
    throw new SplitchSdkError({
      code: "SDK_CREDENTIAL_CONFIGURATION_INVALID",
      causeSummary: `${option} requires credential material starting with ${expectedPrefix}`,
      remediation:
        option === "clientKey"
          ? "Pass the pk_… key material from `splitch client-key get`"
          : "Pass secret API Key material starting with sk_ and keep it on the server",
    });
  }
  return credential;
}
