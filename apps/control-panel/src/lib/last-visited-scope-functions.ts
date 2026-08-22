import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelBindings } from "./bindings";
import {
  lastVisitedEntry,
  parseLastVisitedCookie,
  recordVisit,
  serializeLastVisitedCookie,
} from "./last-visited-scope";
import { createEnvironmentResolver, rehydrateLegacySession } from "./membership";
import { loadSessionFromRequest } from "./session-refresh";

const RecordLastVisitedScopeSchema = z.object({
  orgId: z.string().min(1),
  appSlug: z.string().min(1),
  env: z.string().min(1).nullable(),
  path: z.string().regex(/^\/(?!\/)/),
});

export const recordLastVisitedScope = createServerFn({ method: "GET" })
  .validator((data: unknown) => RecordLastVisitedScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const request = getRequest();
    const { actorId } = await assertAuthorizedVisit(request, data);
    const existing = parseLastVisitedCookie(request.headers.get("cookie"), actorId);
    const next = recordVisit(
      existing,
      actorId,
      data.orgId,
      lastVisitedEntry(data.appSlug, data.env, data.path, Date.now()),
    );
    setResponseHeader("set-cookie", serializeLastVisitedCookie(next));
  });

async function assertAuthorizedVisit(
  request: Request,
  data: z.infer<typeof RecordLastVisitedScopeSchema>,
): Promise<{ actorId: string }> {
  const bindings = controlPanelBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings, request);
  if (!loaded.ok) throw new Error("Cannot record an unauthenticated App visit");

  const repo = createRepository(bindings.DB);
  const session = await rehydrateLegacySession(
    repo,
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );
  const organization = session.orgs.find((candidate) => candidate.orgId === data.orgId);
  const pathOrgSlug = data.path.split("/").filter(Boolean)[0];
  if (!organization || !pathOrgSlug || decodeURIComponent(pathOrgSlug) !== organization.orgSlug) {
    throw new Error("Cannot record a visit outside the authenticated Organization");
  }

  const app = organization.apps.find((candidate) => candidate.appSlug === data.appSlug);
  if (!app) throw new Error("Cannot record a visit to an unauthorized App");
  if (data.env === null) return { actorId: session.userId };

  const environments = await createEnvironmentResolver(repo).listEnvironments(app.appId);
  if (!environments.some((candidate) => candidate.env === data.env)) {
    throw new Error("Cannot record a visit to an unauthorized Environment");
  }
  return { actorId: session.userId };
}
