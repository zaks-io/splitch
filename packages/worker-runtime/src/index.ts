// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the worker-runtime surface is intentionally aggregated here
export { createRegistrar, PUBLIC_PRINCIPAL } from "./registrar";
export type { HandlerArgs, Registrar, RouteHandler } from "./registrar";
export type { Observability, RegistrarDeps, ResolvableAuthKind } from "./deps";
export type { AuthResolver, AuthResult, Principal } from "./principal";
export type { RateLimitDecision, RateLimiter } from "./rate-limit";
export { emptyError, renderError } from "./respond";
export type { EmptyDetailCode } from "./respond";
export { MALFORMED_BODY } from "./parse-input";
export type { RawInput } from "./parse-input";
