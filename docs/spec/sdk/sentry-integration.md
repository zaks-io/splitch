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

### Who mints the secret

Sentry's **Settings → Feature Flags → Change Tracking → Add New Provider** form shows a read-only
webhook URL and an empty Secret field hinted "paste the signing secret given by your provider."
splitch is the provider, so splitch mints the secret and the operator pastes it into Sentry. The
exchange is two copy-pastes in this order:

1. Copy the webhook URL out of Sentry's form.
2. Paste it into splitch; splitch answers with a freshly minted signing secret, shown once.
3. Paste that secret into Sentry's Secret field and save.

The URL looks like this, and regional hosts (`https://us.sentry.io/...`, `https://de.sentry.io/...`)
are accepted:

```text
https://sentry.io/api/0/organizations/<organization_id_or_slug>/flags/hooks/provider/generic/
```

Self-hosted Sentry requires its host in the Worker's `SENTRY_WEBHOOK_ALLOWED_HOSTS`.

### Control Panel

**Organization → Integrations → Sentry change tracking** is the operator's door. Paste the webhook
URL, press **Connect Sentry**, and the minted secret appears once in a copy-once panel, the same
treatment an API Key gets. The table below the form carries delivery health, a **Rotate secret**
button (mints a new secret, shown once, for when Sentry's copy is lost or compromised), and
**Disconnect**, which revokes the installation and stops delivery.

The card acts on the Organization you are looking at. One splitch Organization, one Sentry
organization.

### Install (API)

One installation binds **one splitch Organization to one Sentry organization**, and carries every
App and Environment under it. That is Sentry's shape, not a simplification of ours: Sentry keeps a
single signing secret per provider type per organization, and its flag log has no project or
environment axis, so two Environments wiring up the same Sentry organization would each mint a
secret and the second would silently invalidate the first. The Organization is in the path, never in
the body. These routes sit on the operator door beside API Keys and take Org admin, not an edge
credential.

```text
POST /orgs/:orgId/integrations/sentry/installations

{ installationId, webhookUrl, webhookSecret? }
```

`installationId` is a caller-generated UUID. Omit `webhookSecret` and the server mints one and
returns it once in `webhookSecret` on the response; supply it and the caller's value is stored
verbatim, which is what an agent rotating out of its own keystore needs. Either way the stored
secret is encrypted under `INTEGRATION_SECRET_KEK` and no read ever returns it.

An exact retry returns the existing installation. Reusing the id with a different URL, or with a
different caller-supplied secret, fails `IDEMPOTENCY_KEY_CONFLICT`. A retry that omits the secret is
never a conflict on the secret: a minted secret differs on every call by construction, so there is
nothing to compare, and the replay answers without a secret rather than inventing a second one.

`webhookUrl` must be HTTPS, on `sentry.io`/`*.sentry.io` or a configured self-hosted host, with no
credentials, port, query string, or fragment, and its path must be the
`/api/0/organizations/<org>/flags/hooks/provider/generic/` shape. This is an SSRF boundary and is
re-checked at dispatch time, not only at install: the row outlives the request.

`GET` on the collection, or on `.../installations/:installationId`, returns delivery health
(`lastDeliveredSeq`, `lastDeliveredAt`, `attemptCount`, `nextAttemptAt`, `latestDeliveryError`) and
never the secret. `DELETE` revokes and stops delivery. `POST .../installations/:installationId/
secret-rotations` replaces the signing secret, minting one when the body omits it; paste the result
back into Sentry, because Sentry keeps verifying against its own copy until you do.

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

Every Flag change under the Organization is published: App-level DEFINITION changes (create, rename,
delete, Variant edits) and per-Environment CONFIGURATION changes (`enabled`, rollout, targeting)
alike. Nothing is filtered by App or Environment, because there is nowhere in Sentry's payload to
say which one a change came from: the generic webhook accepts only `action`, `change_id`, `created_at`,
`created_by`, `flag`, and `meta.version`. A filter here would silently drop real production changes
from the one log Sentry correlates errors against, so a Flag key that exists in several Apps or
Environments shows up as several changes to the same name (ADR-0027, ADR-0036).

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
