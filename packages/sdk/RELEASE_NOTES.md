# Next SDK release

Changes merged since `sdk-v0.12.0`.

## Temporary Environment expiry

- The server client preserves `ENVIRONMENT_EXPIRED` on failed Evaluations and throws it from
  non-fallback accessors. It logs expiry once per client and directs callers to create a new
  Temporary Environment and configure its credential.
- The browser client treats expiry as terminal: it stops revalidation and Exposure delivery, clears
  pending Exposures and held values, and notifies subscribers. Reads return the caller's Default
  Variant with `reason: "ERROR"` and `errorCode: "ENVIRONMENT_EXPIRED"`; `init()` and `flush()` reject.
- `SplitchOfrepProvider` maps expiry to OpenFeature `GENERAL` with `ENVIRONMENT_EXPIRED` in the
  message, logs it once across resolution and tracking, and does not retry.

## Control Plane contracts

`@splitch/sdk/control-plane` includes:

- Temporary Environment create and Sync contracts (`environments_sync`), a required nullable
  `Environment.temporary` member, and credential-cache V3 expiry metadata. Code constructing
  Environment objects must now provide `temporary`, using `null` for permanent Environments.
- The `temporary_environments` Personal Access Token permission and the error codes
  `ENVIRONMENT_EXPIRED`, `ENVIRONMENT_KIND_UNSUPPORTED`, `TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED`,
  `SYNC_LIMIT_EXCEEDED`, and `ENVIRONMENT_SYNC_INCOMPLETE`. Exhaustive error switches need these cases.
- App audit schemas and types, including `AppAuditEventSchema`, `AppAuditListQuerySchema`, and
  `AppAuditListResponseSchema`, plus the `app_audit_list` operation.
- The `integration_deliveries_create` operation, which wakes delivery for one Environment and returns
  outstanding Convex/Cloudflare counts, or `cron_noop` in cron mode.
- Optional nullable `ConvexInstallationStatus.deploymentMissingAt` for deleted deployment detection.
- An updated `OverviewFlagConfigChange` shape with `seq`, `action`, `targetType`, `actorRef`,
  `actorVia`, and `changedAt`, replacing `flagName`, `enabled`, and `updatedAt`. Overview change counts
  now count Flag change-log events.

## Dependencies

The runtime Zod requirement is now `^4.6.6`.
