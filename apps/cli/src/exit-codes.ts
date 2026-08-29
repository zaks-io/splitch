/**
 * CLI exit codes — stable for scripting and the Vitest exit-code suite.
 *
 * Error-code → exit mapping (keep in sync with handleExecutionError / cli.ts):
 * - EXIT_USAGE (1): CLI_USAGE_INVALID, CLI_VALIDATION_ERROR, CLI_CREDENTIAL_STORE_FAILED,
 *   CLI_CONFIG_READ_FAILED, CLI_OPERATION_UNKNOWN, CLI_API_ORIGIN_MISSING,
 *   CLI_ROUTE_SURFACE_UNSUPPORTED, CLI_DEVICE_*, CLI_LOGOUT_REVOKE_FAILED,
 *   CLI_UNEXPECTED_ERROR, and other client failures not listed below
 * - EXIT_AUTH (2): CLI_NOT_AUTHENTICATED, CLI_SESSION_EXPIRED, CLI_EMAIL_UNVERIFIED
 * - EXIT_SCOPE (3): CLI_SCOPE_UNRESOLVED, CLI_TOKEN_BINDING_REFUSED
 * - EXIT_API (4): control-plane ErrorResponse codes except SELECTOR_AMBIGUOUS (and
 *   CLI_SERVER_CODE_UNRECOGNIZED / CLI_DATA_PLANE_ERROR_CODE_MISSING on that path)
 * - EXIT_SELECTOR_AMBIGUOUS (5): SELECTOR_AMBIGUOUS, so scripts can distinguish an
 *   actionable choice from a missing resource
 */
export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_AUTH = 2;
export const EXIT_SCOPE = 3;
export const EXIT_API = 4;
export const EXIT_SELECTOR_AMBIGUOUS = 5;
