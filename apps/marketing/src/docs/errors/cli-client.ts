import type { ErrorDoc } from "./types";

/**
 * Raised by `splitch` itself rather than by the API. The `exitCode` on each
 * entry is what the process returns, so a script can branch on the class of
 * failure without parsing stderr: 1 usage, 2 auth, 3 scope, 4 API.
 */
export const cliErrorDocs = {
  CLI_USAGE_INVALID: {
    cause:
      "The invocation did not parse: an unknown command or flag, a flag missing its value, a required positional missing or supplied twice, an out-of-range value, or malformed `--body-json`.",
    fix: "Read the `Cause:` clause, which names the exact token at fault, then run the command with `--help` to list what it accepts. `splitch` with no arguments prints the supported command paths.",
    exitCode: 1,
    related: ["CLI_VALIDATION_ERROR", "VALIDATION_ERROR"],
  },
  CLI_VALIDATION_ERROR: {
    cause:
      "The invocation parsed but its input failed contract validation before any request was sent. `splitch flags create` without a variant catalog, `--variants` without `--key`, or an unrecognized `SPLITCH_PLATFORM_TARGET` all land here.",
    fix: "The error names the offending field and reason. Fix the field and retry. Validation runs locally so a malformed create never reaches the control plane and never half-writes.",
    details: "{ field: string, reason: string }",
    exitCode: 1,
    related: ["CLI_USAGE_INVALID", "VALIDATION_ERROR"],
  },
  CLI_SCOPE_UNRESOLVED: {
    cause:
      "The App, Environment, or Flag the command addresses could not be pinned down: nothing matched the selector, more than one thing matched it, or an Environment was named without an App.",
    fix: "The message lists what is reachable so you can pick from it. Set a durable selection with `splitch use --app <app> --env <env>`, or pass `--app` / `--env` per command. When a key matches more than one resource, pass the canonical ID instead of the key.",
    exitCode: 3,
    related: ["APP_NOT_FOUND", "FLAG_NOT_FOUND", "CLI_NOT_AUTHENTICATED"],
  },
  CLI_NOT_AUTHENTICATED: {
    cause: "No CLI login session is available.",
    fix: "Run `splitch login`.",
    exitCode: 2,
    related: ["CLI_SESSION_EXPIRED", "UNAUTHORIZED"],
  },
  CLI_SESSION_EXPIRED: {
    cause: "A login session exists but could not mint a usable token.",
    fix: "Run `splitch login` again. The stored credential is not silently refreshed past its life, so an expired session fails rather than serving a stale token.",
    exitCode: 2,
    related: ["CLI_NOT_AUTHENTICATED", "CLI_TOKEN_BINDING_REFUSED"],
  },
  CLI_TOKEN_BINDING_REFUSED: {
    cause:
      "The session token could not be bound to the requested scope, usually because the account holds no membership that reaches it.",
    fix: "The `Remediation:` clause is specific to the refusal reason. Confirm the Organization membership for the account you logged in as, then retry.",
    exitCode: 3,
    related: ["CLI_SESSION_EXPIRED", "FORBIDDEN", "APP_MISMATCH"],
  },
  CLI_EMAIL_UNVERIFIED: {
    cause: "The identity provider has not verified an email address for this account.",
    fix: "Verify the address with the identity provider, then run `splitch login` again.",
    exitCode: 2,
    related: ["CLI_NOT_AUTHENTICATED"],
  },
  CLI_DEVICE_AUTHORIZATION_FAILED: {
    cause:
      "The device authorization request failed, or the auth service returned a response missing a required field.",
    fix: "The message carries the OAuth fault. Check network reachability to the auth service, then run `splitch login` again.",
    exitCode: 2,
    related: ["CLI_DEVICE_TOKEN_EXCHANGE_FAILED", "CLI_DEVICE_APPROVAL_TIMEOUT"],
  },
  CLI_DEVICE_TOKEN_EXCHANGE_FAILED: {
    cause:
      "The device code was approved but exchanging it for a token failed, or the token response carried no `user_id` to identify the session.",
    fix: "Restart `splitch login` and complete the new device authorization. If it repeats, the auth service is returning a bad token response.",
    exitCode: 2,
    related: ["CLI_DEVICE_AUTHORIZATION_FAILED", "CLI_DEVICE_APPROVAL_TIMEOUT"],
  },
  CLI_DEVICE_APPROVAL_TIMEOUT: {
    cause: "The device code expired before it was approved in the browser.",
    fix: "Run `splitch login` again and approve the request before it expires.",
    exitCode: 2,
    related: ["CLI_DEVICE_AUTHORIZATION_FAILED"],
  },
  CLI_LOGOUT_REVOKE_FAILED: {
    cause:
      "The local credential was removed but the server refused to revoke the session, so the token may still be accepted elsewhere until it expires.",
    fix: "This is reported rather than swallowed because a logout that only cleared the local file is not a logout. Revoke the session from the Control Panel, or retry once the auth service is reachable.",
    exitCode: 2,
    related: ["CREDENTIAL_REVOKED", "CLI_CREDENTIAL_STORE_FAILED"],
  },
  CLI_API_ORIGIN_MISSING: {
    cause:
      "The platform target in `SPLITCH_PLATFORM_TARGET` has no API origin configured in the environment.",
    fix: "Set the environment variable the message names to the API origin for that target. Only needed when pointing the CLI at a non-default deployment.",
    exitCode: 1,
    related: ["CLI_VALIDATION_ERROR", "CLI_ROUTE_SURFACE_UNSUPPORTED"],
  },
  CLI_ROUTE_SURFACE_UNSUPPORTED: {
    cause: "The operation the command maps to has no public origin the CLI can address.",
    fix: "Use an operation exposed on a public API surface. If a shipped command produces this, it is a CLI defect: report the operation id.",
    exitCode: 1,
    related: ["CLI_OPERATION_UNKNOWN", "CLI_API_ORIGIN_MISSING"],
  },
  CLI_OPERATION_UNKNOWN: {
    cause: "The command resolved to an operation id that is not in the registry.",
    fix: "Use a command backed by a registered operation. From a shipped command this means the CLI and its contract bundle disagree: update `@splitch/cli`.",
    exitCode: 1,
    related: ["CLI_ROUTE_SURFACE_UNSUPPORTED", "CLI_SERVER_CODE_UNRECOGNIZED"],
  },
  CLI_CONFIG_READ_FAILED: {
    cause: "`.splitch/config.json` exists but could not be read or parsed.",
    fix: "Fix or remove the file and retry. It only holds the `splitch use` selection, so deleting it costs nothing but the App and Environment defaults.",
    exitCode: 1,
    related: ["CLI_CREDENTIAL_STORE_FAILED", "CLI_SCOPE_UNRESOLVED"],
  },
  CLI_CREDENTIAL_STORE_FAILED: {
    cause: "The credential store could not be read, written, or cleared.",
    fix: "Check permissions on the credential file and retry. The failure is surfaced rather than absorbed so a login that did not persist never looks like a login that did.",
    exitCode: 1,
    related: ["CLI_CONFIG_READ_FAILED", "CLI_NOT_AUTHENTICATED"],
  },
  CLI_DATA_PLANE_ERROR_CODE_MISSING: {
    cause:
      '`splitch flags verify` got `reason: "ERROR"` from the data plane with no error code attached, so there is nothing to attribute the failure to.',
    fix: "Correct the reported data-plane failure and retry. An unattributable ERROR is reported under its own code rather than being folded into a generic one, because the missing code is itself the defect worth reporting.",
    exitCode: 4,
    related: ["SERVICE_UNAVAILABLE", "CLI_SERVER_CODE_UNRECOGNIZED"],
  },
  CLI_SERVER_CODE_UNRECOGNIZED: {
    cause:
      "The server returned an error code this CLI build does not know. The message is passed through verbatim.",
    fix: "Update `@splitch/cli` to a build that carries the current contract. The unknown code and its message are in the `Cause:` clause, and every code is documented at `/docs/error/{code}`.",
    exitCode: 4,
    related: ["CLI_OPERATION_UNKNOWN", "INTERNAL_SERVER_ERROR"],
  },
  CLI_UNEXPECTED_ERROR: {
    cause: "An unhandled fault inside the CLI. The underlying message is passed through.",
    fix: "Retry the command. If it persists, report the code with the command line that produced it.",
    exitCode: 1,
    related: ["INTERNAL_SERVER_ERROR"],
  },
} satisfies Record<string, ErrorDoc>;
