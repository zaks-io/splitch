import type { Repository } from "../index";
import type { SeededTenants } from "./test-seed";

export const NOW = "2026-08-25T00:00:00.000Z";
export const LATER = "2026-08-25T00:05:00.000Z";
export type DeliveryProvider = "convex" | "cloudflare";
export const DELIVERY_PROVIDERS: DeliveryProvider[] = ["convex", "cloudflare"];

export function deliveryTable(provider: DeliveryProvider) {
  return provider === "convex" ? "config_webhook_deliveries" : "cloudflare_config_deliveries";
}

export function installationTable(provider: DeliveryProvider) {
  return provider === "convex" ? "convex_installations" : "cloudflare_installations";
}

export function claim(
  repo: Repository,
  provider: DeliveryProvider,
  owner: string,
  limit = 25,
  now = NOW,
  expires = LATER,
) {
  return repo[provider].claimDueDeliveries(now, owner, expires, limit);
}

export async function insertInstallation(
  d1: D1Database,
  seed: SeededTenants,
  provider: DeliveryProvider,
  id: string,
  tenant: "a" | "b" = "a",
) {
  const endpointColumn = provider === "convex" ? "callback_url" : "endpoint";
  const { appId, environmentId } = seed[tenant];
  await d1
    .prepare(`INSERT INTO ${installationTable(provider)} (
      installation_id, app_id, environment_id, ${endpointColumn}, secret_ciphertext,
      secret_key_version, secret_fingerprint, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'cipher_old', 'v1', 'fingerprint', 'active', ?, ?)`)
    .bind(id, appId, environmentId, "https://receiver.example/configuration", NOW, NOW)
    .run();
}

export async function insertDelivery(
  d1: D1Database,
  seed: SeededTenants,
  provider: DeliveryProvider,
  installationId: string,
  version = 1,
  nextAttemptAt = NOW,
) {
  const deliveryId = `${installationId}_${version}`;
  const bodyJson = JSON.stringify({ deliveryId, environmentVersion: version });
  const convexColumn = provider === "convex" ? ", body_json" : "";
  const convexValue = provider === "convex" ? ", ?" : "";
  const values = [
    deliveryId,
    installationId,
    seed.a.appId,
    seed.a.environmentId,
    version,
    nextAttemptAt,
    NOW,
    ...(provider === "convex" ? [bodyJson] : []),
  ];
  await d1
    .prepare(`INSERT INTO ${deliveryTable(provider)} (
      delivery_id, installation_id, app_id, environment_id, environment_version,
      state, next_attempt_at, created_at${convexColumn}
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?${convexValue})`)
    .bind(...values)
    .run();
  return { deliveryId, bodyJson };
}

export async function insertDeliveries(
  d1: D1Database,
  seed: SeededTenants,
  provider: DeliveryProvider,
  count: number,
) {
  for (let index = 0; index < count; index += 1) {
    const installationId = `installation_${index.toString().padStart(3, "0")}`;
    await insertInstallation(d1, seed, provider, installationId);
    await insertDelivery(d1, seed, provider, installationId);
  }
}

export function observeD1(d1: D1Database) {
  const batches: number[] = [];
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let directCalls = 0;
  function watchStatement(
    statement: D1PreparedStatement,
    query: { sql: string; values: unknown[] },
  ): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind")
          return (...values: unknown[]) => {
            query.values = values;
            return watchStatement(target.bind(...values), query);
          };
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "run" || property === "all" || property === "first" || property === "raw")
          return (...values: unknown[]) => {
            directCalls += 1;
            return Reflect.apply(value, target, values);
          };
        return value.bind(target);
      },
    });
  }
  const database = new Proxy(d1, {
    get(target, property, receiver) {
      if (property === "prepare")
        return (sql: string) => {
          const query = { sql, values: [] as unknown[] };
          queries.push(query);
          return watchStatement(target.prepare(sql), query);
        };
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          batches.push(statements.length);
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, batches, queries, directCalls: () => directCalls };
}
