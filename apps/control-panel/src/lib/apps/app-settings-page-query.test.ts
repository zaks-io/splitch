import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "#lib/shared/query-keys";

const loadAppSettingsPageMock = vi.fn();

vi.mock("#lib/apps/app-settings-page-functions", () => ({
  loadAppSettingsPage: (...args: unknown[]) => loadAppSettingsPageMock(...args),
}));

const { prefetchAppSettingsPage } = await import("#lib/apps/app-settings-page-query");

const scope = { appId: "app_1", environmentId: "env_1" };

describe("prefetchAppSettingsPage", () => {
  beforeEach(() => {
    loadAppSettingsPageMock.mockReset();
  });

  it("seeds all three Settings queries from one server request", async () => {
    const appSettings = { app: { id: "app_1" } };
    const environmentSettings = { environment: { id: "env_1" } };
    const exposureStatus = { status: "not_received" };
    loadAppSettingsPageMock.mockResolvedValue({
      ok: true,
      data: {
        appSettings: { ok: true, data: appSettings },
        environmentSettings: { ok: true, data: environmentSettings },
        exposureStatus: { ok: true, data: exposureStatus },
      },
    });
    const queryClient = new QueryClient();

    await prefetchAppSettingsPage(queryClient, scope);

    expect(loadAppSettingsPageMock).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(queryKeys.app.settings(scope.appId))).toEqual(appSettings);
    expect(
      queryClient.getQueryData(queryKeys.environment.settings(scope.appId, scope.environmentId)),
    ).toEqual(environmentSettings);
    expect(
      queryClient.getQueryData(
        queryKeys.environment.exposureStatus(scope.appId, scope.environmentId),
      ),
    ).toEqual(exposureStatus);
    expect(
      queryClient.getQueryData(queryKeys.app.settingsPage(scope.appId, scope.environmentId)),
    ).toBeUndefined();
  });

  it.each([
    ["Environment settings", "environmentSettings", 404],
    ["Exposure status", "exposureStatus", 503],
  ] as const)("fails loudly when %s fails", async (message, failedOperation, status) => {
    loadAppSettingsPageMock.mockResolvedValue({
      ok: true,
      data: {
        appSettings: { ok: true, data: { app: { id: "app_1" } } },
        environmentSettings:
          failedOperation === "environmentSettings"
            ? { ok: false, status, error: { message } }
            : { ok: true, data: { environment: { id: "env_1" } } },
        exposureStatus:
          failedOperation === "exposureStatus"
            ? { ok: false, status, error: { message } }
            : { ok: true, data: { status: "not_received" } },
      },
    });
    const queryClient = new QueryClient();

    await expect(prefetchAppSettingsPage(queryClient, scope)).rejects.toMatchObject({
      message,
      status,
    });
    expect(
      queryClient.getQueryData(queryKeys.app.settingsPage(scope.appId, scope.environmentId)),
    ).toBeUndefined();
  });
});
