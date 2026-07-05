import type { AppMembership, OrgMembership, SessionPrincipal } from "./session";

const ACCESS_DENIED_MESSAGE = "SPLITCH_ACCESS_DENIED";

export interface ScopeParams {
  orgSlug: string;
  appSlug: string;
  env: string;
}

interface EnvironmentScope {
  environmentId: string;
  env: string;
}

export interface EnvironmentResolver {
  findEnvironmentByKey(appId: string, env: string): Promise<EnvironmentScope | null>;
}

export interface ScopedLoaderContext {
  session: SessionPrincipal;
  scope: {
    orgId: string;
    orgSlug: string;
    orgRole: OrgMembership["orgRole"];
    appId: string;
    appSlug: string;
    appRole: AppMembership["role"];
    environmentId: string;
    env: string;
  };
}

export class AccessDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super(ACCESS_DENIED_MESSAGE);
    this.name = "AccessDeniedError";
  }
}

export class ScopedNotFoundError extends Error {
  readonly status = 404;

  constructor(readonly resource: "app" | "environment") {
    super(`SPLITCH_${resource.toUpperCase()}_NOT_FOUND`);
    this.name = "ScopedNotFoundError";
  }
}

export function isAccessDeniedError(error: unknown): boolean {
  return error instanceof AccessDeniedError || isErrorWithMessage(error, ACCESS_DENIED_MESSAGE);
}

function requireOrgAccess(session: SessionPrincipal, orgSlug: string): OrgMembership {
  const org = session.orgs.find((membership) => membership.orgSlug === orgSlug);
  if (!org) {
    throw new AccessDeniedError();
  }
  return org;
}

function requireAppAccess(org: OrgMembership, appSlug: string): AppMembership {
  const app = org.apps.find((membership) => membership.appSlug === appSlug);
  if (!app) {
    throw new ScopedNotFoundError("app");
  }
  return app;
}

export async function resolveScopedLoaderContext(
  session: SessionPrincipal,
  params: ScopeParams,
  resolver: EnvironmentResolver,
): Promise<ScopedLoaderContext> {
  const org = requireOrgAccess(session, params.orgSlug);
  const app = requireAppAccess(org, params.appSlug);
  const environment = await resolver.findEnvironmentByKey(app.appId, params.env);
  if (!environment) {
    throw new ScopedNotFoundError("environment");
  }

  return {
    session,
    scope: {
      orgId: org.orgId,
      orgSlug: org.orgSlug,
      orgRole: org.orgRole,
      appId: app.appId,
      appSlug: app.appSlug,
      appRole: app.role,
      environmentId: environment.environmentId,
      env: environment.env,
    },
  };
}

function isErrorWithMessage(error: unknown, message: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    (error as { message?: unknown }).message === message
  );
}
