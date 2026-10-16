import type { AuditContext } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";

export function auditContext(
  principal: Principal,
  requestId: string,
  changedAt: string,
): AuditContext {
  return { actorRef: principal.id, actorVia: principal.authDoor, requestId, changedAt };
}
