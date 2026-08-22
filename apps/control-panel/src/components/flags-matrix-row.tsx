import { Badge } from "@splitch/ui/components/badge";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import { Link } from "@tanstack/react-router";
import { scopedHref } from "#lib/app-shell-navigation";
import {
  classifyDrift,
  type DriftKind,
  type FlagsMatrixRow as MatrixRow,
} from "#lib/flags-matrix-data";
import { promotionPair } from "#lib/promotion-source";
import { FlagsMatrixCell } from "./flags-matrix-cell";

type MatrixEnvironment = {
  environmentId: string;
  env: string;
};

export function FlagsMatrixRow({
  appId,
  appSlug,
  created,
  delegationEnvironment,
  environments,
  orgSlug,
  row,
}: {
  appId: string;
  appSlug: string;
  created: boolean;
  delegationEnvironment: MatrixEnvironment;
  environments: readonly MatrixEnvironment[];
  orgSlug: string;
  row: MatrixRow;
}) {
  const pair = promotionPair(environments);
  const definitionHref = detailHref(
    orgSlug,
    appSlug,
    delegationEnvironment.env,
    row.definition.key,
  );

  return (
    <TableRow
      className={created ? "bg-primary/5" : undefined}
      data-flag-created={created ? "true" : undefined}
      data-flag-key={row.definition.key}
    >
      <TableCell className="px-4 align-top">
        <Link className="font-mono font-medium underline underline-offset-4" to={definitionHref}>
          {row.definition.key}
        </Link>
        <p className="mt-1 text-muted-foreground text-xs">{row.definition.variantCount} Variants</p>
      </TableCell>
      {environments.map((environment) => (
        <TableCell className="align-top" key={environment.environmentId}>
          <FlagsMatrixCell
            appId={appId}
            cell={matrixCell(row, environment.environmentId)}
            definition={row.definition}
            detailHref={detailHref(orgSlug, appSlug, environment.env, row.definition.key)}
            env={environment.env}
            environmentId={environment.environmentId}
          />
        </TableCell>
      ))}
      {pair ? (
        <TableCell className="pr-4 align-top">
          {renderDriftOutcome({
            appSlug,
            flagKey: row.definition.key,
            kind: classifyDrift(
              matrixCell(row, pair.source.environmentId),
              matrixCell(row, pair.target.environmentId),
            ),
            orgSlug,
            source: pair.source,
            sourceConfigured: matrixCell(row, pair.source.environmentId) !== null,
            target: pair.target,
          })}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function renderDriftOutcome({
  appSlug,
  flagKey,
  kind,
  orgSlug,
  source,
  sourceConfigured,
  target,
}: {
  appSlug: string;
  flagKey: string;
  kind: DriftKind;
  orgSlug: string;
  source: MatrixEnvironment;
  sourceConfigured: boolean;
  target: MatrixEnvironment;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {driftBadge(kind, source.env, target.env)}
      {sourceConfigured ? (
        <Link
          className="text-sm underline underline-offset-4"
          data-flag-promote-entry
          to={
            `${scopedHref({ orgSlug, appSlug, env: target.env })}/flags/${encodeURIComponent(flagKey)}/promote?from=${encodeURIComponent(source.env)}` as never
          }
        >
          Promote
        </Link>
      ) : null}
    </div>
  );
}

function matrixCell(row: MatrixRow, environmentId: string) {
  if (!(environmentId in row.cells)) {
    throw new Error(`Flags matrix row is missing Environment ${environmentId}`);
  }
  return row.cells[environmentId] as MatrixRow["cells"][string];
}

function driftBadge(kind: DriftKind, source: string, target: string) {
  if (kind === "unconfigured") return null;
  if (kind === "in-sync") return <Badge variant="secondary">In sync</Badge>;
  const copy = {
    "enabled-differs": "Enabled differs",
    "availability-differs": "Availability differs",
    "rollout-differs": "Rollout differs",
    "missing-in-target": `Missing in ${target}`,
    "missing-in-source": `Missing in ${source}`,
  }[kind];
  return <Badge variant="outline">{copy}</Badge>;
}

function detailHref(orgSlug: string, appSlug: string, env: string, flagKey: string): string {
  return `${scopedHref({ orgSlug, appSlug, env })}/flags/${encodeURIComponent(flagKey)}`;
}
