import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { createFileRoute } from "@tanstack/react-router";
import { reportRouteError } from "#lib/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/settings")({
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/settings");
  },
  errorComponent: () => <SectionErrorPage title="Settings unavailable" />,
  pendingComponent: PanelSkeleton,
  component: SettingsSectionRoute,
});

function SettingsSectionRoute() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">App and Environment settings surface.</p>
      </CardContent>
    </Card>
  );
}
