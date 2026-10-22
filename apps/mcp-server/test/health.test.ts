import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("answers GET and HEAD health without authentication", async () => {
  const get = await SELF.fetch("https://mcp.test/health");
  const head = await SELF.fetch("https://mcp.test/health", { method: "HEAD" });
  expect(get.status).toBe(200);
  expect(await get.json()).toMatchObject({
    ok: true,
    service: "splitch-mcp-server",
    platformTarget: "local",
  });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
});
