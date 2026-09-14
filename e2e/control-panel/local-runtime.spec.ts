import { expect, test } from "@playwright/test";

test("local Workers retain their target when launched from CI", async ({ request }) => {
  for (const port of [18790, 18793]) {
    const response = await request.get(`http://127.0.0.1:${port}/health`);
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ platformTarget: "local" });
  }
});
