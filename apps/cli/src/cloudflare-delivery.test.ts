import { describe, expect, it } from "vitest";
import {
  appWithConfig,
  INSTALLATION_STATUS,
  RecordingRunner,
  runCloudflare,
  workerRejection,
} from "./cloudflare-test-fixtures";

const SETUP = ["cloudflare", "setup", "--env", "production", "--json"];

interface Scripted {
  readonly endpoint?: Array<() => Response>;
  readonly statuses?: ReadonlyArray<Record<string, unknown>>;
}

/** Answers the workers.dev probe and the status reads from scripts, recording each call. */
function scriptedFetch(script: Scripted) {
  const calls: string[] = [];
  const endpoint = [...(script.endpoint ?? [])];
  const statuses = [...(script.statuses ?? [])];
  let validated = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes(".workers.dev/")) {
      calls.push("probe");
      return (endpoint.shift() ?? workerRejection)();
    }
    if (method === "POST") {
      calls.push("register");
      return Response.json({ registered: true });
    }
    if (!validated) {
      validated = true;
      return Response.json(
        {
          code: "CLOUDFLARE_INSTALLATION_NOT_FOUND",
          message: "Cloudflare installation not found",
          details: {},
        },
        { status: 404 },
      );
    }
    calls.push("status");
    return Response.json({ ...INSTALLATION_STATUS, ...(statuses.shift() ?? {}) });
  };
  return { fetcher, calls };
}

const cloudflareNotFound = () => new Response("There is nothing here yet", { status: 404 });

describe("cloudflare setup delivery", () => {
  it("registers only once the new workers.dev route answers with the Worker's own 401", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const { fetcher, calls } = scriptedFetch({
      endpoint: [
        cloudflareNotFound,
        () => {
          throw new TypeError("fetch failed");
        },
        () => Response.json({ code: "UNAUTHORIZED" }, { status: 404 }),
        () => new Response("Unauthorized", { status: 401 }),
      ],
    });

    const result = await runCloudflare(cwd, new RecordingRunner(), SETUP, { fetch: fetcher });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(["probe", "probe", "probe", "probe", "probe", "register", "status"]);
  });

  it("fails loud without registering when the route never becomes reachable", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const { fetcher, calls } = scriptedFetch({
      endpoint: Array.from({ length: 60 }, () => cloudflareNotFound),
    });

    await expect(
      runCloudflare(cwd, new RecordingRunner(), SETUP, { fetch: fetcher }),
    ).rejects.toThrow(
      "The deployed Cloudflare Worker at https://splitch-config-production.customer.workers.dev/integrations/splitch/configuration did not become reachable after 60 attempts one second apart (last response: HTTP 404)",
    );
    expect(calls).not.toContain("register");
  });

  it("names the delivery error when the current version's delivery is terminal", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const { fetcher } = scriptedFetch({
      statuses: [
        {
          lastAppliedVersion: null,
          terminalCount: 1,
          latestDeliveryError: {
            kind: "http",
            code: "HTTP_STATUS",
            httpStatus: 404,
            occurredAt: "2026-10-01T19:02:58.595Z",
          },
        },
      ],
    });

    await expect(
      runCloudflare(cwd, new RecordingRunner(), SETUP, { fetch: fetcher }),
    ).rejects.toThrow(
      "Cloudflare configuration delivery entered a terminal state: http HTTP_STATUS HTTP 404 at 2026-10-01T19:02:58.595Z",
    );
  });

  it("keeps waiting past an older terminal delivery while the current one is pending", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const { fetcher, calls } = scriptedFetch({
      statuses: [
        { lastAppliedVersion: 6, pendingCount: 1, terminalCount: 1 },
        { terminalCount: 1 },
      ],
    });

    const result = await runCloudflare(cwd, new RecordingRunner(), SETUP, { fetch: fetcher });

    expect(result.exitCode).toBe(0);
    expect(calls.filter((call) => call === "status")).toHaveLength(2);
  });

  it("keeps waiting with progress while a 404 push is still pending inside the window", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const pending404 = (occurredAt: string) => ({
      lastAppliedVersion: null,
      pendingCount: 1,
      latestDeliveryError: { kind: "http", code: "HTTP_STATUS", httpStatus: 404, occurredAt },
    });
    const { fetcher, calls } = scriptedFetch({
      statuses: [
        { lastAppliedVersion: null, pendingCount: 1 },
        pending404("2026-10-01T21:02:48.000Z"),
        pending404("2026-10-01T21:02:48.000Z"),
        pending404("2026-10-01T21:03:48.000Z"),
        ...Array.from({ length: 100 }, () => pending404("2026-10-01T21:04:48.000Z")),
      ],
    });
    const stderr: string[] = [];

    const result = await runCloudflare(cwd, new RecordingRunner(), SETUP, {
      fetch: fetcher,
      stderr,
    });

    expect(result.exitCode).toBe(0);
    expect(calls.filter((call) => call === "status")).toHaveLength(105);
    expect(stderr).toEqual([
      "Waiting up to 12 minutes for the Cloudflare Worker to apply Environment version 7",
      "Configuration push still pending; latest delivery error: http HTTP_STATUS HTTP 404 at 2026-10-01T21:02:48.000Z",
      "Configuration push still pending; latest delivery error: http HTTP_STATUS HTTP 404 at 2026-10-01T21:03:48.000Z",
      "Configuration push still pending; latest delivery error: http HTTP_STATUS HTTP 404 at 2026-10-01T21:04:48.000Z",
    ]);
  });

  it("names the pending delivery error when the wait runs out", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const { fetcher, calls } = scriptedFetch({
      statuses: Array.from({ length: 145 }, () => ({
        lastAppliedVersion: null,
        pendingCount: 1,
        latestDeliveryError: {
          kind: "http",
          code: "HTTP_STATUS",
          httpStatus: 404,
          occurredAt: "2026-10-01T21:12:48.000Z",
        },
      })),
    });

    await expect(
      runCloudflare(cwd, new RecordingRunner(), SETUP, { fetch: fetcher }),
    ).rejects.toThrow(
      "Cloudflare Worker did not apply Environment version 7 within 12 minutes; 1 delivery still pending, latest delivery error: http HTTP_STATUS HTTP 404 at 2026-10-01T21:12:48.000Z",
    );
    // One read per 5-second poll over 12 minutes, plus the first read.
    expect(calls.filter((call) => call === "status")).toHaveLength(145);
  });

  it("fails at once when the installation has nothing pending and nothing terminal", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const { fetcher, calls } = scriptedFetch({
      statuses: [{ status: "revoked", lastAppliedVersion: null }],
    });

    await expect(
      runCloudflare(cwd, new RecordingRunner(), SETUP, { fetch: fetcher }),
    ).rejects.toThrow(
      "The Cloudflare installation is revoked with no delivery pending for Environment version 7; run splitch cloudflare status",
    );
    expect(calls.filter((call) => call === "status")).toHaveLength(1);
  });
});
