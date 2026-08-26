import type { SentryInstallationStatus } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";

/**
 * Every installation this Environment has had, revoked ones included: a revoked
 * row is the record of where Flag changes used to be published, and dropping it
 * would make a disconnected Sentry organization look like one that was never
 * connected.
 *
 * Same table treatment as API Keys, because it is the same kind of object: a
 * credential-bearing binding with a status and a revoke action.
 */
export function SentryInstallationsTable({
  installations,
  busyInstallationId,
  onRotate,
  onRevoke,
}: {
  installations: SentryInstallationStatus[];
  busyInstallationId?: string;
  onRotate: (installationId: string) => void;
  onRevoke: (installationId: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Sentry endpoint</TableHead>
          <TableHead>Delivery</TableHead>
          <TableHead>Status</TableHead>
          <TableHead aria-label="Actions" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {installations.length === 0 ? (
          <TableRow>
            <TableCell className="text-muted-foreground" colSpan={4}>
              This Environment does not publish Flag changes to Sentry.
            </TableCell>
          </TableRow>
        ) : (
          installations.map((installation) => (
            <TableRow
              data-sentry-installation-id={installation.installationId}
              key={installation.installationId}
            >
              <TableCell className="max-w-80 whitespace-normal">
                <code className="break-all text-xs">{installation.webhookUrl}</code>
              </TableCell>
              <TableCell>
                <DeliveryCell installation={installation} />
              </TableCell>
              <TableCell>
                <Badge variant={installation.status === "active" ? "default" : "secondary"}>
                  {installation.status === "active" ? "Active" : "Revoked"}
                </Badge>
              </TableCell>
              <TableCell className="space-x-2 text-right">
                <Button
                  disabled={
                    installation.status !== "active" ||
                    busyInstallationId === installation.installationId
                  }
                  onClick={() => onRotate(installation.installationId)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Rotate secret
                </Button>
                <Button
                  disabled={
                    installation.status !== "active" ||
                    busyInstallationId === installation.installationId
                  }
                  onClick={() => onRevoke(installation.installationId)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  Disconnect
                </Button>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function DeliveryCell({ installation }: { installation: SentryInstallationStatus }) {
  const { lastDeliveredSeq, lastDeliveredAt, attemptCount, latestDeliveryError } = installation;
  return (
    <div className="grid gap-1 text-xs">
      <span>
        {lastDeliveredAt === null
          ? "No changes delivered yet"
          : `Change ${lastDeliveredSeq} at ${lastDeliveredAt.slice(0, 19).replace("T", " ")}`}
      </span>
      {latestDeliveryError ? (
        <span className="text-destructive">
          {describeDeliveryError(latestDeliveryError)} · {attemptCount} failed{" "}
          {attemptCount === 1 ? "attempt" : "attempts"}
        </span>
      ) : null}
    </div>
  );
}

function describeDeliveryError(
  error: NonNullable<SentryInstallationStatus["latestDeliveryError"]>,
) {
  if (error.code === "HTTP_STATUS") return `Sentry answered HTTP ${error.httpStatus}`;
  if (error.code === "CONNECT_FAILED") return "Could not reach Sentry";
  return "Sentry rejected the webhook URL";
}
