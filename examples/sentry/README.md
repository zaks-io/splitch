# splitch × Sentry

Runnable wiring for both halves of Sentry's feature-flag support. Full contract:
[docs/spec/sdk/sentry-integration.md](../../docs/spec/sdk/sentry-integration.md).

## 1. Change tracking (splitch → Sentry)

In Sentry: **Settings → Feature Flags → Change Tracking → Add provider → Generic**. Copy the webhook
URL it shows you; leave the Secret field for later, because splitch mints that side.

The fastest path is the Control Panel: open the Environment whose changes that Sentry organization
should hear about, go to **Settings**, and use the **Sentry change tracking** card. Paste the webhook
URL, press Connect Sentry, and paste the secret it returns back into Sentry's Secret field. The
secret is shown once.

The same install over the API, for an agent or a script:

```bash
curl -X POST "https://api.splitch.dev/apps/$SPLITCH_APP_ID/envs/$SPLITCH_ENVIRONMENT_ID/integrations/sentry/installations" \
  -H "Authorization: Bearer $SPLITCH_CONTROL_PLANE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "installationId": "'"$(uuidgen | tr A-Z a-z)"'",
        "webhookUrl": "https://sentry.io/api/0/organizations/<org>/flags/hooks/provider/generic/"
      }'
```

The Environment is in the path, so one installation binds one Environment to one Sentry
organization. Omitting `webhookSecret` is what makes the server mint one and return it once on the
response; supply your own instead if you are rotating out of your own keystore.

Toggle a Flag and it shows up in Sentry's flag audit log within a minute. Check delivery health with
`GET /apps/<appId>/envs/<environmentId>/integrations/sentry/installations`; it returns
`lastDeliveredSeq`, `attemptCount`, and `latestDeliveryError`, never the secret.

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
