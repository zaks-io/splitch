// biome-ignore-all lint/performance/noBarrelFile: internal sub-barrel of ../index.ts, which stays the only supported import path for these symbols

// The route registry and the vocabulary a route is described in. Grouped because
// they are read together: a consumer asking which Worker mounts an operation
// (ADR-0046) also needs the auth kind and surface that decide it.
export type {
  AuthDoor,
  AuthKind,
  HttpMethod,
  IdempotencyMode,
  PublicSurface,
  RateLimitClass,
  RawBodyByteLimit,
  RouteContract,
  RouteOwner,
} from "../route-contract";
export {
  AuthDoorSchema,
  AuthKindSchema,
  authDoors,
  authKinds,
  DEFAULT_CONTROL_PLANE_JSON_BODY_LIMIT,
  DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES,
  DEFAULT_MUTATING_JSON_BODY_LIMIT,
  DEFAULT_MUTATING_JSON_BODY_MAX_BYTES,
  defineRoute,
  HttpMethodSchema,
  httpMethods,
  IdempotencyModeSchema,
  idempotencyModes,
  isProvisionalAuthDoor,
  publicSurfaceFor,
  publicSurfaces,
  RateLimitClassSchema,
  RouteOwnerSchema,
  rateLimitClasses,
  rawBodyByteLimitFor,
  routeOwners,
} from "../route-contract";
// The emitted OpenAPI document is the registry rendered for public discovery,
// so it lives with the registry rather than beside unrelated leaf contracts.
export type { OpenApiDocumentInfo } from "../openapi-document";
export { buildOpenApiDocument, resolveApiDocumentVersion } from "../openapi-document";
export {
  getRoute,
  mountedOperationIds,
  operationIds,
  routeRegistry,
  routesBindingOnlyTo,
  routesDelegatedBy,
  routesDelegatedTo,
  routesMountedBy,
  routesSurfacedBy,
} from "../route-registry";
