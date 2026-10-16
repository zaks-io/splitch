import type { AuditContext } from "@splitch/db";
import {
  type ClientKeyContext,
  type ClientKeyDeps,
  type ClientKeyRow,
  findActiveClientKey,
  newClientKey,
} from "./client-key-provisioning";
import { writeClientKeyCache } from "./credential-cache";

export async function updateClientKey(
  deps: ClientKeyDeps,
  ctx: ClientKeyContext,
  updates: Partial<ClientKeyRow>,
  audit: AuditContext,
): Promise<ClientKeyRow | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await findActiveClientKey(deps, ctx);
    if (unchangedClientKey(current, updates)) {
      await writeClientKeyCache(deps, current, false, ctx.organizationId, true);
      return current;
    }
    const key = current ?? newClientKey(deps, ctx);
    const updated = await deps.repo.credentials.updateClientKey(
      ctx.scope,
      key.keyId,
      updates,
      audit,
      current ? undefined : key,
    );
    if (updated) {
      await writeClientKeyCache(deps, updated, false, ctx.organizationId, true);
      return updated;
    }
    // Only a lost provisioning race can retry. An audit failure throws and
    // rolls back the whole batch, before any credential reaches the cache.
    if (current) return null;
  }
  return null;
}

export async function rotateClientKey(
  deps: ClientKeyDeps,
  ctx: ClientKeyContext,
  audit: AuditContext,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await findActiveClientKey(deps, ctx);
    const key = current ?? newClientKey(deps, ctx);
    const rotated = await deps.repo.credentials.rotateClientKey(
      ctx.scope,
      key.keyId,
      { ...newClientKey(deps, ctx), createdAt: audit.changedAt },
      audit,
      current ? undefined : key,
    );
    if (rotated) {
      await writeClientKeyCache(deps, rotated.revoked, true, ctx.organizationId, true);
      await writeClientKeyCache(deps, rotated.created, false, ctx.organizationId, true);
      return rotated;
    }
    if (current) return null;
  }
  return null;
}

function unchangedClientKey(
  current: ClientKeyRow | null,
  updates: Partial<ClientKeyRow>,
): current is ClientKeyRow {
  return (
    current !== null &&
    Object.entries(updates).every(
      ([field, value]) => current[field as keyof ClientKeyRow] === value,
    )
  );
}
