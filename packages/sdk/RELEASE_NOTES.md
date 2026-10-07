# Next SDK release

`@splitch/sdk/sentry` now supports `@sentry/core` versions `^10.0.0 || ^11.0.0`.
Sentry remains an optional peer and stays external to the SDK bundle, so the reporter uses the
client already initialized by your app. The integration tests exercise real Sentry clients from
both majors. Existing Sentry 10 consumers can keep their current initialization.

The Sentry 11 example and documentation explicitly disable automatic sensitive data collection.
Review the [Sentry v10 to v11 migration guide](https://docs.sentry.io/platforms/javascript/migration/v10-to-v11/)
before upgrading the Sentry SDK in your app. This peer expansion does not change how splitch encodes
boolean or multivariate Flag resolutions in Sentry.
