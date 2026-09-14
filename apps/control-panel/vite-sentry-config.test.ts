import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/vite-plugin", () => ({ cloudflare: vi.fn() }));
vi.mock("@tailwindcss/vite", () => ({ default: vi.fn() }));
vi.mock("@tanstack/react-start/plugin/vite", () => ({ tanstackStart: vi.fn() }));
vi.mock("@vitejs/plugin-react", () => ({ default: vi.fn() }));
vi.mock("../../scripts/lib/vite-worker-sentry-config", () => ({
  readViteWorkerConfig: () => ({
    name: "splitch-control-panel",
    vars: { SENTRY_DSN: "https://public@example.ingest.sentry.io/1" },
  }),
  resolveViteSentryRelease: () => "test-release",
}));
vi.mock("../../scripts/lib/vite-cloudflare-web-analytics-config", () => ({
  resolveViteCloudflareWebAnalyticsToken: () => "",
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Control Panel browser Sentry configuration", () => {
  it.each([undefined, "https://override@example.ingest.sentry.io/2"])(
    "disables browser delivery in local E2E even with DSN override %s",
    async (dsn) => {
      vi.stubEnv("SPLITCH_LOCAL_E2E_RUN_ID", "test-run");
      vi.stubEnv("VITE_SENTRY_DSN", dsn);
      vi.stubEnv("SPLITCH_PLATFORM_TARGET", "pr-ci");
      expect(await browserDsn()).toBe('""');
    },
  );

  it.each([
    [undefined, "https://public@example.ingest.sentry.io/1"],
    ["https://override@example.ingest.sentry.io/2", "https://override@example.ingest.sentry.io/2"],
  ])("preserves configured delivery outside E2E with override %s", async (dsn, expected) => {
    vi.stubEnv("SPLITCH_LOCAL_E2E_RUN_ID", undefined);
    vi.stubEnv("VITE_SENTRY_DSN", dsn);
    expect(await browserDsn()).toBe(JSON.stringify(expected));
  });
});

async function browserDsn() {
  const { default: config } = await import("./vite.config");
  const resolved = await (typeof config === "function"
    ? config({ command: "serve", mode: "development" })
    : config);
  return resolved.define?.["import.meta.env.VITE_SENTRY_DSN"];
}
