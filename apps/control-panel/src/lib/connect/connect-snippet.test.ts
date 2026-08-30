import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderConnectSnippet,
  renderServerConnectSnippet,
  SDK_INSTALL_COMMAND,
} from "#lib/connect/connect-snippet";

const snippet = renderConnectSnippet({
  clientKey: "pk_example",
  flagKey: "new-checkout",
});

describe("renderConnectSnippet", () => {
  it("substitutes the real Client Key and Flag Key", () => {
    expect(snippet).toContain('createSplitchClient({ clientKey: "pk_example" })');
    expect(snippet).toContain('await splitch.evaluate("new-checkout"');
    expect(snippet).not.toContain("...");
  });

  // The card calls this a copy-paste snippet, so every identifier it references
  // must be declared in it. `targetingKey: userId` with no `userId` in scope is
  // a ReferenceError on paste, not a placeholder.
  it("leaves no free variable behind", () => {
    expect(snippet).toContain('const userId = "user-1";');
    for (const identifier of snippet.matchAll(/^\s*(?:targetingKey|idempotencyKey): (\w+),$/gm)) {
      expect(snippet).toContain(`const ${identifier[1]} =`);
    }
    expect(renderServerConnectSnippet({ flagKey: "f" })).toContain('const userId = "user-1";');
  });

  it("carries a stable idempotency input for the logical Evaluation", () => {
    expect(snippet).toContain("const evaluationId = crypto.randomUUID();");
    expect(snippet).toContain("idempotencyKey: evaluationId,");
  });

  it("does not pass appId, which the shipped client does not accept", () => {
    expect(snippet).not.toContain("appId");
  });

  it("escapes a Flag Key containing quotes rather than breaking the snippet", () => {
    const risky = renderConnectSnippet({ clientKey: "pk_test", flagKey: 'we"ird' });
    expect(risky).toContain('await splitch.evaluate("we\\"ird"');
  });
});

/**
 * The spec's illustrative snippet and the shipped one have already drifted apart
 * once (it promised an `appId` the client does not accept). Comparing them here
 * makes the next drift a failing test rather than a review finding.
 */
describe("screen-inventory.md", () => {
  it("documents exactly what the panel renders", () => {
    const spec = readFileSync(
      fileURLToPath(
        new URL("../../../../../docs/spec/frontend/screen-inventory.md", import.meta.url),
      ),
      "utf8",
    );
    const onboarding = spec.slice(spec.indexOf("Connect your code"));
    const fence = onboarding.match(/```ts\n([\s\S]*?)```/);
    const documented = (fence?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^ {3}/, ""))
      .join("\n")
      .trimEnd();

    expect(documented).toBe(renderConnectSnippet({ clientKey: "pk_…", flagKey: "your-flag-key" }));
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
