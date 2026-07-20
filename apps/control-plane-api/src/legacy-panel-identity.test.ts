import { describe, expect, it } from "vitest";
import {
  LEGACY_CONTROL_PANEL_IDENTITY_HEADER,
  parseBoundedLegacyPanelIdentity,
} from "./legacy-panel-identity";

const NOW = 1_800_000_000;
const operation = { id: "flags_list", appId: "app_1", environmentId: "env_1" } as const;

describe("bounded legacy Control Panel identity", () => {
  it("accepts the exact V1 shape only for the expected operation and lifetime", () => {
    const value = legacyIdentity();

    expect(parseBoundedLegacyPanelIdentity(value, operation, NOW)).toMatchObject({
      operation,
      actorId: "user_1",
      expiresAt: NOW + 30,
    });
    expect(
      parseBoundedLegacyPanelIdentity(value, { ...operation, appId: "app_2" }, NOW),
    ).toBeNull();
    expect(parseBoundedLegacyPanelIdentity(value, operation, NOW + 30)).toBeNull();
  });

  it("rejects malformed and extended unsigned claims", () => {
    expect(parseBoundedLegacyPanelIdentity("not-json", operation, NOW)).toBeNull();
    expect(
      parseBoundedLegacyPanelIdentity(
        legacyIdentity({ impersonatedRole: "owner" }),
        operation,
        NOW,
      ),
    ).toBeNull();
  });

  it("uses only the retired header name", () => {
    expect(LEGACY_CONTROL_PANEL_IDENTITY_HEADER).toBe("x-splitch-panel-identity");
  });
});

function legacyIdentity(extra: Record<string, unknown> = {}): string {
  return encodeURIComponent(
    JSON.stringify({
      version: 1,
      operation,
      actorId: "user_1",
      expiresAt: NOW + 30,
      nonce: "nonce_1234567890abcdef",
      ...extra,
    }),
  );
}
