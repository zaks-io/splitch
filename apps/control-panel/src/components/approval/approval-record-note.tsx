import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Badge } from "@splitch/ui/components/badge";
import type { ApprovalGateRecord } from "#lib/approval-gate-record";

/**
 * The durable audit record a gated change wrote.
 *
 * Under `confirm` the gate is one interaction for the operator, but the Worker
 * still writes a real, self-reviewed Approval Request. Surfacing its id is the
 * whole point: the operator must be able to find later what they approved, and a
 * silent one-click apply would leave that record invisible.
 *
 * It prints the id rather than linking it. The Approval Request screen does not
 * exist yet (SPL-151), and a link to nowhere is an impossible remedy.
 */
export function ApprovalRecordNote({ request }: { request: ApprovalGateRecord }) {
  return (
    <Alert data-approval-record={request.id}>
      <AlertTitle>Recorded as an Approval Request</AlertTitle>
      <AlertDescription className="grid gap-2">
        <p className="flex flex-wrap items-center gap-2 leading-6">
          <span className="font-mono text-xs">{request.id}</span>
          <Badge variant="outline" className="font-mono text-[0.65rem] uppercase tracking-[0.14em]">
            {request.status}
          </Badge>
        </p>
        <p className="text-xs leading-5">
          {request.operation} on {request.targetType}, proposed by {request.proposerUserId} at{" "}
          {request.proposedAt}.
        </p>
      </AlertDescription>
    </Alert>
  );
}
