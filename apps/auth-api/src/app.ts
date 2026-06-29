import type { Repository } from "@splitch/db";
import { Hono } from "hono";
import { verifyAccessToken } from "./access-token.js";
import { type ClaimDeps, initiateClaim, verifyClaim } from "./claim.js";
import { type IdJagDeps, verifyIdJag } from "./idjag-verify.js";
import { OAuthError, renderOAuthError } from "./oauth-errors.js";
import { type RegisterDeps, registerAnonymous } from "./register.js";
import {
  AgentIdentityRequestSchema,
  AnonymousIdentityRequestSchema,
  ClaimRequestSchema,
  CreateTrustedIdpRequestSchema,
  TokenExchangeRequestSchema,
} from "./schemas.js";
import type { TokenSigner } from "./token-exchange.js";
import { makeTrustedIdpCrud } from "./trusted-idp-crud.js";

/**
 * Auth API Worker HTTP surface.
 *
 * WHY a focused Hono app and not the @splitch/worker-runtime registrar: the
 * door endpoints speak the OAuth/auth.md error namespace (lowercase `error`),
 * which is a SEPARATE shape from the registrar's ErrorResponse union. The
 * worker-runtime spec assigns the auth-api "token issuance, token revocation,
 * trusted IdP validation, provisional create" as Worker-local; that local logic
 * lives here. The trusted-IdP CRUD speaks the control-plane shape and does its
 * own Org-owner authz in the CRUD layer (single-sourced on D1 membership).
 */

const ACCESS_TOKEN_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

export interface AppDeps {
  idJag: IdJagDeps;
  tokenSigner: TokenSigner;
  repo: Repository;
  /** Door B anonymous register (Turnstile + rate ceiling + provisional create). */
  register: RegisterDeps;
  /** Door B claim ceremony (OTP, idempotency dedup, interaction_required). */
  claim: ClaimDeps;
  /** Secret the control-plane access token is signed with (distinct from the assertion secret). */
  accessSecret: string;
  /** Audience the access token must bind to (control-plane protected-resource origin). */
  controlPlaneAudience: string;
  now: () => number;
}

/** Default scopes for an ID-JAG-resolved identity assertion when none requested. */
function assertionScopes(requested: string[] | undefined): string[] {
  return requested ?? [];
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const crud = makeTrustedIdpCrud(deps.repo, deps.now);
  const nowSeconds = () => Math.floor(deps.now() / 1000);

  // --- Doors A + B: /agent/identity (presence of `id_jag` selects the door) ---
  app.post("/agent/identity", async (c) => {
    const body = await readJson(c.req.raw);
    // Door B: an anonymous body carries no `id_jag` (auth-doors.md). Route there
    // BEFORE the Door A schema so a missing id_jag is the anonymous flow, not a
    // malformed Door A request.
    if (isAnonymousBody(body)) {
      return handleAnonymousRegister(deps, c.req.raw, body);
    }
    const parsed = AgentIdentityRequestSchema.safeParse(body);
    if (!parsed.success) {
      return renderOAuthError(new OAuthError("invalid_request", "malformed /agent/identity body"));
    }
    try {
      const result = await verifyIdJag(deps.idJag, parsed.data.id_jag);
      const assertion = await deps.tokenSigner.mintIdentityAssertion(
        result.userId,
        assertionScopes(parsed.data.requested_scopes),
        nowSeconds(),
      );
      return Response.json({ identity_assertion: assertion, user_id: result.userId });
    } catch (cause) {
      return renderDoorFault(cause);
    }
  });

  // --- Door B: claim ceremony (agent endpoint + human-UI alias) ---------------
  const claimHandler = (c: { req: { raw: Request } }) => handleClaim(deps, c.req.raw);
  app.post("/agent/identity/claim", claimHandler);
  app.post("/claim", claimHandler);

  // GET /claim is the human-UI entry: it does not mutate, it points the browser at
  // the claim flow. Kept minimal here (the full UI is the frontend's job).
  app.get("/claim", (c) =>
    Response.json({
      message:
        "POST identity_assertion, otp, email, and idempotency_key to /claim to finish setup.",
      assertion_present: Boolean(new URL(c.req.raw.url).searchParams.get("identity_assertion")),
    }),
  );

  // --- /oauth2/token: exchange the assertion for a control-plane token --------
  app.post("/oauth2/token", async (c) => {
    const parsed = TokenExchangeRequestSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) {
      return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
    }
    if (parsed.data.grant_type !== ACCESS_TOKEN_GRANT) {
      return renderOAuthError(
        new OAuthError(
          "unsupported_grant_type",
          `grant_type "${parsed.data.grant_type}" not supported`,
        ),
      );
    }
    try {
      const accessToken = await deps.tokenSigner.exchangeForAccessToken(
        parsed.data.identity_assertion,
        nowSeconds(),
      );
      return Response.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
    } catch (cause) {
      return renderDoorFault(cause);
    }
  });

  // --- Trusted-IdP CRUD (Org owner only, control-plane shape) -----------------
  app.get("/orgs/:orgId/trusted-idps", async (c) =>
    withActor(c, deps, async (userId) => asResponse(await crud.list(c.req.param("orgId"), userId))),
  );

  app.post("/orgs/:orgId/trusted-idps", async (c) =>
    withActor(c, deps, async (userId) => {
      const parsed = CreateTrustedIdpRequestSchema.safeParse(await readJson(c.req.raw));
      if (!parsed.success) {
        return errorResponse(400, "VALIDATION_ERROR");
      }
      return asResponse(
        await crud.create(c.req.param("orgId"), userId, {
          issuer: parsed.data.issuer,
          jwksUri: parsed.data.jwks_uri,
          clientIds: parsed.data.client_ids,
          enabled: parsed.data.enabled,
        }),
        201,
      );
    }),
  );

  app.delete("/orgs/:orgId/trusted-idps/:idpId", async (c) =>
    withActor(c, deps, async (userId) =>
      asResponse(await crud.remove(c.req.param("orgId"), userId, c.req.param("idpId"))),
    ),
  );

  return app;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** A /agent/identity body is the anonymous (Door B) flow iff it has no `id_jag`. */
function isAnonymousBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && !("id_jag" in body);
}

/** Client IP at the Cloudflare edge; the rate ceiling keys on it (ADR-0034). */
function clientIp(request: Request): string | undefined {
  return request.headers.get("cf-connecting-ip") ?? undefined;
}

/** Door B register: validate the anon body, run the ceremony, map faults to OAuth. */
async function handleAnonymousRegister(
  deps: AppDeps,
  request: Request,
  body: unknown,
): Promise<Response> {
  const parsed = AnonymousIdentityRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(
      new OAuthError("invalid_request", "anonymous /agent/identity requires a turnstile_token"),
    );
  }
  try {
    const result = await registerAnonymous(deps.register, {
      turnstileToken: parsed.data.turnstile_token,
      remoteIp: clientIp(request),
    });
    return Response.json(result);
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

/**
 * Door B claim. The presence of `otp` selects the step: no otp → INITIATE (send a
 * code to the claimed email); otp → VERIFY (idempotency_key is then required).
 */
async function handleClaim(deps: AppDeps, request: Request): Promise<Response> {
  const parsed = ClaimRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /claim body"));
  }
  const remoteIp = clientIp(request);
  try {
    if (parsed.data.otp === undefined) {
      const result = await initiateClaim(deps.claim, {
        identityAssertion: parsed.data.identity_assertion,
        email: parsed.data.email,
        remoteIp,
      });
      return Response.json(result);
    }
    if (!parsed.data.idempotency_key) {
      return renderOAuthError(
        new OAuthError("invalid_request", "verify step requires an idempotency_key"),
      );
    }
    const result = await verifyClaim(deps.claim, {
      identityAssertion: parsed.data.identity_assertion,
      otp: parsed.data.otp,
      email: parsed.data.email,
      idempotencyKey: parsed.data.idempotency_key,
      remoteIp,
    });
    return Response.json(result);
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

/** Map any thrown door fault to its OAuth body; an unexpected throw is server_error. */
function renderDoorFault(cause: unknown): Response {
  if (cause instanceof OAuthError) {
    return renderOAuthError(cause);
  }
  return renderOAuthError(new OAuthError("server_error", "auth door fault"));
}

/** Resolve the Bearer actor for a CRUD route, or 401 UNAUTHORIZED (fail-closed). */
async function withActor(
  c: { req: { raw: Request } },
  deps: AppDeps,
  run: (userId: string) => Promise<Response>,
): Promise<Response> {
  const actor = await verifyAccessToken(
    c.req.raw.headers.get("authorization"),
    { accessSecret: deps.accessSecret, controlPlaneAudience: deps.controlPlaneAudience },
    Math.floor(deps.now() / 1000),
  );
  if (!actor) {
    return errorResponse(401, "UNAUTHORIZED");
  }
  return run(actor.userId);
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ code, message: code, details: {} }, { status });
}

/** Render a CrudResult: success body or the control-plane error it carries. */
function asResponse(result: { ok: boolean } & Record<string, unknown>, okStatus = 200): Response {
  if (result.ok) {
    return Response.json(result.value, { status: okStatus });
  }
  return errorResponse(result.status as number, result.code as string);
}
