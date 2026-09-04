import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const flag = {
  id: "flag_checkout",
  appId: "app_a",
  key: "new-checkout",
  name: "New checkout",
  schema: null,
  variants: [{ id: "var_off", name: "off", value: false }],
  defaultVariantId: "var_off",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

function flagsSdk(response: () => Response = () => Response.json(flag)) {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input as RequestInfo, init));
    return response();
  });
  return {
    sdk: createControlPlaneSdk({ baseUrl: "https://control-plane.test", fetch: fetcher }),
    requests,
  };
}

describe("control plane sdk flags.get wire shape", () => {
  it("percent-encodes Flag keys that contain reserved path characters", async () => {
    const { sdk, requests } = flagsSdk();

    const cases: Array<{ key: string; encoded: string }> = [
      { key: "a/b", encoded: "a%2Fb" },
      { key: "a#b", encoded: "a%23b" },
      { key: "a?b", encoded: "a%3Fb" },
      { key: "a b", encoded: "a%20b" },
      { key: "100%off", encoded: "100%25off" },
    ];

    for (const { key } of cases) {
      await sdk.flags.get({ appId: "app_a", flagId: key, by: "key" });
    }

    expect(requests.map((request) => request.url)).toEqual(
      cases.map(({ encoded }) => `https://control-plane.test/apps/app_a/flags/${encoded}?by=key`),
    );
  });

  it("puts by on the query string for both key and id lookups", async () => {
    const { sdk, requests } = flagsSdk();

    await sdk.flags.get({ appId: "app_a", flagId: "new-checkout", by: "key" });
    expect(new URL(requests[0]?.url ?? "").searchParams.get("by")).toBe("key");

    await sdk.flags.get({ appId: "app_a", flagId: "flag_checkout", by: "id" });
    expect(new URL(requests[1]?.url ?? "").searchParams.get("by")).toBe("id");
  });

  it("omits the query string entirely when by is absent", async () => {
    const { sdk, requests } = flagsSdk();

    await sdk.flags.get({ appId: "app_a", flagId: "flag_checkout" });

    expect(requests[0]?.url).toBe("https://control-plane.test/apps/app_a/flags/flag_checkout");
  });

  it("forwards hydration and Environment subset alongside selector mode", async () => {
    const hydrated = { ...flag, configurations: [] };
    const { sdk, requests } = flagsSdk(() => Response.json(hydrated));

    await expect(
      sdk.flags.get({
        appId: "app_a",
        flagId: "new-checkout",
        by: "key",
        include: "config",
        envs: "env_prod",
      }),
    ).resolves.toEqual({ ok: true, status: 200, data: hydrated });

    const url = new URL(requests[0]?.url ?? "");
    expect(url.searchParams.get("by")).toBe("key");
    expect(url.searchParams.get("include")).toBe("config");
    expect(url.searchParams.get("envs")).toBe("env_prod");
  });

  it.each(["", ".", ".."] as const)(
    "refuses Flag selector %j before building a path the WHATWG parser would rewrite",
    async (selector) => {
      const { sdk, requests } = flagsSdk();

      await expect(sdk.flags.get({ appId: "app_a", flagId: selector, by: "key" })).rejects.toThrow(
        /cannot be addressed as a path segment/,
      );
      expect(requests).toHaveLength(0);
    },
  );

  it.each(["%2e", "%2E", "%2e%2e", "%2e%2E"] as const)(
    "refuses percent-encoded dot-segment spelling %j",
    async (selector) => {
      const { sdk, requests } = flagsSdk();

      await expect(sdk.flags.get({ appId: "app_a", flagId: selector, by: "key" })).rejects.toThrow(
        /cannot be addressed as a path segment/,
      );
      expect(requests).toHaveLength(0);
    },
  );
});
