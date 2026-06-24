// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the worker-runtime surface is intentionally aggregated here
export { createRegistrar, PUBLIC_PRINCIPAL } from "./registrar.js";
export type { HandlerArgs, Registrar, RouteHandler } from "./registrar.js";
export type { Observability, RegistrarDeps, ResolvableAuthKind } from "./deps.js";
export type { AuthResolver, AuthResult, Principal } from "./principal.js";
export type { RateLimitDecision, RateLimiter } from "./rate-limit.js";
export { emptyError, renderError } from "./respond.js";
export type { EmptyDetailCode } from "./respond.js";
export { MALFORMED_BODY } from "./parse-input.js";
export type { RawInput } from "./parse-input.js";
