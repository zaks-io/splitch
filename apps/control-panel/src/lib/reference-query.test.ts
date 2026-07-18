import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ApiResult } from "./api";
import {
  loadReferenceFlagConfig,
  referenceFlagConfigQuery,
  updateReferenceFlagConfig,
  type ReferenceFlagConfigApi,
} from "./reference-query";

type Config = { readonly version: number; readonly enabled: boolean };
type Patch = { readonly enabled: boolean };

const scope = { appId: "app_1", environmentId: "env_1" };

describe("reference flag configuration query flow", () => {
  it("seeds a loader read into the QueryClient", async () => {
    const api = apiFor({ ok: true, status: 200, data: { version: 1, enabled: false } });
    const queryClient = queryClientForTest();

    await expect(loadReferenceFlagConfig(queryClient, api, scope, "flag_1")).resolves.toEqual({
      version: 1,
      enabled: false,
    });
    expect(api.reads).toBe(1);
  });

  it("does not write optimistically and refetches only after a confirmed 200", async () => {
    let resolveUpdate: ((result: ApiResult<Config>) => void) | undefined;
    const api = apiFor({ ok: true, status: 200, data: { version: 1, enabled: false } });
    api.update = () =>
      new Promise<ApiResult<Config>>((resolve) => {
        resolveUpdate = resolve;
      });
    const queryClient = queryClientForTest();
    await loadReferenceFlagConfig(queryClient, api, scope, "flag_1");
    const observer = new QueryObserver(queryClient, referenceFlagConfigQuery(api, scope, "flag_1"));
    const unsubscribe = observer.subscribe(() => undefined);

    const mutation = updateReferenceFlagConfig(queryClient, api, scope, "flag_1", {
      enabled: true,
    });
    expect(
      queryClient.getQueryData(referenceFlagConfigQuery(api, scope, "flag_1").queryKey),
    ).toEqual({
      version: 1,
      enabled: false,
    });

    api.readResult = { ok: true, status: 200, data: { version: 2, enabled: true } };
    resolveUpdate?.({ ok: true, status: 200, data: { version: 2, enabled: true } });

    await expect(mutation).resolves.toEqual({ ok: true, data: { version: 2, enabled: true } });
    expect(
      queryClient.getQueryData(referenceFlagConfigQuery(api, scope, "flag_1").queryKey),
    ).toEqual({
      version: 2,
      enabled: true,
    });
    unsubscribe();
  });

  it("retains cached state and surfaces a 400 field error", async () => {
    const api = apiFor({ ok: true, status: 200, data: { version: 1, enabled: false } });
    api.update = async () => ({
      ok: false,
      status: 400,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid Flag Configuration",
        details: { issues: [{ path: ["enabled"], message: "Cannot disable this Flag" }] },
      },
    });
    const queryClient = queryClientForTest();
    await loadReferenceFlagConfig(queryClient, api, scope, "flag_1");

    await expect(
      updateReferenceFlagConfig(queryClient, api, scope, "flag_1", { enabled: true }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "field",
        message: "Invalid Flag Configuration",
        fields: [
          { field: "enabled", code: "VALIDATION_ERROR", message: "Cannot disable this Flag" },
        ],
      },
    });
    expect(
      queryClient.getQueryData(referenceFlagConfigQuery(api, scope, "flag_1").queryKey),
    ).toEqual({
      version: 1,
      enabled: false,
    });
  });

  it("surfaces a 403 as a tier error without changing the cache", async () => {
    const api = apiFor({ ok: true, status: 200, data: { version: 1, enabled: false } });
    api.update = async () => ({
      ok: false,
      status: 403,
      error: { code: "FORBIDDEN", message: "Admin role required", details: {} },
    });
    const queryClient = queryClientForTest();
    await loadReferenceFlagConfig(queryClient, api, scope, "flag_1");

    await expect(
      updateReferenceFlagConfig(queryClient, api, scope, "flag_1", { enabled: true }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "tier", message: "Admin role required" },
    });
    expect(
      queryClient.getQueryData(referenceFlagConfigQuery(api, scope, "flag_1").queryKey),
    ).toEqual({
      version: 1,
      enabled: false,
    });
  });
});

function queryClientForTest() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function apiFor(readResult: ApiResult<Config>) {
  const api: ReferenceFlagConfigApi<Config, Patch> & {
    reads: number;
    readResult: ApiResult<Config>;
  } = {
    reads: 0,
    readResult,
    async read() {
      this.reads += 1;
      return this.readResult;
    },
    async update() {
      return { ok: true, status: 200, data: { version: 1, enabled: false } };
    },
  };
  return api;
}
