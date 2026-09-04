import { AppErrorPage } from "@splitch/ui/state/app-error-page";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { WidgetErrorState } from "@splitch/ui/state/widget-error-state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "#lib/shared/loader-context";
import {
  boundaryLevel,
  configureControlPanelSentryScope,
  createControlPanelSentryOptions,
  createNudgeRefetchFailureHandler,
  reportBackgroundRefetchFailure,
  reportRouteError,
  setControlPanelSentryClientForTests,
} from "#lib/observability/panel-observability";
import { SESSION_COOKIE_NAME } from "#lib/sessions/session";

describe("control-panel observability tiers", () => {
  afterEach(() => {
    setControlPanelSentryClientForTests(undefined);
    vi.clearAllMocks();
  });

  it("maps boundary tiers to Sentry severity", () => {
    expect(boundaryLevel("app")).toBe("error");
    expect(boundaryLevel("section")).toBe("error");
    expect(boundaryLevel("widget")).toBe("warning");
  });

  it.each([
    ["app", "__root__", "error"],
    ["section", "/$orgSlug/$appSlug/$env/flags", "error"],
    ["widget", "/$orgSlug/$appSlug/$env", "warning"],
  ] as const)("reports %s errors with route and boundary tags", (tier, route, level) => {
    const captureException = vi.fn();
    setControlPanelSentryClientForTests({ captureException });

    const error = new Error(`${tier} exploded`);
    reportRouteError(tier, error, route);

    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        level,
        tags: { boundary: tier, route },
      }),
    );
  });

  it.each([
    {
      tier: "app",
      route: "__root__",
      level: "error",
      surface: createElement(AppErrorPage),
      surfaceLabel: "Page unavailable",
    },
    {
      tier: "section",
      route: "/$orgSlug/$appSlug/$env/flags",
      level: "error",
      surface: createElement(SectionErrorPage, { title: "Flags unavailable" }),
      surfaceLabel: "Flags unavailable",
    },
    {
      tier: "widget",
      route: "/$orgSlug/$appSlug/$env",
      level: "warning",
      surface: createElement(WidgetErrorState),
      surfaceLabel: "Widget unavailable",
    },
  ] as const)(
    "accepts thrown $tier route-loader errors with the correct surface and reporting",
    ({ tier, route, level, surface, surfaceLabel }) => {
      const captureException = vi.fn();
      setControlPanelSentryClientForTests({ captureException });

      const loaderError = new Error(`${tier} route loader failed`);
      reportRouteError(tier, loaderError, route);
      const html = renderToStaticMarkup(surface);

      expect(html).toContain(surfaceLabel);
      expect(captureException).toHaveBeenCalledWith(
        loaderError,
        expect.objectContaining({
          extra: { route },
          level,
          tags: { boundary: tier, route },
        }),
      );
    },
  );

  it("records expected 403 route failures as info breadcrumbs only", () => {
    const addBreadcrumb = vi.fn();
    const captureException = vi.fn();
    setControlPanelSentryClientForTests({ addBreadcrumb, captureException });

    reportRouteError("section", new AccessDeniedError(), "/acme/checkout/dev");

    expect(captureException).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "control-panel.domain",
        level: "info",
        message: "403 /acme/checkout/dev",
      }),
    );
  });

  it("records nudge refetch failures as debug breadcrumbs", () => {
    const addBreadcrumb = vi.fn();
    setControlPanelSentryClientForTests({ addBreadcrumb });

    reportBackgroundRefetchFailure({
      attempt: 2,
      entity: "flag",
      id: "flag_1",
      nextRetryMs: 4000,
    });

    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "control-panel.refetch",
        level: "debug",
        data: expect.objectContaining({ attempt: 2, nextRetryMs: 4000 }),
      }),
    );
  });

  it("wires nudge refetch failures to the stale-data toast hook", () => {
    const addBreadcrumb = vi.fn();
    const onStaleData = vi.fn();
    setControlPanelSentryClientForTests({ addBreadcrumb });

    const handleFailure = createNudgeRefetchFailureHandler({
      entity: "flag",
      id: "flag_1",
      onStaleData,
    });

    handleFailure({ attempt: 3, nextRetryMs: 8000 });

    const expectedFailure = {
      attempt: 3,
      entity: "flag",
      id: "flag_1",
      nextRetryMs: 8000,
    };
    expect(onStaleData).toHaveBeenCalledWith(expectedFailure);
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "control-panel.refetch",
        data: expectedFailure,
        level: "debug",
      }),
    );
  });

  it("sets operator and App scope once the scoped loader resolves", () => {
    const setUser = vi.fn();
    const setTag = vi.fn();
    setControlPanelSentryClientForTests({ setUser, setTag });

    configureControlPanelSentryScope({
      session: { userId: "user_1" },
      scope: {
        appId: "app_1",
        appRole: "admin",
        orgId: "org_1",
      },
    });

    expect(setUser).toHaveBeenCalledWith({ id: "user_1" });
    expect(setTag).toHaveBeenCalledWith("appId", "app_1");
    expect(setTag).toHaveBeenCalledWith("orgId", "org_1");
    expect(setTag).toHaveBeenCalledWith("role", "admin");
  });
});

describe("control-panel Sentry PII scrubbing", () => {
  it("samples every operator journey and propagates only to server functions", () => {
    const options = createControlPanelSentryOptions({
      SENTRY_DSN: "https://example@sentry.io/1",
      SPLITCH_PLATFORM_TARGET: "production",
    });

    expect(options.tracesSampleRate).toBe(1);
    expect(options.tracePropagationTargets).toHaveLength(1);
    expect(options.tracePropagationTargets[0]?.test("/_serverFn/function-id")).toBe(true);
    expect(options.tracePropagationTargets[0]?.test("https://api.example.com/data")).toBe(false);
  });

  it("removes session cookies and Targeting Key payloads before the outgoing event", () => {
    const outgoingEvents: Record<string, unknown>[] = [];
    const token = "spl_super-secret-session-token-000000";
    const targetingKey = "tk-end-user-42";
    const options = createControlPanelSentryOptions(
      {
        SENTRY_DSN: "https://example@sentry.io/1",
        SPLITCH_PLATFORM_TARGET: "test",
      },
      {
        onSentryEvent: (event) => {
          outgoingEvents.push(event);
        },
      },
    );

    const scrubbed = options.beforeSend({
      level: "error",
      message: `loader failed with ${SESSION_COOKIE_NAME}=${token} and ${targetingKey}`,
      extra: {
        context: { targetingKey, email: "end-user@example.com" },
        targetingKey,
      },
      request: {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
      },
    });

    expect(outgoingEvents).toHaveLength(1);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(targetingKey);
    expect(serialized).not.toContain("end-user@example.com");
    expect(serialized).toContain("[Redacted]");
  });
});
