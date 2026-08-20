import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";
import type { HoldoverWriteAppDeletionCancelStep } from "./holdover-write-app-deletion-saga-cancel";
import type { HoldoverWriteAppDeletionFinalizeStep } from "./holdover-write-app-deletion-saga-finalize";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

export async function resumeAppDeletionEntityAlarms(
  namespace: HoldoverWriteOutboxNamespace | undefined,
  step: HoldoverWriteAppDeletionCancelStep,
): Promise<void> {
  const response = await entityStub(namespace, step.appId, step.entity).fetch(
    "https://holdover-write-outbox.local/resume-alarms",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  if (!response.ok) {
    throw new Error(`holdover write outbox /resume-alarms failed: HTTP ${String(response.status)}`);
  }
}

export async function purgeAppDeletionEntityOutbox(
  namespace: HoldoverWriteOutboxNamespace | undefined,
  step: HoldoverWriteAppDeletionFinalizeStep,
): Promise<void> {
  const response = await entityStub(namespace, step.appId, step.entity).fetch(
    "https://holdover-write-outbox.local/purge",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  if (!response.ok) {
    throw new Error(`holdover write outbox /purge failed: HTTP ${String(response.status)}`);
  }
}

function entityStub(
  namespace: HoldoverWriteOutboxNamespace | undefined,
  appId: string,
  entity: { readonly idType: string; readonly targetingKeyHash: string },
) {
  if (!namespace) throw new Error("HOLDOVER_WRITE_OUTBOX is required for App deletion recovery");
  return namespace.get(namespace.idFromName(holdoverWriteOutboxName({ appId, ...entity })));
}
