import { afterEach, describe, expect, it, vi } from "vitest";
import { missingAnalysisBindingCall } from "./mcp-control-plane-dispatch.test-fixture";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP live Control Plane dispatch", () => {
  it("names only the operation, never the owner, when the real Control Plane's binding is missing", async () => {
    // Reproduces the SPL-313 finding by hand: dispatch through the real
    // handleMcpServerRequest -> real control-plane-api createApp, with
    // ANALYSIS_API deliberately unbound (delegationBindings: {}), exactly as an
    // agent on the MCP door would see it. Restoring the owner-naming message in
    // delegated-routes.ts's missingOwnerBinding must turn this red.
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const body = await missingAnalysisBindingCall();

    expect(body).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          code: "SERVICE_UNAVAILABLE",
          message: "experiment_results_post is temporarily unavailable",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("analysis-api");
    expect(
      logged.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("experiment_results_post") &&
            arg.includes("analysis-api"),
        ),
      ),
      `expected an operator console.error naming both the operation and the owner, got: ${JSON.stringify(logged)}`,
    ).toBe(true);
  });
});
