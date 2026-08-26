# splitch × Sentry

Runnable wiring for both halves of Sentry's feature-flag support. Full contract:
[docs/spec/sdk/sentry-integration.md](../../docs/spec/sdk/sentry-integration.md).

## 1. Change tracking (splitch → Sentry)

In Sentry: **Settings → Feature Flags → Change Tracking → Add provider → Generic**. Keep the signing
secret and the webhook URL it gives you.

Then bind one splitch Environment to that Sentry organization. The Environment comes from the API
Key, so use the key for the Environment whose changes that Sentry organization should hear about.

```bash
curl -X POST https://api.splitch.dev/api/integrations/sentry/installations \
  -H "Authorization: Bearer $SPLITCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "installationId": "'"$(uuidgen | tr A-Z a-z)"'",
        "webhookUrl": "https://sentry.io/api/0/organizations/<org>/flags/hooks/provider/generic/",
        "webhookSecret": "<the signing secret Sentry gave you>"
      }'
```

Toggle a Flag and it shows up in Sentry's flag audit log within a minute. Check delivery health with
`GET /api/integrations/sentry/installations/<installationId>`; it returns `lastDeliveredSeq`,
`attemptCount`, and `latestDeliveryError`, never the secret.

## 2. Evaluation tracking (app → Sentry)

```bash
pnpm install
SENTRY_DSN=... SPLITCH_CLIENT_KEY=pk_... pnpm start
```

`src/main.ts` evaluates one boolean and one multivariate Flag, then throws. The resulting Sentry
issue's **Feature Flags** section should list `new-checkout` and `checkout-flow:<variant>`.

With both halves installed, toggling a Flag shortly before an error makes Sentry surface it as a
**suspect flag** on the issue. That is the actual product outcome, and the only check that proves the
two halves are wired to each other.
