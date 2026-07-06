import { createSentryBeforeSend, secretsFromEnv } from "@splitch/observability/emitter";
import { SESSION_COOKIE_NAME } from "./session";

type BoundaryTier = "app" | "section" | "widget";
type ExpectedDomainStatus = 403 | 404;
type SentryLevel = "debug" | "error" | "fatal" | "info" | "warning";

type SentryClient = {
  addBreadcrumb?: (breadcrumb: {
    category?: string;
    data?: Record<string, unknown>;
    level?: SentryLevel;
    message?: string;
  }) => void;
  captureException?: (
    error: unknown,
    context?: {
      extra?: Record<string, unknown>;
      level?: SentryLevel;
      tags?: Record<string, string>;
    },
  ) => void;
  init?: (options: ReturnType<typeof createControlPanelSentryOptions>) => void;
  setTag?: (key: string, value: string) => void;
  setUser?: (user: { id: string }) => void;
};

type ControlPanelSentryEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SPLITCH_PLATFORM_TARGET?: string;
};

type ScopeContext = {
  session: { userId: string };
  scope: {
    appId: string;
    appRole: string;
    orgId: string;
  };
};

type RefetchFailure = {
  attempt: number;
  entity: string;
  id: string;
  nextRetryMs?: number;
};

type SentryEventLike = Record<string, unknown>;

const sessionCookiePattern = new RegExp(`${SESSION_COOKIE_NAME}=spl_[a-z0-9_-]+`, "gi");
const BOUNDARY_LEVELS = {
  app: "error",
  section: "error",
  widget: "warning",
} as const satisfies Record<BoundaryTier, SentryLevel>;

let sentryClient: SentryClient | undefined;

export function createControlPanelSentryOptions(
  env: ControlPanelSentryEnv,
  hooks: { onSentryEvent?: (event: SentryEventLike) => void } = {},
) {
  const secrets = secretsFromEnv(env);
  const beforeSend = createSentryBeforeSend({
    surface: "control-panel",
    scrubOptions: {
      extraPatterns: [/tk-[a-z0-9-]+/gi, sessionCookiePattern, /spl_[a-z0-9_-]{16,}/gi],
    },
    onSentryEvent: hooks.onSentryEvent,
  });

  return {
    dsn: secrets.sentryDsn,
    environment: secrets.environment,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: secrets.environment === "production" ? 0.1 : 1,
    beforeSend,
  };
}

export function initControlPanelSentry(env: ControlPanelSentryEnv, client: SentryClient): void {
  const options = createControlPanelSentryOptions(env);
  sentryClient = client;
  if (options.dsn) {
    client.init?.(options);
  }
}

export function setControlPanelSentryClient(client: SentryClient | undefined): void {
  sentryClient = client;
}

export function setControlPanelSentryClientForTests(client: SentryClient | undefined): void {
  setControlPanelSentryClient(client);
}

export function configureControlPanelSentryScope(context: ScopeContext): void {
  sentryClient?.setUser?.({ id: context.session.userId });
  sentryClient?.setTag?.("appId", context.scope.appId);
  sentryClient?.setTag?.("orgId", context.scope.orgId);
  sentryClient?.setTag?.("role", context.scope.appRole);
}

export function reportRouteError(tier: BoundaryTier, error: unknown, route: string): void {
  const expectedStatus = expectedDomainStatus(error);
  if (expectedStatus) {
    reportExpectedDomainFailure(expectedStatus, route, { boundary: tier });
    return;
  }
  reportBoundaryError(tier, error, route);
}

export function reportBoundaryError(tier: BoundaryTier, error: unknown, route: string): void {
  sentryClient?.captureException?.(error, {
    level: BOUNDARY_LEVELS[tier],
    tags: { boundary: tier, route },
    extra: { route },
  });
}

export function reportExpectedDomainFailure(
  status: ExpectedDomainStatus,
  route: string,
  data: Record<string, unknown> = {},
): void {
  sentryClient?.addBreadcrumb?.({
    category: "control-panel.domain",
    level: "info",
    message: `${status} ${route}`,
    data: { route, status, ...data },
  });
}

export function reportBackgroundRefetchFailure(failure: RefetchFailure): void {
  sentryClient?.addBreadcrumb?.({
    category: "control-panel.refetch",
    level: "debug",
    message: `nudge refetch failed for entity=${failure.entity} id=${failure.id}`,
    data: failure,
  });
}

export function boundaryLevel(tier: BoundaryTier): SentryLevel {
  return BOUNDARY_LEVELS[tier];
}

function expectedDomainStatus(error: unknown): ExpectedDomainStatus | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const status = "status" in error ? (error as { status?: unknown }).status : undefined;
  if (status === 403 || status === 404) {
    return status;
  }
  return null;
}
