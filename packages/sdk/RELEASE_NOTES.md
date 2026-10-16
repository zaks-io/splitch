# Next SDK release

## Control Plane contracts

`@splitch/sdk/control-plane` adds the Personal Access Token contracts: the token, grant, and
request and response schemas, and the token management routes. A grant is
`{ target, role, permissions }`. `permissions` is a subset of `write`, `delete`, `credentials`,
`members`, and `privacy`; an empty list grants read access only.

Every Control Plane route contract now declares the authority a Personal Access Token needs to call
it: `read`, one of the five permissions, or a special rule for approval reviews, token cleanup, and
session-only routes.

`principal_capabilities_get` is now served on the public Control Plane door. For a Personal Access
Token it also returns the token's id, name, configured grants, expiry, and effective authority per
permission.

Breaking: computation that Splitch now performs server-side is no longer exported from
`@splitch/sdk/control-plane`. Imports of these names fail after upgrading:

- Experiment decisions and results: `computeShipRecommendation`, `evaluateExperimentDecisionGate`,
  `produceExperimentResults`, and the other decision-gate and ship-recommendation helpers. Read
  decisions from the Experiment results responses.
- Experiment pre-registration: `resolvePreRegistration`, `preRegistrationToIntent`,
  `PreRegistrationIssue`, and `nextAfterExperimentStart`. Experiment responses carry the resolved
  `preRegistration`, and mutation responses carry `next`.
- Flag lifecycle and staleness: `detectStaleReasons`, `uniformServingMode`, `daysBetween`,
  `EnvironmentConfigState`, and `StaleFlagSignals`.
- Flag change diffs: `parseFlagChangeDiff`, `renderFlagChangeUnifiedDiff`, and
  `UNAVAILABLE_FLAG_CHANGE_DIFF`.
- `CREDENTIAL_CACHE_BACKFILL_CHECKPOINT_VERSION`, an internal migration constant.

## Sentry

`@splitch/sdk/sentry` now supports `@sentry/core` versions `^10.0.0 || ^11.0.0`.
Sentry remains an optional peer and stays external to the SDK bundle, so the reporter uses the
client already initialized by your app. The integration tests exercise real Sentry clients from
both majors. Existing Sentry 10 consumers can keep their current initialization.

The Sentry 11 example and documentation explicitly disable automatic sensitive data collection.
Review the [Sentry v10 to v11 migration guide](https://docs.sentry.io/platforms/javascript/migration/v10-to-v11/)
before upgrading the Sentry SDK in your app. This peer expansion does not change how splitch encodes
boolean or multivariate Flag resolutions in Sentry.
