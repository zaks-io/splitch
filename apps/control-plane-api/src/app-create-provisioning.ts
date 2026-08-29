import { appScope, type TenantScope } from "@splitch/db";
import {
  ALLOW_POLICY,
  type AppEnvironmentDeps,
  type AppRow,
  CONFIRM_POLICY,
  createEnvironmentRecord,
  type EnvironmentRow,
  nowIso,
  provisionEnvironmentClientKeys,
} from "./app-environment-model";
import { mutateMembershipWithCacheInvalidation } from "./membership-cache";

export async function provisionAppCreateState(
  deps: AppEnvironmentDeps,
  app: AppRow,
  actorId: string,
) {
  const scope = appScope(app.id);
  await ensureOwnerMembership(deps, scope, actorId);
  const dev = await ensureEnvironment(deps, scope, app.id, "dev", "Dev", actorId);
  const prod = await ensureEnvironment(deps, scope, app.id, "prod", "Prod", actorId);
  const clientKeys = await provisionEnvironmentClientKeys(deps, app.id, app.organizationId, [
    dev,
    prod,
  ]);
  return { dev, prod, clientKeys };
}

async function ensureOwnerMembership(
  deps: AppEnvironmentDeps,
  scope: TenantScope,
  actorId: string,
): Promise<void> {
  if (await deps.repo.identity.getAppMembership(scope, actorId)) return;
  await mutateMembershipWithCacheInvalidation(deps.membershipCache, [actorId], () =>
    deps.repo.identity
      .createAppMembership(scope, {
        userId: actorId,
        role: "owner",
        createdAt: nowIso(deps),
      })
      .catch(async (cause) => {
        if (!(await deps.repo.identity.getAppMembership(scope, actorId))) throw cause;
      }),
  );
}

async function ensureEnvironment(
  deps: AppEnvironmentDeps,
  scope: TenantScope,
  appId: string,
  key: "dev" | "prod",
  name: "Dev" | "Prod",
  actorId: string,
): Promise<EnvironmentRow> {
  const existing = (await deps.repo.identity.listEnvironments(scope)).find(
    (environment) => environment.key === key,
  );
  if (existing) return existing;
  try {
    return await createEnvironmentRecord(deps, scope, appId, {
      key,
      name,
      policy: key === "dev" ? ALLOW_POLICY : CONFIRM_POLICY,
      actorId,
    });
  } catch (cause) {
    const winner = (await deps.repo.identity.listEnvironments(scope)).find(
      (environment) => environment.key === key,
    );
    if (winner) return winner;
    throw cause;
  }
}
