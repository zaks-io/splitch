import { Badge } from "@splitch/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { Switch } from "@splitch/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import type { CatalogVariantView, FlagDetailView } from "#lib/flag-detail-view";
import { isLocked } from "#lib/flag-detail-view";
import { FlagDetailLock } from "./flag-detail-lock";

/**
 * The App-level definition, deliberately SECONDARY to the Environment config.
 *
 * The catalog is edited rarely, and the whole point of this sub-area is to teach
 * the "defined vs available here" distinction: existence is App-level, availability
 * is per-Environment (ADR-0028). That is why the availability control lives on the
 * catalog row, exactly where the confusion would otherwise happen.
 */
export function FlagDetailDefinition({ view }: { view: FlagDetailView }) {
  const experiment = view.controllingExperiment;

  return (
    <Card className="bg-muted/30" data-flag-definition="true">
      <CardHeader className="border-border border-b py-4">
        <CardTitle className="text-muted-foreground text-sm">
          Definition — shared across all environments
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 pt-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <Term>Flag key</Term>
            <dd className="font-mono text-foreground text-sm">{view.key}</dd>
          </div>
          <div className="grid gap-1">
            <Term>Default Variant</Term>
            <dd className="font-mono text-foreground text-sm">{view.defaultVariantName}</dd>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <Term>Value schema</Term>
            <dd className="font-mono text-foreground text-sm" data-flag-schema="true">
              {view.schema === null ? "Unconstrained" : view.schema}
            </dd>
          </div>
        </dl>

        <section className="grid gap-3" aria-label="Variant catalog">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
            Variant catalog
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead>Value</TableHead>
                {/*
                  The lock belongs to THIS column, not to the section: an Experiment
                  owns availability in the one Environment it runs in, while the
                  catalog above it is App-level and shared. Putting the marker on the
                  section header would claim the shared grain is frozen.
                */}
                <TableHead className="text-right">
                  <span className="inline-flex flex-col items-end gap-1">
                    <span>available in {view.env}</span>
                    {isLocked(view, "availability") && experiment ? (
                      <FlagDetailLock experimentName={experiment.name} />
                    ) : null}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.catalog.map((variant) => (
                <CatalogRow env={view.env} key={variant.id} variant={variant} />
              ))}
            </TableBody>
          </Table>
        </section>
      </CardContent>
    </Card>
  );
}

function CatalogRow({ env, variant }: { env: string; variant: CatalogVariantView }) {
  const state = availabilityCopy(variant.availability, env);

  return (
    <TableRow
      data-variant-availability={variant.availability}
      data-variant-name={variant.name}
      // An unavailable Variant is dimmed as well as labeled: the row itself has to
      // read as "structurally cannot serve here", not just carry small print.
      className={variant.availability === "unavailable" ? "opacity-60" : undefined}
    >
      <TableCell className="font-mono font-medium text-foreground">
        <span className="flex flex-wrap items-center gap-2">
          {variant.name}
          {variant.isDefault ? (
            <Badge variant="outline" className="font-normal text-[0.65rem]">
              Default
            </Badge>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="font-mono text-muted-foreground text-xs">{variant.value}</TableCell>
      <TableCell className="text-right">
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground text-xs leading-5">{state.label}</span>
          {/*
            Disabled, not absent: the STATE is what this read-only slice owes the
            reader, and a toggle frozen in position shows it without pretending the
            change is available here (toggling ships with the mutations slice).
          */}
          <Switch
            aria-label={state.ariaLabel}
            checked={state.checked}
            disabled
            readOnly
            size="sm"
          />
        </span>
      </TableCell>
    </TableRow>
  );
}

function availabilityCopy(
  availability: CatalogVariantView["availability"],
  env: string,
): { label: string; ariaLabel: string; checked: boolean } {
  if (availability === "available") {
    return { label: "Available", ariaLabel: `available in ${env}`, checked: true };
  }
  if (availability === "unavailable") {
    return { label: "Not available", ariaLabel: `not available in ${env}`, checked: false };
  }
  return { label: "Candidate", ariaLabel: `availability not narrowed in ${env}`, checked: true };
}

function Term({ children }: { children: React.ReactNode }) {
  return (
    <dt className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
      {children}
    </dt>
  );
}
