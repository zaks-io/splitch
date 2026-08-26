# Sentry integration: change tracking and evaluation tracking

Sentry's feature-flag support has two independent halves, and its **suspect flag** detection
("this Flag flipped four minutes before this error spike") only works when both are fed.

| Half                    | Direction        | Who ships it                             |
| ----------------------- | ---------------- | ---------------------------------------- |
| **Change tracking**     | splitch → Sentry | Control Plane Worker, on the minute cron |
| **Evaluation tracking** | app → Sentry     | `@splitch/sdk/sentry` in the host app    |

Set up change tracking first. An evaluation-tracking-only install shows Flags on the error event but
cannot correlate them with anything.

## Change tracking

### Sentry side

In Sentry, **Settings → Feature Flags → Change Tracking**, add a provider of type **Generic**.
Sentry returns a signing secret (10-64 characters) and the webhook URL:

```text
https://sentry.io/api/0/organizations/<organization_id_or_slug>/flags/hooks/provider/generic/
```

Regional hosts (`https://us.sentry.io/...`, `https://de.sentry.io/...`) are accepted. Self-hosted
Sentry requires its host in the Worker's `SENTRY_WEBHOOK_ALLOWED_HOSTS`.

### Install

One installation binds **one Environment to one Sentry organization**. Sentry's payload carries no
environment field, so a prod Sentry organization must not hear about dev toggles; the Environment
comes from the API Key, never from the body.

```text
POST /api/integrations/sentry/installations
Authorization: Bearer <apiKey>

{ installationId, webhookUrl, webhookSecret }
```

`installationId` is a caller-generated UUID. An exact retry returns the existing installation;
reusing the id with a different URL or secret fails `IDEMPOTENCY_KEY_CONFLICT`. The secret is
encrypted under `INTEGRATION_SECRET_KEK` and never returned.

`webhookUrl` must be HTTPS, on `sentry.io`/`*.sentry.io` or a configured self-hosted host, with no
credentials, port, query string, or fragment, and its path must be the
`/api/0/organizations/<org>/flags/hooks/provider/generic/` shape. This is an SSRF boundary and is
re-checked at dispatch time, not only at install: the row outlives the request.

`GET /api/integrations/sentry/installations/:installationId` returns delivery health
(`lastDeliveredSeq`, `lastDeliveredAt`, `attemptCount`, `nextAttemptAt`, `latestDeliveryError`) and
never the secret. `DELETE` revokes and stops delivery.
`POST .../secret-rotations` replaces the signing secret when Sentry issues a new one.

### What splitch sends

Every Flag-domain mutation writes a `flag_change_events` row through a D1 trigger (ADR-0051). The
cron projects the rows after the installation's cursor onto Sentry's schema:

```json
{
  "data": [
    {
      "action": "updated",
      "change_id": 4821,
      "created_at": "2026-08-25T18:04:11",
      "created_by": { "id": "user_01J...", "type": "id" },
      "flag": "checkout-v2"
    }
  ],
  "meta": { "version": 1 }
}
```

Header: `X-Sentry-Signature: <hex hmac-sha256 of the exact raw body under the signing secret>`.
Sentry answers `201 Created`.

Four details the contract turns on:

- **`created_at` is `YYYY-MM-DDTHH:MM:SS`**: no milliseconds, no `Z`. `toISOString()` produces
  neither, so it is formatted explicitly. A `400` from Sentry is almost always this.
- **`change_id` is the log's `seq`**, a monotonic 64-bit `AUTOINCREMENT` primary key. Sentry treats
  it as an idempotency token, which is what makes at-least-once redelivery safe and lets the
  installation carry a cursor instead of an outbox table.
- **`created_by` is the opaque WorkOS ref with `type: "id"`.** No email, no name, because D1 stores no PII
  to leak (ADR-0032). Changes with no actor on their own row (Variant and Targeting Rule writes)
  ship as `{"id": "unattributed", "type": "name"}` rather than being dropped or attributed to
  whoever last touched the Flag; each batch logs `sentry_webhook_unattributed_changes` with the
  count and the affected `seq` values.
- **The cursor advances only on an accepted delivery**, and never past a terminal `4xx`. Skipping a
  rejected batch would silently drop real production changes; the backlog stays and the failure is
  visible in `attemptCount` and `latestDeliveryError`.

App-level Flag DEFINITION changes (create, rename, delete, Variant edits) carry no Environment and
reach every Environment's installation. Per-Environment CONFIGURATION changes (`enabled`, rollout,
targeting) reach only their own (ADR-0027).

## Evaluation tracking

Sentry's flag buffer stores `{ flag: string, result: boolean }` and its `addFeatureFlag` is a
documented no-op for any other value. That one constraint drives the whole mapping.

```ts
import * as Sentry from "@sentry/browser";
import { createSplitchClient } from "@splitch/sdk";
import { sentryResolutionReporter } from "@splitch/sdk/sentry";

Sentry.init({ dsn, integrations: [Sentry.featureFlagsIntegration()] });

const client = createSplitchClient({
  clientKey,
  onResolution: sentryResolutionReporter(),
});
```

`@sentry/core` is an optional peer dependency, resolved only when `@splitch/sdk/sentry` is imported.
Depending on `@splitch/sdk` never pulls Sentry in.

### Mapping

| Resolution                       | Sent to Sentry                            |
| -------------------------------- | ----------------------------------------- |
| boolean value                    | `addFeatureFlag(flagKey, value)`          |
| non-boolean with a resolved arm  | `addFeatureFlag("flagKey:variant", true)` |
| `reason: "ERROR"`                | nothing                                   |
| non-boolean with no resolved arm | nothing, reported once per Flag           |

A multivariate Flag becomes one boolean per served arm: `checkout-flow:treatment = true`. Two arms of
the same Flag never collide because the arm is part of the name.

An `ERROR` resolution served the caller's Default Value because evaluation failed. Recording it would
claim a resolution that never happened (the disguised default ADR-0036 forbids), and the exception
Sentry is capturing already carries the real story.

A non-boolean resolution with `variantName: null` has no arm name to encode and no boolean to send.
It is not recorded, and it is not silent: the reporter logs it once per Flag key through the injected
`Logger` (default `console`).

### What is not reported

`peekVariant` and `verify` never reach the reporter. Both are non-exposing diagnostics, and
attaching their Flags to an error would claim the user path resolved something it never asked for.

`evaluateAll` reports every entry that resolved to a Variant. Entries with `variant: null` are
skipped, because a Precomputed Evaluations payload carries no per-Flag default and there is no value to
report that would not be invented.

## Verifying the whole thing

1. Toggle a Flag through the API; within a minute the change appears in Sentry's flag audit log. A
   `401` from Sentry means the signature is wrong; a `400` means `created_at`.
2. Evaluate one boolean and one multivariate Flag in the instrumented app, then throw. The Sentry
   issue's **Feature Flags** section shows both `my-flag` and `checkout-flow:treatment`.
3. Toggle, then error. Sentry surfaces the **suspect flag** on the issue. This is the product
   outcome, and the only check that proves both halves are wired to each other.

## Sources

- [Sentry: generic feature flag integration](https://docs.sentry.io/organization/integrations/feature-flag/generic/)
- [Sentry flags API contract](https://github.com/getsentry/sentry/blob/master/src/sentry/flags/docs/api.md)
- [Sentry: feature flag evaluation tracking](https://docs.sentry.io/platforms/javascript/configuration/integrations/featureflags/)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0032](../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [ADR-0051](../../adr/0051-the-flag-change-log-is-both-the-audit-record-and-the-integration-outbox.md)
