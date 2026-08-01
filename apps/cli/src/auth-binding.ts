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
      error: readFaultText(body.error),
      description: readFaultText(body.error_description),
    };
  } catch {
    return { status: response.status };
  }
}

/**
 * OAuth fault text is remote input printed straight to a terminal. Strip the
 * C0/C1 control range so a hostile or misconfigured auth origin cannot use
 * escape sequences to rewrite the line and disguise the failure.
 */
function readFaultText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return clean.slice(0, 300) || undefined;
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
