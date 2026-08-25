import type { AuthKind, RouteContract } from "@splitch/contracts";
import type { AuthResolver, Principal } from "./principal";
import { resolveRequestId } from "./request-id";
import { emptyError, renderError } from "./respond";

/**
 * Worker-to-Worker delegation for a route whose public hostname is not its
 * implementation (ADR-0046).
 *
 * A route's public address follows the CREDENTIAL its caller holds, so an
 * operator's control-plane token knocks on `api.splitch.dev` even for operations
 * the Analysis or Evaluation Worker executes. The surface Worker runs the full
 * guard chain, then forwards the already-parsed input over a service binding with
 * the authorized scope in a header; the owner Worker turns that header back into
 * a Principal. Both ends live here so the minted identity and the checked
 * identity cannot drift.
 *
 * This header is NOT a credential. The receiving entrypoint is a
 * `WorkerEntrypoint` reachable only over a service binding, so Cloudflare
 * guarantees the caller is the bound Worker and the header never crosses the
 * public internet. The path-vs-identity cross-check below defends against a bug
 * in the surface Worker, not against a forged header.
 */

export const DELEGATED_IDENTITY_HEADER = "x-splitch-delegated-identity";

/** Service-binding requests need an absolute URL; this host is never resolved. */
const DELEGATION_ORIGIN = "https://delegated.splitch.internal";

export interface DelegatedIdentity {
  /** The registry operationId the surface Worker authorized. */
  operation: string;
  actorId: string;
  authKind?: AuthKind;
  scopes?: readonly string[];
  /**
   * The tenant scope the surface Worker AUTHORIZED, never what the request asked
   * for. Minting these from the path instead of from the resolved principal would
   * make the receiving end's cross-check a tautology.
   */
  orgId: string | null;
  appId: string | null;
  environmentId: string | null;
}

/**
 * The scope the surface Worker authorized, read off the resolved principal once
 * the guard's co-scope step has passed (ADR-0027).
 *
 * App and Org come from the CREDENTIAL: they are tenant boundaries, and the guard
 * already refused a principal not bound to the path's App or Org. The Environment
 * is the path's whenever the credential is env-unbound, because a control-plane
 * token binds an App and SELECTS the Environment by path within it; an env-bound
 * credential was held to the same value by the guard, so the two agree wherever
 * both exist.
 */
export function delegatedIdentityFrom(
  route: Pick<RouteContract, "id">,
  principal: Principal,
  params: Readonly<Record<string, string>>,
): DelegatedIdentity {
  return {
    operation: route.id,
    actorId: principal.id,
    authKind: principal.kind,
    scopes: [...principal.scopes],
    orgId: principal.orgId,
    appId: principal.appId,
    environmentId: principal.environmentId ?? params.environmentId ?? null,
  };
}

/** The pieces of a registrar-parsed input that make up the downstream request. */
export interface DelegatedInput {
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, unknown>>;
  body?: unknown;
  requestId?: string;
}

/**
 * The downstream request, rebuilt from contract-validated input rather than
 * forwarded raw: only data the surface Worker's schema already accepted crosses
 * the binding.
 */
export function delegatedRequest(
  route: Pick<RouteContract, "method" | "path">,
  identity: DelegatedIdentity,
  input: DelegatedInput,
): Request {
  const url = new URL(DELEGATION_ORIGIN + substitutePath(route.path, input.params ?? {}));
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  const sendsBody = route.method !== "GET" && route.method !== "DELETE";
  return new Request(url, {
    method: route.method,
    headers: {
      [DELEGATED_IDENTITY_HEADER]: JSON.stringify(identity),
      ...(input.requestId ? { "x-request-id": input.requestId } : {}),
      ...(sendsBody ? { "content-type": "application/json" } : {}),
    },
    ...(sendsBody ? { body: JSON.stringify(input.body ?? {}) } : {}),
  });
}

/**
 * The identity a delegated request carries, or null if this is not one.
 *
 * `allowed` is the owner Worker's delegation allowlist (`routesDelegatedTo`), so
 * an operation the registry does not delegate to this Worker cannot be reached by
 * naming it in the header.
 */
