import type { PanelAppFlagCatalog } from "@splitch/control-plane-sdk/panel-app-settings";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Badge } from "@splitch/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";

/**
 * Flag definitions and their Variant catalogs, which are App-level: a Flag has
 * the same Variants in every Environment, and only its Configuration differs.
 *
 * Read-only on purpose. Editing a Variant belongs on Flag detail, next to the
 * Configuration it changes the meaning of; a second editor here would be a
 * second way to do one thing.
 */
export function AppCatalogCard({
  catalog,
  scopeHref,
}: {
  catalog: PanelAppFlagCatalog;
  scopeHref: string;
}) {
  return (
    <Card data-testid="app-catalog-card">
      <CardHeader>
        <CardTitle>Flags and Variants</CardTitle>
        <CardDescription>
          Defined once for the App and identical in every Environment. Edit a Variant on the Flag
          itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {catalog.readTruncated ? (
          <Alert data-testid="app-catalog-truncated">
            <AlertTitle>More than {catalog.readLimit} Flags in this App</AlertTitle>
            <AlertDescription>
              This card reads at most {catalog.readLimit} Flags at once, and this App has more. The{" "}
              {catalog.items.length} below are not all of them.
            </AlertDescription>
          </Alert>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Flag</TableHead>
              <TableHead>Variants</TableHead>
              <TableHead>Default</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalog.items.length === 0 ? (
              <TableRow>
                <TableCell className="text-muted-foreground" colSpan={3}>
                  No Flags defined in this App yet.
                </TableCell>
              </TableRow>
            ) : (
              catalog.items.map((flag) => (
                <TableRow data-app-catalog-flag={flag.key} key={flag.id}>
                  <TableCell>
                    <a
                      className="font-medium underline underline-offset-4 hover:no-underline"
                      href={`${scopeHref}/flags/${encodeURIComponent(flag.key)}`}
                    >
                      {flag.name}
                    </a>
                    <span className="mt-1 block text-muted-foreground text-xs">
                      <code>{flag.key}</code>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-96 whitespace-normal">
                    <span className="flex flex-wrap gap-1">
                      {flag.variants.map((variant) => (
                        <Badge key={variant.id} variant="outline">
                          {variant.name}
                          <span className="ml-1 font-mono text-muted-foreground">
                            {variant.value}
                          </span>
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    {flag.defaultVariantName ?? (
                      <span className="text-destructive" data-testid="flag-default-unresolved">
                        Default Variant missing from this catalog
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <p className="text-muted-foreground text-xs">
          {catalog.items.length} {catalog.items.length === 1 ? "Flag" : "Flags"} shown.
        </p>
      </CardContent>
    </Card>
  );
}
