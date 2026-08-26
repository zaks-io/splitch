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

export interface PushInstallationRow {
  installationId: string;
  destinationUrl: string;
  environmentVersion: number;
  syncedVersion: number | null;
  status: "active" | "revoked";
  pendingCount: number;
  oldestPendingAgeMs: number | null;
  terminalCount: number;
  latestDeliveryError: {
    code: string;
    kind: string;
    httpStatus?: number;
  } | null;
}

interface PushInstallationLabels {
  provider: "convex" | "cloudflare";
  destinationHeading: string;
  emptyMessage: string;
  syncedVersionLabel: string;
}

/**
 * Convex and Cloudflare both receive complete configuration pushes with the
 * same delivery-health vocabulary. Their cards adapt provider-specific wire
 * fields into this table instead of duplicating the operator's status model.
 */
export function PushInstallationsTable({
  rows,
  busyInstallationId,
  labels,
  onRevoke,
}: {
  rows: PushInstallationRow[];
  busyInstallationId?: string;
  labels: PushInstallationLabels;
  onRevoke: (installationId: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{labels.destinationHeading}</TableHead>
          <TableHead>Configuration sync</TableHead>
          <TableHead>Status</TableHead>
          <TableHead aria-label="Actions" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell className="text-muted-foreground" colSpan={4}>
              {labels.emptyMessage}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow
              {...installationData(labels.provider, row.installationId)}
              key={row.installationId}
            >
              <TableCell className="max-w-80 whitespace-normal">
                <code className="break-all text-xs">{row.destinationUrl}</code>
              </TableCell>
              <TableCell>
                <SyncState labels={labels} row={row} />
              </TableCell>
              <TableCell>
                <Badge variant={row.status === "active" ? "default" : "secondary"}>
                  {row.status === "active" ? "Active" : "Revoked"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  disabled={row.status !== "active" || busyInstallationId === row.installationId}
                  onClick={() => onRevoke(row.installationId)}
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

function SyncState({ row, labels }: { row: PushInstallationRow; labels: PushInstallationLabels }) {
  return (
    <div className="grid gap-1 text-xs">
      <span>
        {row.syncedVersion === null
          ? "No configuration delivered yet"
          : `${labels.syncedVersionLabel} version ${row.syncedVersion} of ${row.environmentVersion}`}
      </span>
      <span>
        {count(row.pendingCount, "pending delivery", "pending deliveries")} · Oldest pending:{" "}
        {pendingAge(row.oldestPendingAgeMs)}
      </span>
      <span>{count(row.terminalCount, "terminal delivery", "terminal deliveries")}</span>
      {row.latestDeliveryError ? (
        <span className="text-destructive">
          Latest error: {row.latestDeliveryError.code} ({row.latestDeliveryError.kind}
          {row.latestDeliveryError.httpStatus === undefined
            ? ""
            : `, HTTP ${row.latestDeliveryError.httpStatus}`}
          )
        </span>
      ) : null}
    </div>
  );
}

function count(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function pendingAge(milliseconds: number | null) {
  if (milliseconds === null) return "none";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return count(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return count(hours, "hour");
  return count(Math.floor(hours / 24), "day");
}

function installationData(provider: PushInstallationLabels["provider"], installationId: string) {
  return provider === "convex"
    ? { "data-convex-installation-id": installationId }
    : { "data-cloudflare-installation-id": installationId };
}
