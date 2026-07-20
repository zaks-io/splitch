import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { FlagConfigNotFoundError, loadFlagConfigByKeyRoute } from "#lib/flag-config-route";
import { AccessDeniedError } from "#lib/loader-context";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags/$flagId")({
  loader: async ({ context, location, params }) => {
    if (!context.flagConfigApi) {
      throw new Error("Control Panel Flag Configuration API is not configured");
    }

    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    try {
      await loadFlagConfigByKeyRoute({
        queryClient: context.queryClient,
        api: context.flagConfigApi,
        scope: scoped.context.scope,
        flagKey: params.flagId,
      });
    } catch (error) {
      if (error instanceof FlagConfigNotFoundError) throw notFound();
      throw error;
    }
  },
  component: () => null,
});
