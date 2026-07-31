import { afterEach, describe, expect, it, vi } from "vitest";

const observability = vi.hoisted(() => ({
  captureException: vi.fn(),
  shutdown: vi.fn(async () => {}),
}));
const executeInvocation = vi.hoisted(() => vi.fn());

vi.mock("@splitch/observability", () => ({
  initCliObservability: () => ({ captureException: observability.captureException }),
  shutdownCliObservability: observability.shutdown,
}));
vi.mock("./execute.js", () => ({ executeInvocation }));

import { runCli } from "./cli.js";
import { EXIT_USAGE } from "./exit-codes.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CLI observability", () => {
  it("captures a non-CLI execution error before rendering it", async () => {
    const thrown = new Error("unexpected execution failure");
    executeInvocation.mockRejectedValueOnce(thrown);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["health"])).resolves.toBe(EXIT_USAGE);

    expect(observability.captureException).toHaveBeenCalledOnce();
    expect(observability.captureException).toHaveBeenCalledWith(thrown);
  });
});
