import type { FlagConfigGetOutput, FlagsClient } from "@splitch/control-plane-sdk";
import { describe, expect, it, vi } from "vitest";
import { isFlagDetailNotFound, readFlagDetail } from "./flag-detail-data";

const scope = { appId: "app_checkout", environmentId: "env_dev" };

describe("Flag detail route data", () => {
  it("resolves the URL key to the App-level definition and this Environment's config", async () => {
    const getConfig = vi.fn<FlagsClient["getConfig"]>(async (input) => ({
      ok: true,
      status: 200,
      data: config(input.environmentId),
    }));

    const result = await readFlagDetail(flagsClient(getConfig), scope, "new-checkout");

    expect(result).toMatchObject({
      ok: true,
      data: {
        definition: { id: "flag_checkout", key: "new-checkout", defaultVariantId: "var_disabled" },
        configuration: { environmentId: "env_dev", enabled: true },
      },
    });
    // Resolving the key must not cost an extra round trip: the list read that
    // resolves key -> id is the same read that supplies the definition.
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(getConfig).toHaveBeenCalledWith({
      appId: "app_checkout",
      environmentId: "env_dev",
      flagId: "flag_checkout",
    });
  });

  it("keeps the two grains as separate objects so the boundary survives the read", async () => {
    const result = await readFlagDetail(
      flagsClient(vi.fn(async () => ({ ok: true as const, status: 200, data: config("env_dev") }))),
      scope,
      "new-checkout",
    );

    if (!result.ok || isFlagDetailNotFound(result.data)) throw new Error("expected a Flag detail");
    expect(Object.keys(result.data).sort()).toEqual(["configuration", "definition"]);
    // The App-level grain carries no Environment identity, and must not acquire one.
    expect(result.data.definition).not.toHaveProperty("environmentId");
    expect(result.data.definition).not.toHaveProperty("enabled");
  });

  it("reports an unconfigured Environment as a real state rather than an error", async () => {
    const result = await readFlagDetail(
      flagsClient(
        vi.fn(async () => ({
          ok: false as const,
          status: 404,
          error: { code: "FLAG_NOT_FOUND" as const, message: "not found", details: {} },
        })),
      ),
      scope,
      "new-checkout",
    );

    expect(result).toMatchObject({ ok: true, data: { configuration: null } });
  });

  it("propagates a Configuration read failure instead of showing an empty screen", async () => {
    const result = await readFlagDetail(
      flagsClient(
        vi.fn(async () => ({
          ok: false as const,
          status: 403,
          error: { code: "FORBIDDEN" as const, message: "no access", details: {} },
        })),
      ),
      scope,
      "new-checkout",
    );

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("answers a key that is not in this App with FLAG_NOT_FOUND and no config read", async () => {
    const getConfig = vi.fn<FlagsClient["getConfig"]>();

    const result = await readFlagDetail(flagsClient(getConfig), scope, "from-another-tenant");

    expect(result).toMatchObject({
      ok: true,
      data: { code: "FLAG_NOT_FOUND", catalogTruncated: false },
    });
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("does not claim a key is absent when the catalog read did not see the whole catalog", async () => {
    const getConfig = vi.fn<FlagsClient["getConfig"]>();

    // The key resolves against a BOUNDED list read. When that read truncated,
    // "not in the page" is not "does not exist", and the screen needs to know
    // which of the two it has (ADR-0036).
    const result = await readFlagDetail(flagsClient(getConfig, true), scope, "past-the-ceiling");

    expect(result).toMatchObject({
      ok: true,
      data: { code: "FLAG_NOT_FOUND", catalogTruncated: true },
    });
    expect(getConfig).not.toHaveBeenCalled();
  });
});

function config(environmentId: string): FlagConfigGetOutput {
  return {
    flagId: "flag_checkout",
    environmentId,
    version: 2,
    enabled: true,
    availableVariantNames: ["disabled", "enabled"],
    targetingRules: [],
    rollout: null,
    experiment: null,
  };
}

function flagsClient(
  getConfig: FlagsClient["getConfig"],
  readTruncated = false,
): Pick<FlagsClient, "list" | "getConfig"> {
  return {
    getConfig,
    list: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: {
        readTruncated,
        readLimit: 200,
        items: [
          {
            id: "flag_checkout",
            appId: "app_checkout",
            key: "new-checkout",
            name: "New Checkout",
            schema: { type: "boolean" },
            variants: [
              { id: "var_disabled", name: "disabled", value: false },
              { id: "var_enabled", name: "enabled", value: true },
            ],
            defaultVariantId: "var_disabled",
            createdAt: "2026-07-18T00:00:00.000Z",
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
        ],
      },
    })),
  };
}
