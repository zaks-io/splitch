import { describe, expect, it } from "vitest";
import { robotsResponse } from "./robots[.]txt";

describe("robots.txt", () => {
  it("disallows every crawler on the whole authenticated surface", async () => {
    const response = robotsResponse();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });
});
