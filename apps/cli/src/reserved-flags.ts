/**
 * Long-flag kebabs reserved for global CLI parsing and hand-mapped command
 * flags. A route query field whose kebab-case name matches one of these is not
 * derived as a query flag; callers use the reserved spelling instead.
 *
 * Examples: `environmentId` stays `--env` (not `--environment-id` when also
 * listed under hand-managed fields); `dryRun` stays `--dry-run`.
 */
export const RESERVED_CLI_FLAG_KEBABS = new Set([
  "json",
  "confirm",
  "help",
  "dry-run",
  "force",
  "summary",
  "app",
  "env",
  "org",
  "endpoint",
  "name",
  "key",
  "targeting-key",
  "id-type",
  "context-json",
  "body-json",
  "by",
  "variants",
  "from-environment-id",
  "enabled",
  "rollout",
  "idempotency-key",
  "output-file",
  "when",
  "serve",
  "wrangler-env",
]);
