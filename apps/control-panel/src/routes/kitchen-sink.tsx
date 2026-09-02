import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@splitch/ui/components/dialog";
import { Input } from "@splitch/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { Separator } from "@splitch/ui/components/separator";
import { Skeleton } from "@splitch/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@splitch/ui/components/tooltip";
import { Grid } from "@splitch/ui/layout/grid";
import { PageShell } from "@splitch/ui/layout/page-shell";
import { AppErrorPage } from "@splitch/ui/state/app-error-page";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { StaleDataToast } from "@splitch/ui/state/stale-data-toast";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { KitchenSinkForms } from "#components/development/kitchen-sink-forms";
import { KitchenSinkOverlays } from "#components/development/kitchen-sink-overlays";
import { loginRedirect } from "#lib/auth/login-redirect";
import { loadCurrentSession } from "#lib/sessions/session-functions";
import { documentTitle } from "#lib/shell/document-title";

type ThemeMode = "system" | "light" | "dark";

export const Route = createFileRoute("/kitchen-sink")({
  head: () => ({ meta: [{ title: documentTitle("Kitchen sink") }] }),
  loader: async ({ location }) => {
    const result = await loadCurrentSession();
    if (result.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    return result.session;
  },
  component: KitchenSinkRoute,
});

function KitchenSinkRoute() {
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");

  useEffect(() => {
    if (themeMode === "system") {
      document.documentElement.removeAttribute("data-theme");
      return;
    }

    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  return (
    <PageShell data-testid="kitchen-sink" size="lg">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            UI system
          </p>
          <h1 className="font-semibold text-3xl text-foreground">Kitchen sink</h1>
          <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
            Shared primitives rendered against the semantic token layer.
          </p>
        </div>

        <fieldset className="flex rounded-lg border border-border bg-card p-1">
          <legend className="sr-only">Theme</legend>
          {(["system", "light", "dark"] as const).map((mode) => (
            <Button
              aria-pressed={themeMode === mode}
              data-theme-mode={mode}
              key={mode}
              onClick={() => setThemeMode(mode)}
              size="sm"
              type="button"
              variant={themeMode === mode ? "default" : "ghost"}
            >
              {mode}
            </Button>
          ))}
        </fieldset>
      </section>

      <Grid columns="2" gap="6">
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
            <CardDescription>Button, Badge, Tooltip, Dialog, and Alert.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="destructive">Destructive</Badge>
            </div>

            <div className="flex flex-wrap gap-2">
              <Tooltip>
                <TooltipTrigger render={<Button variant="outline" />}>Tooltip</TooltipTrigger>
                <TooltipContent>Reusable tooltip surface</TooltipContent>
              </Tooltip>

              <Dialog>
                <DialogTrigger render={<Button variant="outline" />}>Dialog</DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Dialog title</DialogTitle>
                    <DialogDescription>
                      Modal content inherits the same semantic role tokens.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter showCloseButton>
                    <Button>Confirm</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            <Alert>
              <AlertTitle>Neutral alert</AlertTitle>
              <AlertDescription>Border, text, and card color come from roles.</AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Inputs</CardTitle>
            <CardDescription>Form controls and select surface.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <label className="grid gap-2" htmlFor="demo-name">
              <span className="font-medium text-sm">Name</span>
              <Input id="demo-name" placeholder="service-key" />
            </label>

            <div className="grid gap-2">
              <span className="font-medium text-sm" id="demo-mode-label">
                Mode
              </span>
              <Select defaultValue="balanced">
                <SelectTrigger aria-labelledby="demo-mode-label">
                  <SelectValue placeholder="Choose mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="strict">Strict</SelectItem>
                  <SelectItem value="quiet">Quiet</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <StaleDataToast />
          </CardContent>
        </Card>
      </Grid>

      <Card>
        <CardHeader>
          <CardTitle>Split signature</CardTitle>
          <CardDescription>Control and Treatment arm tokens keep their assignment.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid overflow-hidden rounded-full border border-border sm:grid-cols-2">
            <div className="bg-arm-control px-4 py-3 font-medium text-arm-control-contrast">
              Control
            </div>
            <div className="bg-arm-treatment px-4 py-3 font-medium text-arm-treatment-contrast">
              Treatment
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-success-muted p-3 text-success-foreground">
              Success surface
            </div>
            <div className="rounded-lg border border-border bg-warning-muted p-3 text-warning-foreground">
              Warning surface
            </div>
            <div className="rounded-lg border border-border bg-destructive/10 p-3 text-destructive">
              Destructive surface
            </div>
          </div>
        </CardContent>
      </Card>

      <Grid columns="2" gap="6">
        <Card>
          <CardHeader>
            <CardTitle>Table</CardTitle>
            <CardDescription>
              Dense data surface with semantic hover and border roles.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-mono">alpha.route</TableCell>
                  <TableCell>
                    <Badge variant="secondary">Ready</Badge>
                  </TableCell>
                  <TableCell>2m ago</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-mono">beta.route</TableCell>
                  <TableCell>
                    <Badge variant="outline">Draft</Badge>
                  </TableCell>
                  <TableCell>9m ago</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Loading</CardTitle>
            <CardDescription>Named skeleton surfaces for common content shapes.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Skeleton className="h-16" />
            <PanelSkeleton />
            <TableSkeleton />
          </CardContent>
        </Card>
      </Grid>

      <KitchenSinkForms />
      <KitchenSinkOverlays />

      <Grid columns="2" gap="6">
        <EmptyState
          action={<Button size="sm">Create</Button>}
          description="A generic empty state with caller-supplied copy and action."
          title="Nothing here yet"
        />

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <AppErrorPage className="min-h-0 p-0" />
        </div>
      </Grid>
    </PageShell>
  );
}