export function delegatedIdentityFor(
  request: Request,
  allowed: readonly RouteContract[],
): DelegatedIdentity | null {
  const identity = parseDelegatedIdentity(request.headers.get(DELEGATED_IDENTITY_HEADER));
  if (!identity) return null;
  const route = allowed.find((candidate) => candidate.id === identity.operation);
  if (!route || route.method !== request.method) return null;
  const params = matchPath(route.path, new URL(request.url).pathname);
  if (!params) return null;
  // An App or Org in the path that the surface Worker did not authorize means the
  // surface Worker has a bug; serving it would turn that bug into a cross-tenant
  // read. The Environment axis is weaker by construction (a control-plane token
  // selects it by path), so it catches a request built inconsistently with the
  // identity minted alongside it, not an authorization failure.
  for (const axis of ["orgId", "appId", "environmentId"] as const) {
    if (params[axis] !== undefined && params[axis] !== identity[axis]) return null;
  }
  return identity;
}

/**
 * The response for a request this Worker refuses to treat as delegated.
 *
 * The surface Worker returns the binding's response VERBATIM to its caller, so
 * this is exactly what the CLI receives. A bare-text 404 would make the one path
 * that reports a surface-Worker bug also the one path that breaks the error
 * envelope: no code, no request id, nothing an agent can branch on.
 *
 * INTERNAL_SERVER_ERROR, not NOT_FOUND, because every route to here is a
 * platform defect -- the surface Worker named an operation it is not delegated,
 * or built a path inconsistent with the identity it minted alongside it. The
 * caller's Experiment is fine; telling them it was not found would blame their
 * data for our bug, and would not page anyone. A 5xx does.
 */
export function notDelegatedResponse(request: Request): Response {
  return renderError(
    emptyError("INTERNAL_SERVER_ERROR", "delegated request was not recognized by its owner"),
    { requestId: resolveRequestId(request) },
  );
}

/**
 * The Principal a delegated request resolves to. The binding carries the exact
 * already-authorized auth kind and scopes so the owner can re-run the same guard.
 */
export function delegatedAuthResolver(identity: DelegatedIdentity): AuthResolver {
  return () => ({
    ok: true as const,
    principal: {
      kind: identity.authKind ?? "control-plane-token",
      id: identity.actorId,
      scopes: identity.scopes ?? [],
      orgId: identity.orgId,
      appId: identity.appId,
      environmentId: identity.environmentId,
      // Minted by the surface Worker from an already-authorized principal, not by
      // an auth door.
      authDoor: null,
    },
  });
}

function parseDelegatedIdentity(value: string | null): DelegatedIdentity | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    return isDelegatedIdentity(candidate) ? (candidate as unknown as DelegatedIdentity) : null;
  } catch {
    return null;
  }
}

function isDelegatedIdentity(candidate: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(candidate.operation) &&
    isNonEmptyString(candidate.actorId) &&
    isScopeAxis(candidate.orgId) &&
    isScopeAxis(candidate.appId) &&
    isScopeAxis(candidate.environmentId) &&
    (candidate.authKind === undefined || isAuthKind(candidate.authKind)) &&
    (candidate.scopes === undefined || isStringArray(candidate.scopes))
  );
}

function substitutePath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`worker-runtime: delegated path "${template}" has no value for ":${name}"`);
    }
    return encodeURIComponent(value);
  });
}

/** Path params by name, or null when the pathname is not this contract's path. */
function matchPath(template: string, pathname: string): Record<string, string> | null {
  const expected = template.split("/");
  const actual = pathname.replace(/\/$/, "").split("/");
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const matched = matchSegment(segment, actual[index]);
    if (!matched) return null;
    if (matched.name) params[matched.name] = matched.value;
  }
  return params;
}

/** A literal segment that must match exactly, or a named param that must be non-empty. */
function matchSegment(
  segment: string,
  value: string | undefined,
): { name?: string; value: string } | null {
  if (value === undefined) return null;
  if (!segment.startsWith(":")) return segment === value ? { value } : null;
  if (value.length === 0) return null;
  const decoded = decodeParam(value);
  return decoded === null ? null : { name: segment.slice(1), value: decoded };
}

/**
 * `decodeURIComponent` throws URIError on a malformed escape (`%E0%A4%A`, a bare
 * `%`), and `delegatedIdentityFor` runs in a `WorkerEntrypoint.fetch` with no
 * guard around it, so that throw escapes the binding and the caller sees a 500
 * where the documented `null` means 404.
 *
 * Null is also the right answer on its merits: an undecodable segment cannot
 * equal any scope value the surface Worker authorized, so this is not a request
 * that Worker built.
 */
function decodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isScopeAxis(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAuthKind(value: unknown): value is AuthKind {
  return [
    "public",
    "control-plane-token",
    "client-key",
    "api-key",
    "internal-worker",
    "data-plane-key",
  ].includes(String(value));
}
