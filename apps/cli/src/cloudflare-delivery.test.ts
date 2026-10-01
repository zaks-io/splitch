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
});
