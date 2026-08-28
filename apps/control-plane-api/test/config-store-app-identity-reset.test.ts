import { describe, expect, it } from "vitest";
import {
  type ConfigStoreDurableObjectNamespace,
  durableAppIdentityResetAccess,
} from "../src/config-store-do.js";

describe("durableAppIdentityResetAccess", () => {
  it("routes independent production callers through the same App-scoped Config Store DO", async () => {
    const names: string[] = [];
    const resets: Array<{ appId: string; resetId: string }> = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        return {
          async resetCompromisedAppIdentity(appId: string, resetId: string) {
            resets.push({ appId, resetId });
            return "app-v2";
          },
        };
      },
    } as unknown as ConfigStoreDurableObjectNamespace;
    const firstClient = durableAppIdentityResetAccess(namespace);
    const secondClient = durableAppIdentityResetAccess(namespace);

    await expect(
      Promise.all([
        firstClient.resetCompromisedAppIdentity("app-checkout", "reset-compromised"),
        secondClient.resetCompromisedAppIdentity("app-checkout", "reset-compromised"),
      ]),
    ).resolves.toEqual(["app-v2", "app-v2"]);
    expect(names).toEqual(["app-identity:app-checkout", "app-identity:app-checkout"]);
    expect(resets).toEqual([
      { appId: "app-checkout", resetId: "reset-compromised" },
      { appId: "app-checkout", resetId: "reset-compromised" },
    ]);
  });
});
