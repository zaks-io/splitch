import { describe, expect, it } from "vitest";
import {
  renderConnectSnippet,
  renderServerConnectSnippet,
  SDK_INSTALL_COMMAND,
} from "./connect-snippet";

const snippet = renderConnectSnippet({
  clientKey: "ck_example",
  flagKey: "new-checkout",
});

describe("renderConnectSnippet", () => {
  it("substitutes the real Client Key and Flag Key", () => {
    expect(snippet).toContain('createSplitchClient({ clientKey: "ck_example" })');
    expect(snippet).toContain('await splitch.evaluate("new-checkout"');
    expect(snippet).not.toContain("...");
  });

  it("carries a stable idempotency input for the logical Evaluation", () => {
    expect(snippet).toContain("const evaluationId = crypto.randomUUID();");
    expect(snippet).toContain("idempotencyKey: evaluationId,");
  });

  it("does not pass appId, which the shipped client does not accept", () => {
    expect(snippet).not.toContain("appId");
  });

  it("escapes a Flag Key containing quotes rather than breaking the snippet", () => {
    const risky = renderConnectSnippet({ clientKey: "ck", flagKey: 'we"ird' });
    expect(risky).toContain('await splitch.evaluate("we\\"ird"');
  });
});

describe("renderServerConnectSnippet", () => {
  it("reads the API Key from the environment and never inlines one", () => {
    const server = renderServerConnectSnippet({ flagKey: "new-checkout" });
    expect(server).toContain("apiKey: process.env.SPLITCH_API_KEY");
    expect(server).not.toContain("sk_");
  });
});

describe("SDK_INSTALL_COMMAND", () => {
  it("installs the published package name", () => {
    expect(SDK_INSTALL_COMMAND).toBe("npm install @splitch/sdk");
  });
});
