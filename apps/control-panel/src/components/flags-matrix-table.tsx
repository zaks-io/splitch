import { Card, CardContent } from "@splitch/ui/components/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@splitch/ui/components/table";
import type { FlagsMatrixData } from "#lib/flags-matrix-data";
import { promotionPair } from "#lib/promotion-source";
import { EnvironmentWarningDot } from "./environment-warning-dot";
import { FlagsMatrixRow } from "./flags-matrix-row";

type MatrixEnvironment = {
  environmentId: string;
  env: string;
  guarded: boolean;
};

export function FlagsMatrixTable({
  appId,
  appSlug,
  createdKey,
  delegationEnvironment,
  environments,
  matrix,
  orgSlug,
}: {
  appId: string;
  appSlug: string;
  createdKey?: string;
  delegationEnvironment: MatrixEnvironment;
  environments: readonly MatrixEnvironment[];
  matrix: FlagsMatrixData;
  orgSlug: string;
}) {
  const pair = promotionPair(environments);

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Flag</TableHead>
              {environments.map((environment) => (
                <TableHead key={environment.environmentId}>
                  <span className="inline-flex items-center gap-1.5">
                    {environment.guarded ? <EnvironmentWarningDot /> : null}
                    <span title={environment.guarded ? "Policy confirms changes" : undefined}>
                      {environment.env}
                    </span>
                  </span>
                </TableHead>
              ))}
              {pair ? (
                <TableHead className="pr-4">{`${pair.source.env} → ${pair.target.env}`}</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {matrix.rows.map((row) => (
              <FlagsMatrixRow
                appId={appId}
                appSlug={appSlug}
                created={row.definition.key === createdKey}
                delegationEnvironment={delegationEnvironment}
                environments={environments}
                key={row.definition.id}
                orgSlug={orgSlug}
                row={row}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
