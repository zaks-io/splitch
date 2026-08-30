import type { QueryClient } from "@tanstack/react-query";
import { Button } from "@splitch/ui/components/button";
import { StaleDataToast } from "@splitch/ui/state/stale-data-toast";
import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { LiveUpdateConnection, liveUpdateUrl } from "#lib/live-updates/live-updates";
import type { AppEnvironmentScope } from "#lib/shared/query-keys";

type LiveUpdatesClientProps = {
  readonly queryClient: QueryClient;
  readonly scope: AppEnvironmentScope & { orgSlug: string; appSlug: string; env: string };
};

export function LiveUpdatesClient({ queryClient, scope }: LiveUpdatesClientProps) {
  const router = useRouter();
  const [isStale, setIsStale] = useState(false);
  const [isToastDismissed, setIsToastDismissed] = useState(false);
  const { appId, appSlug, env, environmentId, orgSlug } = scope;

  useEffect(() => {
    const liveScope = { appId, environmentId };
    const connection = new LiveUpdateConnection({
      queryClient,
      refetchRoute: () => router.invalidate(),
      scope: liveScope,
      url: liveUpdateUrl({ appSlug, env, orgSlug }),
      onStaleDataChange: (stale) => {
        setIsStale(stale);
        if (stale) setIsToastDismissed(false);
      },
    });
    connection.start();
    return () => connection.stop();
  }, [appId, appSlug, env, environmentId, orgSlug, queryClient, router]);

  return isStale && !isToastDismissed ? (
    <StaleDataToast
      action={
        <Button onClick={() => setIsToastDismissed(true)} size="sm" variant="outline">
          Dismiss
        </Button>
      }
      description="Couldn't refresh live updates. Reconnecting..."
    />
  ) : null;
}
