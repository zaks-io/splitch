import {
  accessTokenAuthorizationFromClaim,
  type ControlPlaneOperationResult,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  PERSONAL_ACCESS_TOKEN_AUTHORIZATION_HEADER,
  type PersonalAccessToken,
  PersonalAccessTokenGrantsSchema,
  type PersonalAccessTokenStepUpInput,
  personalAccessTokenNeedsStepUp,
} from "@splitch/sdk/control-plane";
import { withAuthorizationRetry } from "./auth.js";
import { requestDeviceApproval } from "./auth-device-approval.js";
import { SplitchCliError } from "./errors.js";
import type { CliDeps } from "./execute-types.js";
import { redactPersonalAccessTokenSecrets } from "./personal-access-token-redaction.js";
import { createOperationSdks, type OperationSdk } from "./sdks.js";

const MUTATIONS = {
  personal_access_tokens_create: "create",
  personal_access_tokens_update: "update",
  personal_access_tokens_rotate: "rotate",
} as const;

export function isPersonalAccessTokenMutation(operationId: string): boolean {
  return Object.hasOwn(MUTATIONS, operationId);
}

/** The ordinary session remains the actor; approval authorizes this one mutation. */
export async function callPersonalAccessTokenMutation(
  operationId: string,
  input: Record<string, unknown>,
  authorization: string,
  deps: CliDeps,
): Promise<ControlPlaneOperationResult> {
  const operation = MUTATIONS[operationId as keyof typeof MUTATIONS];
  const sdk = createOperationSdks(deps)["control-plane-api"];
  const current =
    operation === "create" ? undefined : await readCurrentToken(sdk, input, authorization);
  if (current && "failure" in current) return current.failure;
  const claims = sessionAuthority(authorization);
  const policy: PersonalAccessTokenStepUpInput = {
    operation,
    ...requestedAuthority(input),
    current,
    scopes: claims.scopes,
    authorization: accessTokenAuthorizationFromClaim(claims.authorization),
  };
  if (!personalAccessTokenNeedsStepUp(policy)) {
    return sdk.callOperationById(operationId, input, { authorization });
  }
  const mapped = await organizationApps(policy, authorization, deps);
  if ("failure" in mapped) return mapped.failure;
  if (!personalAccessTokenNeedsStepUp({ ...policy, apps: mapped.apps })) {
    return sdk.callOperationById(operationId, input, { authorization });
  }
  return callWithStepUp(operationId, input, authorization, deps);
}

type OrganizationAppsResult =
  | { apps: NonNullable<PersonalAccessTokenStepUpInput["apps"]> }
  | { failure: ControlPlaneOperationResult };

async function organizationApps(
  policy: PersonalAccessTokenStepUpInput,
  authorization: string,
  deps: CliDeps,
): Promise<OrganizationAppsResult> {
  const appIds = appOrganizationLookups(policy);
  const read = async (
    readAuthorization: string,
  ): Promise<{ status: number; value: OrganizationAppsResult }> => {
    const apps: { id: string; organizationId: string }[] = [];
    for (const appId of appIds) {
      const result = await createOperationSdks(deps)["control-plane-api"].callOperationById(
        "apps_get",
        { appId },
        { authorization: readAuthorization },
      );
      if (!result.ok) return { status: result.status, value: { failure: result } };
      apps.push(result.data as { id: string; organizationId: string });
    }
    return { status: 200, value: { apps } };
  };
  // Rebinding reads must not change the token used to decide or execute the mutation.
  const originalCanRead = appIds.every((appId) =>
    policy.scopes.some((scope) => scope.startsWith(`app:${appId}:`)),
  );
  return originalCanRead
    ? (await read(authorization)).value
    : withAuthorizationRetry(deps, read, { kind: MEMBERSHIP_WIDE_READ_AUTHORIZATION });
}

function appOrganizationLookups(policy: PersonalAccessTokenStepUpInput): string[] {
  const grants = policy.grants ?? policy.current?.grants ?? [];
  if (!grants.some((grant) => grant.target.startsWith("app:"))) return [];
  const expiry = policy.expiresAt === undefined ? policy.current?.expiresAt : policy.expiresAt;
  if (
    policy.operation !== "update" &&
    (expiry === null || grants.some((grant) => grant.target === "all"))
  ) {
    return [];
  }
  if (organizationCandidates(policy).length === 0) return [];
  // A bounded Organization catalog cannot establish coverage for an omitted App.
  return [
    ...new Set(
      grants
        .filter((grant) => grant.target.startsWith("app:"))
        .map((grant) => grant.target.slice(4)),
    ),
  ];
}

