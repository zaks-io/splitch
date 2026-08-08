import { describe, expect, it } from "vitest";
import { rejectCrossOriginWrite } from "./panel-csrf";

describe("rejectCrossOriginWrite", () => {
  it.each([
    ["missing Origin", {}],
    ["evil Origin", { origin: "https://evil.example" }],
    ["same-site sibling Origin", { origin: "https://auth.splitch.dev" }],
  ])("rejects %s with 403", async (_name, headers) => {
    const response = rejectCrossOriginWrite(
      new Request("https://app.splitch.dev/auth/logout", { method: "POST", headers }),
    );

    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("allows a same-origin Origin", () => {
    const response = rejectCrossOriginWrite(
      new Request("https://app.splitch.dev/auth/logout", {
        method: "POST",
        headers: { origin: "https://app.splitch.dev" },
      }),
    );

    expect(response).toBeNull();
  });
});
