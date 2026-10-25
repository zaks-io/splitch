import { env, runInDurableObject } from "cloudflare:test";
import { createRepository, envScope } from "@splitch/db";
import { encryptConvexSecret } from "../src/convex-secret";
import { integrationDeliveryName } from "../src/integration-delivery-access";
import { encryptIntegrationSecret } from "../src/integration-secret";
import { resetDueWork } from "../src/scheduled-due-work-fixtures";
import { seedEnvironment } from "../src/test-seeds";

export const appId = "app_probe";
export const environmentA = "env_probe";
export const environmentB = "env_healthy";
export const repo = () => createRepository(env.DB);
export const coordinator = (environmentId: string) =>
  env.INTEGRATION_DELIVERY.getByName(integrationDeliveryName(appId, environmentId));

export async function setupDelivery() {
  await resetDueWork(env.DB);
  await seedEnvironment(env.DB, { appId, environmentId: environmentB, key: "healthy" });
  for (const environmentId of [environmentA, environmentB]) {
    await runInDurableObject(coordinator(environmentId), async (_instance, ctx) =>
      ctx.storage.deleteAll(),
    );
  }
}

export async function install(
  provider: "convex" | "cloudflare",
  id: string,
  environmentId: string,
) {
  const now = new Date().toISOString();
  const secret =
    provider === "convex"
      ? await encryptConvexSecret("synthetic-callback-secret", env.CONVEX_WEBHOOK_KEK, "v1")
      : await encryptIntegrationSecret(
          "synthetic-push-secret",
          env.INTEGRATION_SECRET_KEK,
          "v1",
          "INTEGRATION_SECRET_KEK",
        );
  const common = {
    installationId: id,
    secretCiphertext: secret.ciphertext,
    secretKeyVersion: secret.keyVersion,
    secretFingerprint: secret.fingerprint,
    now,
  };
  const scope = envScope(appId, environmentId);
  if (provider === "convex") {
    await repo().convex.createInstallation(scope, {
      ...common,
      callbackUrl: `https://${id}.convex.site/configuration`,
    });
  } else {
    await repo().cloudflare.createInstallation(scope, {
      ...common,
      endpoint: `https://${id}.workers.dev/integrations/splitch/configuration`,
    });
    await env.DB.prepare(
      "UPDATE cloudflare_installations SET last_applied_version = 0 WHERE installation_id = ?",
    )
      .bind(id)
      .run();
  }
}

export async function bump(environmentId: string) {
  await env.DB.prepare(
    "UPDATE environments SET config_version = config_version + 1 WHERE id = ? AND app_id = ?",
  )
    .bind(environmentId, appId)
    .run();
}

export async function alarmAt(environmentId: string) {
  return runInDurableObject(coordinator(environmentId), (_instance, ctx) => ctx.storage.getAlarm());
}
