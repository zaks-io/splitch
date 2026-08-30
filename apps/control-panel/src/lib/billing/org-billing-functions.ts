import { env as workerEnv } from "cloudflare:workers";
import { createRepository, type Repository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ControlPanelBindings, controlPanelBindings } from "#lib/shared/bindings";
import type { ControlPanelActor } from "#lib/shared/control-plane-apps";
import { createControlPanelUsageClient } from "#lib/billing/control-plane-usage";
import { createEnvironmentResolver, rehydrateLegacySession } from "#lib/sessions/membership";
import {
  type OrgBillingView,
  type OrgUsage,
  toUsageDimensions,
  type UsageNames,
} from "#lib/billing/org-billing";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";

export type OrgBillingResult =
  | { kind: "ok"; view: OrgBillingView }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

/**
 * The Billing & Usage read: this Organization's current-month Evaluation
 * consumption plus the plan row behind the payment stub.
 *
 * `bindings`/`request` are explicit parameters (rather than read internally from
 * `workerEnv`/`getRequest()`) so this can be called directly in a test against
 * real Miniflare D1 + KV, matching `loadOrgAppListForRequest`.
 */
export async function loadOrgBillingForRequest(
  bindings: ControlPanelBindings,
  request: Request,
  orgSlug: string,
): Promise<OrgBillingResult> {
  const loaded = await loadSessionFromRequest(bindings, request);
  if (!loaded.ok) return { kind: "unauthenticated" };

  const repo = createRepository(bindings.DB);
  const session = await rehydrateLegacySession(
    repo,
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );
  const membership = session.orgs.find((org) => org.orgSlug === orgSlug);
  if (!membership) return { kind: "forbidden" };

  const organization = await repo.identity.getOrg(membership.orgId);
  // The session says this Organization exists and names this actor a member, so
  // a missing row is a broken invariant rather than a display case.
  if (!organization) {
    throw new Error("the Organization in this session has no record");
  }

  const usage = await readUsage(bindings, membership.orgId, {
    actorId: session.userId,
    sessionExpiresAt: loaded.session.expiresAt,
  });

  return {
    kind: "ok",
    view: {
      orgSlug: membership.orgSlug,
      orgRole: membership.orgRole,
      plan: organization.plan,
      hasBillingAccount:
        organization.stripeCustomerId !== null || organization.stripeSubscriptionId !== null,
      usage: usage.kind === "ready" ? await withNames(repo, membership.orgId, usage) : usage,
    },
  };
}

export const loadOrgBilling = createServerFn({ method: "GET" })
  .validator((orgSlug: string) => orgSlug)
  .handler(({ data: orgSlug }) =>
    loadOrgBillingForRequest(controlPanelBindings(workerEnv), getRequest(), orgSlug),
  );

/** The transport shape: still id-keyed, because names are resolved from D1 below. */
type UsageRead =
  | {
      readonly kind: "ready";
      readonly period: Extract<OrgUsage, { kind: "ready" }>["period"];
      readonly evaluations: number;
      readonly breakdown: Parameters<typeof toUsageDimensions>[0];
    }
  | Extract<OrgUsage, { kind: "unavailable" }>;

/**
 * A usage read that failed reports the reason: an Organization shown zero
 * Evaluations it did in fact spend would understate a bill, which is the
 * expensive half of a silent default (ADR-0036).
 */
async function readUsage(
  bindings: ControlPanelBindings,
  orgId: string,
  actor: ControlPanelActor,
): Promise<UsageRead> {
  const { CONTROL_PLANE_API, CONTROL_PANEL_DELEGATION_SECRET } = bindings;
  if (!CONTROL_PLANE_API || !CONTROL_PANEL_DELEGATION_SECRET) {
    return { kind: "unavailable", message: "the Control Plane binding is not configured" };
  }
  try {
    const result = await createControlPanelUsageClient(
      CONTROL_PLANE_API,
      actor,
      CONTROL_PANEL_DELEGATION_SECRET,
    ).get({ orgId });
    if (!result.ok) return { kind: "unavailable", message: result.error.message };
    return {
      kind: "ready",
      period: result.data.period,
      evaluations: result.data.evaluations,
      breakdown: result.data.breakdown,
    };
  } catch (cause) {
    return {
      kind: "unavailable",
      message: cause instanceof Error ? cause.message : "the Control Plane could not be reached",
    };
  }
}

/**
 * Resource ids never reach the screen, so the breakdown is labelled from D1 here
 * — one read of this Organization's own Apps and their Environments, and only
 * when there is consumption to label. A month with nothing in it has no
 * breakdown to draw, so it carries none.
 */
async function withNames(
  repo: Repository,
  orgId: string,
  usage: Extract<UsageRead, { kind: "ready" }>,
): Promise<Extract<OrgUsage, { kind: "ready" }>> {
  const dimensions =
    usage.evaluations > 0 ? toUsageDimensions(usage.breakdown, await readNames(repo, orgId)) : [];
  return {
    kind: "ready",
    period: usage.period,
    evaluations: usage.evaluations,
    dimensions,
  };
}

async function readNames(repo: Repository, orgId: string): Promise<UsageNames> {
  const apps = await repo.identity.listAppsForOrg(orgId);
  const resolver = createEnvironmentResolver(repo);
  const environments = new Map<string, string>();
  for (const app of apps) {
    for (const environment of await resolver.listEnvironments(app.id)) {
      // Two Apps can both have a "Production", so the App names it.
      environments.set(environment.environmentId, `${app.name} · ${environment.name}`);
    }
  }
  return { apps: new Map(apps.map((app) => [app.id, app.name])), environments };
}
