import { appScope } from "@splitch/db";
import { catchConfigStoreFailure } from "./config-store-failure";
import type { ConfigStoreRuntimeDeps } from "./config-store-types";

export type EnvironmentWriteFailure =
  | { ok: false; reason: "ENVIRONMENT_EXPIRED"; expiredAt: string }
  | { ok: false; reason: "ENVIRONMENT_NOT_FOUND" };

export interface EnvironmentWriteScope {
  appId: string;
  environmentId: string;
}

class EnvironmentWriteRefusedError extends Error {
  constructor(readonly failure: EnvironmentWriteFailure) {
    super(`config-store: ${failure.reason}`);
    this.name = "EnvironmentWriteRefusedError";
  }
}

export function runEnvironmentMutation<T>(
  deps: ConfigStoreRuntimeDeps,
  input: EnvironmentWriteScope,
  operation: () => Promise<T>,
) {
  return deps.snapshotMutations.run(async () => {
    try {
      const refused = await environmentWriteFailure(deps, input);
      return refused ?? (await catchConfigStoreFailure(deps, operation));
    } catch (cause) {
      if (cause instanceof EnvironmentWriteRefusedError) return cause.failure;
      throw cause;
    }
  });
}

export async function requireWritableEnvironment(
  deps: ConfigStoreRuntimeDeps,
  input: EnvironmentWriteScope,
): Promise<void> {
  const failure = await environmentWriteFailure(deps, input);
  if (failure) throw new EnvironmentWriteRefusedError(failure);
}

/** Called inside the writer queue, including immediately before a publication. */
export async function environmentWriteFailure(
  deps: ConfigStoreRuntimeDeps,
  input: EnvironmentWriteScope,
): Promise<EnvironmentWriteFailure | null> {
  // A failed D1 read must not retain a previously selected publication adapter.
  deps.observeEnvironment(null);
  const environment = await deps.repo.identity.getEnvironment(
    appScope(input.appId),
    input.environmentId,
  );
  if (!environment) return { ok: false, reason: "ENVIRONMENT_NOT_FOUND" };
  if (environment.expiresAt !== null && !Number.isFinite(Date.parse(environment.expiresAt))) {
    throw new Error("config-store: invalid Environment expiry");
  }
  deps.observeEnvironment(environment);
  if (
    environment.expiresAt !== null &&
    Date.parse(environment.expiresAt) <= (deps.now?.() ?? new Date()).getTime()
  ) {
    return { ok: false, reason: "ENVIRONMENT_EXPIRED", expiredAt: environment.expiresAt };
  }
  return null;
}
