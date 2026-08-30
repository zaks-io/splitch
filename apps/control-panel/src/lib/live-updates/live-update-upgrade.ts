import type { LiveUpdateConnectionContext } from "@splitch/contracts";

interface LiveUpdateUpgradeScope {
  orgSlug: string;
  appSlug: string;
  env: string;
  orgId: string;
  appId: string;
  environmentId: string;
}

export type LiveUpdateUpgradeAuthorization =
  | { ok: true; scope: LiveUpdateUpgradeScope; context: LiveUpdateConnectionContext }
  | { ok: false; status: 401 | 403 | 404 };

export interface LiveUpdateUpgradeDeps {
  authorize(
    request: Request,
    params: Pick<LiveUpdateUpgradeScope, "orgSlug" | "appSlug" | "env">,
  ): Promise<LiveUpdateUpgradeAuthorization>;
  connect(
    scope: Pick<LiveUpdateUpgradeScope, "appId" | "environmentId">,
    request: Request,
  ): Promise<Response>;
  platformTarget?: string;
}

/** Returns null for non-live-update requests so TanStack Start remains the normal router owner. */
export async function handleLiveUpdateUpgrade(
  request: Request,
  deps: LiveUpdateUpgradeDeps,
): Promise<Response | null> {
  const parsed = parseLiveUpdatePath(request);
  if (!parsed) return null;
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected WebSocket upgrade", { status: 426 });
  }

  const url = new URL(request.url);
  if (
    (deps.platformTarget && deps.platformTarget !== "local" && url.protocol !== "https:") ||
    request.headers.get("origin") !== url.origin ||
    url.search.length > 0 ||
    request.headers.has("sec-websocket-protocol")
  ) {
    return new Response("live update upgrade rejected", { status: 403 });
  }

  const authorization = await deps.authorize(request, parsed);
  if (!authorization.ok) {
    return new Response("live update authorization required", { status: authorization.status });
  }

  const headers = new Headers({
    upgrade: "websocket",
    "x-splitch-live-update-context": JSON.stringify(authorization.context),
  });
  return deps.connect(
    {
      appId: authorization.scope.appId,
      environmentId: authorization.scope.environmentId,
    },
    new Request("https://live-update.internal/connect", { headers }),
  );
}

function parseLiveUpdatePath(
  request: Request,
): Pick<LiveUpdateUpgradeScope, "orgSlug" | "appSlug" | "env"> | null {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[3] !== "live") return null;
  try {
    const [orgSlug, appSlug, env] = segments.map((segment) => decodeURIComponent(segment));
    if (!orgSlug || !appSlug || !env) return null;
    return { orgSlug, appSlug, env };
  } catch {
    return null;
  }
}
