import { SplitchCliError } from "./errors.js";

/**
 * The resource a minted access token is bound to. One human approval mints a
 * durable session; each CLI invocation rebinds an access token to the App or
 * Organization its command targets via the refresh grant. No binding at all
 * ("" key) is the cold-start shape used by `orgs list` / `orgs create`.
 */
export interface TokenBinding {
  readonly kind: "app" | "org";
  readonly selector: string;
}

export function bindingKey(binding: TokenBinding | null): string {
  return binding ? `${binding.kind}:${binding.selector}` : "";
}

export function bindingParams(binding: TokenBinding | null): Record<string, string> {
  return binding ? { [binding.kind]: binding.selector } : {};
}

interface OAuthFault {
  readonly status: number;
  readonly error?: string;
  readonly description?: string;
}

/**
 * Read the OAuth error body off a failed auth response. The body is the
 * diagnosis ("invalid_client: Unknown client."), so an auth failure that
 * reports only an HTTP status is a fail-loud violation — never discard it.
 */
export async function readOAuthFault(response: Response): Promise<OAuthFault> {
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: unknown };
    return {
      status: response.status,
      error: typeof body.error === "string" ? body.error : undefined,
      description: typeof body.error_description === "string" ? body.error_description : undefined,
    };
  } catch {
    return { status: response.status };
  }
}

export function describeOAuthFault(fault: OAuthFault): string {
  const parts = [`HTTP ${fault.status}`];
  if (fault.error) parts.push(fault.error);
  if (fault.description) parts.push(fault.description);
  return parts.join(": ");
}

export function deviceAuthorizationError(fault: OAuthFault): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_DEVICE_AUTHORIZATION_FAILED",
    causeSummary: `Device authorization failed with ${describeOAuthFault(fault)}`,
    remediation: "Check the auth service response above, then run splitch login again",
  });
}
