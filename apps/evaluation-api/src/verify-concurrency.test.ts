import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/verify";

describe("Verify configuration and identity admission", () => {
  it.each(["identity", "configuration"])(
    "starts both reads together and waits for %s before accessing Assignments",
    async (last) => {
      const identity = deferred<string>();
      const config = deferred<void>();
      const identityStarted = deferred<void>();
      const configStarted = deferred<void>();
      const saltStore = new StaticSaltStore();
      vi.spyOn(saltStore, "currentKeyVersion").mockImplementationOnce(() => {
        identityStarted.resolve();
        return identity.promise;
      });
      const h = await makeSdkRouteHarness({ saltStore });
      const get = h.configKv.get.bind(h.configKv);
      vi.spyOn(h.configKv, "get").mockImplementationOnce(async (key) => {
        configStarted.resolve();
        await config.promise;
        return get(key);
      });

      const response = h.app.request(PATH, sdkRouteInit(CLIENT_KEY));
      await Promise.all([identityStarted.promise, configStarted.promise]);
      expect(h.assignmentStore.getAllCalls).toEqual([]);
      if (last === "identity") config.resolve();
      else identity.resolve("v1");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.assignmentStore.getAllCalls).toEqual([]);
      config.resolve();
      identity.resolve("v1");

      const completed = await response;
      expect(completed.status).toBe(200);
      await expect(completed.json()).resolves.toMatchObject({ value: true, reason: "SPLIT" });
      expect(h.configKv.getCallsMatching(":flag:")).toBe(1);
      expect(h.assignmentStore.getAllCalls).toHaveLength(1);
      expect(h.assignmentStore.putCalls).toEqual([]);
      expect(h.exposureSink.writes).toEqual([]);
      expect(h.evaluationUsageSink.writes).toEqual([]);
    },
  );

  it("keeps identity admission errors first when the prefetched read also rejects", async () => {
    const identity = deferred<string>();
    const saltStore = new StaticSaltStore();
    vi.spyOn(saltStore, "currentKeyVersion").mockReturnValueOnce(identity.promise);
    const h = await makeSdkRouteHarness({ saltStore });
    const configStarted = deferred<void>();
    vi.spyOn(h.configKv, "get").mockImplementation(async () => {
      configStarted.resolve();
      throw new Error("configuration unavailable");
    });
    const response = h.app.request(PATH, sdkRouteInit(CLIENT_KEY));
    await configStarted.promise;
    // Let the prefetch rejection settle while admission remains pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    identity.reject(new Error("identity reset in progress"));

    const completed = await response;
    expect(completed.status).toBe(503);
    await expect(completed.json()).resolves.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "App identity reset is in progress",
    });
    expect(h.assignmentStore.getAllCalls).toEqual([]);
  });

  it("reports invalid prefetched configuration through the existing fail-loud response", async () => {
    const h = await makeSdkRouteHarness();
    vi.spyOn(h.configKv, "get").mockResolvedValue("{broken-json");
    const completed = await h.app.request(PATH, sdkRouteInit(CLIENT_KEY));
    expect(completed.status).toBe(500);
    expect(((await completed.json()) as ErrorResponse).code).toBe("INTERNAL_SERVER_ERROR");
    expect(h.assignmentStore.getAllCalls).toEqual([]);
    expect(h.assignmentStore.putCalls).toEqual([]);
  });

  it("rejects replacement identity after configuration was prefetched", async () => {
    const config = deferred<void>();
    const configStarted = deferred<void>();
    const saltStore = new StaticSaltStore();
    let version = "v1";
    vi.spyOn(saltStore, "currentKeyVersion").mockImplementation(async () => version);
    const h = await makeSdkRouteHarness({ saltStore });
    const get = h.configKv.get.bind(h.configKv);
    vi.spyOn(h.configKv, "get").mockImplementationOnce(async (key) => {
      configStarted.resolve();
      await config.promise;
      return get(key);
    });
    const response = h.app.request(PATH, sdkRouteInit(CLIENT_KEY));
    await configStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    version = "v2";
    config.resolve();

    const completed = await response;
    expect(completed.status).toBe(503);
    expect(h.assignmentStore.getAllCalls).toEqual([]);
    expect(h.assignmentStore.putCalls).toEqual([]);
    expect(h.exposureSink.writes).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
