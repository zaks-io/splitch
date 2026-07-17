export interface ClaimCeremonyRequest {
  identityAssertion: string;
  email: string;
  otp?: string;
  idempotencyKey?: string;
}

export interface ClaimInitiated {
  otpRequired: true;
  userId: string;
  orgId: string;
}

export interface ClaimCompleted {
  accessToken: string;
  userId: string;
  orgId: string;
  appId: string;
}

export interface ClaimActor {
  userId: string;
  orgId: string;
}

export class ClaimCeremonyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly consentUrl?: string,
    readonly consentExpiresAt?: string,
  ) {
    super(message);
    this.name = "ClaimCeremonyError";
  }
}

export async function postClaimCeremony(
  origin: string,
  request: ClaimCeremonyRequest,
  requestFn: typeof fetch = fetch,
): Promise<ClaimInitiated | ClaimCompleted> {
  const response = await requestFn(new URL("/claim", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identity_assertion: request.identityAssertion,
      email: request.email,
      otp: request.otp,
      idempotency_key: request.idempotencyKey,
    }),
  });
  const body = await readBody(response);

  if (!response.ok) {
    throw errorFromBody(body, response.status);
  }
  if (isClaimInitiated(body)) {
    return { otpRequired: true, userId: body.user_id, orgId: body.org_id };
  }
  if (isClaimCompleted(body)) {
    return {
      accessToken: body.access_token,
      userId: body.user_id,
      orgId: body.org_id,
      appId: body.app_id,
    };
  }
  throw new ClaimCeremonyError("server_error", "Auth API returned an invalid claim response");
}

/**
 * Bind every Door B response to the panel session before it can advance the
 * ceremony. The Worker remains authoritative for the assertion itself; the
 * panel must never let an assertion for another member reach the verify step.
 */
export function assertClaimActor<T extends ClaimInitiated | ClaimCompleted>(
  response: T,
  actor: ClaimActor,
): T {
  if (response.userId !== actor.userId || response.orgId !== actor.orgId) {
    throw new ClaimCeremonyError(
      "invalid_grant",
      "The claim identity does not match this Organization member.",
    );
  }
  return response;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function errorFromBody(body: unknown, status: number): ClaimCeremonyError {
  if (
    isRecord(body) &&
    typeof body.error === "string" &&
    typeof body.error_description === "string"
  ) {
    return new ClaimCeremonyError(
      body.error,
      body.error_description,
      stringOrUndefined(body.consent_url),
      stringOrUndefined(body.consent_expires_at),
    );
  }
  return new ClaimCeremonyError("server_error", `Auth API claim request failed (${status})`);
}

function isClaimInitiated(value: unknown): value is {
  otp_required: true;
  user_id: string;
  org_id: string;
} {
  return (
    isRecord(value) &&
    value.otp_required === true &&
    typeof value.user_id === "string" &&
    typeof value.org_id === "string"
  );
}

function isClaimCompleted(value: unknown): value is {
  access_token: string;
  user_id: string;
  org_id: string;
  app_id: string;
} {
  return (
    isRecord(value) &&
    typeof value.access_token === "string" &&
    typeof value.user_id === "string" &&
    typeof value.org_id === "string" &&
    typeof value.app_id === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