function organizationCandidates(policy: PersonalAccessTokenStepUpInput): string[] {
  const orgIds = new Set<string>();
  for (const scope of policy.scopes) {
    const org = /^org:([^:]+):(member|admin|owner)$/.exec(scope);
    if (org?.[1]) orgIds.add(org[1]);
  }
  for (const grant of policy.current?.grants ?? []) {
    if (grant.target.startsWith("org:")) orgIds.add(grant.target.slice(4));
  }
  return [...orgIds];
}

async function readCurrentToken(
  sdk: OperationSdk,
  input: Record<string, unknown>,
  authorization: string,
): Promise<PersonalAccessToken | { failure: ControlPlaneOperationResult }> {
  const listed = await sdk.callOperationById("personal_access_tokens_list", {}, { authorization });
  if (!listed.ok) return { failure: listed };
  const page = listed.data as { items: PersonalAccessToken[]; readTruncated: boolean };
  const current = page.items.find((token) => token.id === input.tokenId);
  if (current) return current;
  throw new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: page.readTruncated
      ? "The token list was truncated before the requested token could be found"
      : "The requested Personal Access Token was not found in your token list",
    remediation: "Run splitch tokens list and select a listed token before retrying",
  });
}

function requestedAuthority(
  input: Record<string, unknown>,
): Pick<PersonalAccessTokenStepUpInput, "grants" | "expiresAt"> {
  const grants =
    input.grants === undefined
      ? undefined
      : PersonalAccessTokenGrantsSchema.safeParse(input.grants);
  if (grants && !grants.success) throw invalidAuthority();
  if (
    input.expiresAt !== undefined &&
    input.expiresAt !== null &&
    typeof input.expiresAt !== "string"
  ) {
    throw invalidAuthority();
  }
  return {
    ...(grants?.success ? { grants: grants.data } : {}),
    expiresAt: input.expiresAt as string | null | undefined,
  };
}

async function callWithStepUp(
  operationId: string,
  input: Record<string, unknown>,
  authorization: string,
  deps: CliDeps,
): Promise<ControlPlaneOperationResult> {
  let stepUp: string | undefined;
  try {
    const approved = await requestDeviceApproval(deps, { authorization: "pat-management" });
    if (typeof approved.access_token !== "string" || approved.access_token.length === 0) {
      throw new Error("The browser approval response carried no step-up access token");
    }
    stepUp = approved.access_token;
    const fetchImpl = deps.fetch ?? fetch;
    const approvedSdk = createOperationSdks({
      ...deps,
      fetch: approvedFetch(fetchImpl, stepUp),
    })["control-plane-api"];
    return await approvedSdk.callOperationById(operationId, input, { authorization });
  } catch (error) {
    throw approvalFailure(error, stepUp);
  } finally {
    stepUp = undefined;
  }
}

function approvalFailure(error: unknown, stepUp?: string): SplitchCliError {
  const message = error instanceof Error ? error.message : String(error);
  return new SplitchCliError({
    code: error instanceof SplitchCliError ? error.code : "CLI_UNEXPECTED_ERROR",
    causeSummary: redactPersonalAccessTokenSecrets(
      stepUp ? message.replaceAll(stepUp, "[REDACTED]") : message,
    ),
    remediation: "Rerun the same splitch tokens command and approve it in the browser",
  });
}

function approvedFetch(fetchImpl: typeof fetch, stepUp: string): typeof fetch {
  return async (request, init) => {
    const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
    headers.set(PERSONAL_ACCESS_TOKEN_AUTHORIZATION_HEADER, stepUp);
    const response = await fetchImpl(new Request(request, { ...init, headers }));
    // A hostile error response must not turn the single-use credential into output.
    const text = (await response.text()).replaceAll(stepUp, "[REDACTED]");
    return new Response(text, { status: response.status, headers: response.headers });
  };
}

/** Decoding only selects a prompt. The server independently verifies both JWTs. */
function sessionAuthority(authorization: string): { scopes: string[]; authorization?: unknown } {
  try {
    const payload = authorization.replace(/^Bearer /, "").split(".")[1];
    if (!payload) return { scopes: [] };
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || !("scopes" in claims)) return { scopes: [] };
    if (
      !Array.isArray(claims.scopes) ||
      !claims.scopes.every((scope) => typeof scope === "string")
    ) {
      return { scopes: [] };
    }
    return {
      scopes: claims.scopes,
      authorization: "authorization" in claims ? claims.authorization : undefined,
    };
  } catch {
    return { scopes: [] };
  }
}

function invalidAuthority(): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: "The requested Personal Access Token grants or expiry are invalid",
    remediation: "Check the grants and expiry with splitch tokens create --help before retrying",
  });
}
