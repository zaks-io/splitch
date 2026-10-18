import { envScope } from "@splitch/db";
import { requireWritableEnvironment } from "./config-store-expiry-fence";
import type { ConfigStoreRuntimeDeps } from "./config-store-types";
import { randomHex } from "./credential-cache";

export async function ensureInitialFlagConfig(
  deps: ConfigStoreRuntimeDeps,
  input: { appId: string; environmentId: string; flagId: string },
  initial: { defaultVariantId: string },
): Promise<void> {
  const now = (deps.now?.() ?? new Date()).toISOString();
  await requireWritableEnvironment(deps, input);
  await deps.repo.flags.ensureInitialFlagConfig(envScope(input.appId, input.environmentId), {
    id: `flag_config_${randomHex(12)}`,
    flagId: input.flagId,
    enabled: false,
    availableVariantNames: "[]",
    defaultVariantId: initial.defaultVariantId,
    createdAt: now,
    updatedAt: now,
  });
}
