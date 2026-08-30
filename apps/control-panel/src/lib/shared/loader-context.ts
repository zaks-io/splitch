import type { AppMembership, OrgMembership, SessionPrincipal } from "#lib/sessions/session";

const ACCESS_DENIED_MESSAGE = "SPLITCH_ACCESS_DENIED";

export interface ScopeParams {
  orgSlug: string;
  appSlug: string;
  env: string;
}

export interface AppScopeParams {
  orgSlug: string;
  appSlug: string;
}

export interface EnvironmentScope {
  environmentId: string;
  env: string;
  name: string;
  guarded: boolean;
}

export interface EnvironmentResolver {
  listEnvironments(appId: string): Promise<readonly EnvironmentScope[]>;
}

export interface ScopeNavigation {
  orgs: Array<{
    orgId: string;
    orgSlug: string;
    apps: Array<{
      appId: string;
      appSlug: string;
      environments: readonly EnvironmentScope[];
    }>;
  }>;
}

export interface ScopedLoaderContext {
  session: SessionPrincipal;
  navigation: ScopeNavigation;
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

export interface AppScopedLoaderContext {
  session: SessionPrincipal;
  navigation: ScopeNavigation;
  scope: {
    orgId: string;
    orgSlug: string;
    orgRole: OrgMembership["orgRole"];
    appId: string;
    appSlug: string;
    appRole: AppMembership["role"];
    environments: readonly EnvironmentScope[];
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
  const context = await resolveAppLoaderContext(session, params, resolver);
  const environment = context.scope.environments.find((candidate) => candidate.env === params.env);
  if (!environment) {
    throw new ScopedNotFoundError("environment");
  }

  return {
    navigation: context.navigation,
    session: context.session,
    scope: {
      orgId: context.scope.orgId,
      orgSlug: context.scope.orgSlug,
      orgRole: context.scope.orgRole,
      appId: context.scope.appId,
      appSlug: context.scope.appSlug,
      appRole: context.scope.appRole,
      environmentId: environment.environmentId,
      env: environment.env,
    },
  };
}

export async function resolveAppLoaderContext(
  session: SessionPrincipal,
  params: AppScopeParams,
  resolver: EnvironmentResolver,
): Promise<AppScopedLoaderContext> {
  const org = requireOrgAccess(session, params.orgSlug);
  const app = requireAppAccess(org, params.appSlug);
  const navigation = await resolveNavigation(session, resolver);
  const currentApp = navigation.orgs
    .find((candidate) => candidate.orgId === org.orgId)
    ?.apps.find((candidate) => candidate.appId === app.appId);
  if (!currentApp || currentApp.environments.length === 0) {
    throw new ScopedNotFoundError("environment");
  }

  return {
    navigation,
    session,
    scope: {
      orgId: org.orgId,
      orgSlug: org.orgSlug,
      orgRole: org.orgRole,
      appId: app.appId,
      appSlug: app.appSlug,
      appRole: app.role,
      environments: currentApp.environments,
    },
  };
}

export async function resolveNavigation(
  session: SessionPrincipal,
  resolver: EnvironmentResolver,
): Promise<ScopeNavigation> {
  return {
    orgs: await Promise.all(
      session.orgs.map(async (membership) => ({
        orgId: membership.orgId,
        orgSlug: membership.orgSlug,
        apps: await Promise.all(
          membership.apps.map(async (candidate) => ({
            appId: candidate.appId,
            appSlug: candidate.appSlug,
            environments: await resolver.listEnvironments(candidate.appId),
          })),
        ),
      })),
    ),
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
