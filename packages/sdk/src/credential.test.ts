import { describe, expect, it } from "vitest";
import { createSplitchClient } from "./client";
import { FakeTransport } from "./test-fixtures";

describe("createSplitchClient: credential prefixes", () => {
  it.each([
    ["clientKey", { clientKey: "pk_valid" }],
    ["apiKey", { apiKey: "sk_valid" }],
  ])("accepts a correctly prefixed %s", (_option, options) => {
    expect(() =>
      createSplitchClient({ ...options, transport: new FakeTransport([]) }),
    ).not.toThrow();
  });

  it.each([
    ["clientKey", { clientKey: "sk_secret" }, "pk_", "sk_secret"],
    ["clientKey", { clientKey: "ak_key_id" }, "pk_", "ak_key_id"],
    ["clientKey", { clientKey: "invalid" }, "pk_", "invalid"],
    ["apiKey", { apiKey: "pk_public" }, "sk_", "pk_public"],
    ["apiKey", { apiKey: "invalid" }, "sk_", "invalid"],
  ])("rejects the wrong prefix for %s without echoing it", (_option, options, expectedPrefix, credential) => {
    let thrown: unknown;
    try {
      createSplitchClient({ ...options, transport: new FakeTransport([]) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "SDK_CREDENTIAL_CONFIGURATION_INVALID" });
    expect((thrown as Error).message).toContain(expectedPrefix);
    expect((thrown as Error).message).not.toContain(credential);
  });
});
