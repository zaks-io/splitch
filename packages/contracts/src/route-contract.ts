import { z } from "zod";
import type { ErrorCode, ErrorResponse } from "./errors";

/**
 * Route-contract metadata. Each authored route in @splitch/contracts carries this
 * alongside its Zod input/output schemas so the route definition becomes
 * load-bearing at runtime, not documentation-only. @splitch/worker-runtime mounts
 * routes through this metadata. See docs/spec/platform/worker-runtime.md.
 *
 * Contracts stay pure: this module declares shapes only. It imports no Hono app,
 * no bindings, no runtime helpers.
 */

export const routeOwners = [
  "control-plane-api",
  "evaluation-api",
  "event-ingest-api",
  "analysis-api",
  "auth-api",
] as const;
export const RouteOwnerSchema = z.enum(routeOwners);
export type RouteOwner = z.infer<typeof RouteOwnerSchema>;

export const httpMethods = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export const HttpMethodSchema = z.enum(httpMethods);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/**
 * Auth kind a route requires. The guard dispatches principal resolution by this
 * value; a Worker only supplies resolvers for the kinds it actually mounts.
 */
export const authKinds = [
  "public",
  "control-plane-token",
  "client-key",
  "api-key",
  "internal-worker",
  "data-plane-key", // mixed Client Key | API Key (e.g. verify, ADR-0037)
] as const;
export const AuthKindSchema = z.enum(authKinds);
export type AuthKind = z.infer<typeof AuthKindSchema>;

/**
 * The public hostname a route is addressed on, as a Worker name resolved through
 * the ADR-0038 subdomain map.
 *
 * A route's public address is a property of the CREDENTIAL its caller holds, not
 * of the Worker that executes it (ADR-0046). An operator session knocks on the
 * control plane; a Client Key or API Key shipped in a customer's runtime knocks
 * on the edge. `owner` stays the internal execution owner, and when the two
 * differ the surface Worker delegates over a service binding.
 */
export const publicSurfaces = ["control-plane-api", "evaluation-api"] as const;
export type PublicSurface = (typeof publicSurfaces)[number];

/**
 * Total by construction: adding an AuthKind without deciding its surface fails
 * typecheck rather than silently addressing the new route at the control plane.
 */
const publicSurfaceByAuthKind: Readonly<Record<AuthKind, PublicSurface | null>> = {
  "control-plane-token": "control-plane-api",
  public: "control-plane-api",
  "client-key": "evaluation-api",
  "api-key": "evaluation-api",
  "data-plane-key": "evaluation-api",
  "internal-worker": null,
};

/**
 * `null` for a binding-only route, which is a real answer and not a fault: an
 * `internal-worker` route has no public address by design. It must not throw --
 * the registry sweeps every route through here at module load on Workers that
 * mount routes, so one binding-only route would take down every route on the
 * Worker at init rather than the single caller that asked.
 */
export function publicSurfaceFor(route: Pick<RouteContract, "auth">): PublicSurface | null {
  return publicSurfaceByAuthKind[route.auth];
}

/**
 * Which door minted the credential, carried as the `auth_door` claim.
 *
 * `anonymous` is the provisional door: nobody has proven an identity, so the
 * principal is unclaimed. Authorization that must distinguish "authenticated"
 * from "merely reachable" branches on this, not on scopes (a provisional
 * principal holds real Org scopes for its own demo workspace).
 */
export const authDoors = ["id_jag", "anonymous", "device_flow", "client_credentials"] as const;
export const AuthDoorSchema = z.enum(authDoors);
export type AuthDoor = z.infer<typeof AuthDoorSchema>;

export function isProvisionalAuthDoor(door: AuthDoor | null): boolean {
  return door === "anonymous";
}

/** Rate-limit class selected by the route, applied before scope checks. */
export const rateLimitClasses = [
  "none",
  "control-plane-actor",
  "client-key",
  "api-key",
  "anonymous-registration",
] as const;
export const RateLimitClassSchema = z.enum(rateLimitClasses);
export type RateLimitClass = z.infer<typeof RateLimitClassSchema>;

export const idempotencyModes = ["none", "optional", "required"] as const;
export const IdempotencyModeSchema = z.enum(idempotencyModes);
export type IdempotencyMode = z.infer<typeof IdempotencyModeSchema>;

export interface RawBodyByteLimit {
  readonly maxBytes: number;
  readonly error: ErrorResponse;
}

/**
 * Conservative UTF-8 byte cap for mutating JSON routes that omit an explicit
 * `rawBodyByteLimit`. Matches the existing Exposure / Metric Event envelope
 * (32 KiB). Routes may declare a smaller limit; they cannot silently opt into
 * an unbounded buffer through the registrar.
 */
export const DEFAULT_MUTATING_JSON_BODY_MAX_BYTES = 32 * 1024;

export const DEFAULT_MUTATING_JSON_BODY_LIMIT: RawBodyByteLimit = {
  maxBytes: DEFAULT_MUTATING_JSON_BODY_MAX_BYTES,
  error: {
    code: "VALIDATION_ERROR",
    message: `request body exceeds ${DEFAULT_MUTATING_JSON_BODY_MAX_BYTES} UTF-8 bytes`,
    details: {
      issues: [
        {
          path: ["body"],
          message: `body must be at most ${DEFAULT_MUTATING_JSON_BODY_MAX_BYTES} UTF-8 bytes`,
        },
      ],
    },
  },
};

/**
 * Effective raw-body cap the registrar must pass to parseInput.
 *
 * GET never buffers a body. Every other method is mutating JSON at this
 * boundary: use the route's explicit limit when present (including a tighter
 * cap), otherwise the conservative default. Absence is never unbounded.
 */
export function rawBodyByteLimitFor(
  contract: Pick<RouteContract, "method" | "rawBodyByteLimit">,
): RawBodyByteLimit | undefined {
  if (contract.method === "GET") {
    return contract.rawBodyByteLimit;
  }
  return contract.rawBodyByteLimit ?? DEFAULT_MUTATING_JSON_BODY_LIMIT;
}

/**
 * The runtime-enforcement metadata for one route. `input`/`output` are Zod
 * schemas; everything else is guard policy the registrar reads.
 */
export interface RouteContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  id: string;
  owner: RouteOwner;
  method: HttpMethod;
  path: string;
  input: Input;
  output: Output;
  auth: AuthKind;
  scopes: readonly string[];
  rateLimit: RateLimitClass;
  idempotency: IdempotencyMode;
  rawBodyByteLimit?: RawBodyByteLimit;
  errors: readonly ErrorCode[];
}

/**
 * Authoring helper: infers Input/Output generics from the passed schemas and
 * defaults the policy fields to their safest values (public, no scopes, no rate
 * limit, no idempotency). A route opts into stricter policy explicitly.
 */
export function defineRoute<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  contract: RouteContract<Input, Output>,
): RouteContract<Input, Output> {
  return contract;
}
