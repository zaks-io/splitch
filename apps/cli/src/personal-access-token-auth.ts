import { isPersonalAccessTokenSecret } from "@splitch/sdk/control-plane";
import { SplitchCliError } from "./errors.js";
import { redactPersonalAccessTokenSecrets } from "./personal-access-token-redaction.js";

interface TokenEnvironment {
  readonly env?: Record<string, string | undefined>;
}

/** Presence selects token mode, including an empty value. Never trim a credential. */
export function personalAccessTokenFromEnv(deps: TokenEnvironment): string | undefined {
  return (deps.env ?? process.env).SPLITCH_TOKEN;
}

export function personalAccessTokenAuthorization(secret: string): string {
  if (secret.length !== 72 || !isPersonalAccessTokenSecret(secret)) {
    throw invalidPersonalAccessTokenError("SPLITCH_TOKEN is empty or malformed");
  }
  return `Bearer ${secret}`;
}

export function refuseTokenModeSessionCommand(deps: TokenEnvironment, command: string): void {
  if (personalAccessTokenFromEnv(deps) === undefined) return;
  throw new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `${command} is unavailable while SPLITCH_TOKEN is set`,
    remediation: `Unset SPLITCH_TOKEN before running ${command}`,
  });
}

export function invalidPersonalAccessTokenError(
  causeSummary = "The Control Plane refused the Personal Access Token in SPLITCH_TOKEN",
): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_TOKEN_INVALID",
    causeSummary,
    remediation:
      "Set SPLITCH_TOKEN to a valid, active Personal Access Token, or unset SPLITCH_TOKEN and run splitch login",
  });
}

/** Map status before SDK body parsing so even an unstructured 401 is an auth failure. */
export function personalAccessTokenFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      throw new SplitchCliError({
        code: "CLI_UNEXPECTED_ERROR",
        causeSummary: redactPersonalAccessTokenSecrets(
          error instanceof Error ? error.message : String(error),
        ),
        remediation: "Check the Control Plane connection and retry the command",
      });
    }
    if (response.status === 401) throw invalidPersonalAccessTokenError();
    if (await isRevokedTokenResponse(response)) throw invalidPersonalAccessTokenError();
    return response;
  };
}

async function isRevokedTokenResponse(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return !!body && typeof body === "object" && "code" in body && body.code === "CREDENTIAL_REVOKED";
}
