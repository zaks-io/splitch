import { afterEach, expect, it, vi } from "vitest";
import { __setSentryModuleForTests } from "./sentry-module.js";
import { nameWorkerRouteSpans } from "./worker-route-spans.js";

afterEach(() => __setSentryModuleForTests(undefined));

it.each(["POST", "GET", "DELETE"])("names native and SDK MCP roots for %s /", (method) => {
  const native = { updateName: vi.fn(), setAttribute: vi.fn() };
  const root = { setAttribute: vi.fn() };
  const updateSpanName = vi.fn();
  __setSentryModuleForTests({
    getActiveSpan: () => ({}),
    getRootSpan: () => root,
    updateSpanName,
  } as never);
  nameWorkerRouteSpans(
    { SENTRY_DSN: "https://public@sentry.invalid/1" },
    { surface: "mcp-server", tracing: { getActiveSpan: () => native } as never },
    { method, path: "/" },
  );
  expect(native.updateName).toHaveBeenCalledWith(`${method} /`);
  expect(native.setAttribute).toHaveBeenCalledWith("http.route", "/");
  expect(updateSpanName).toHaveBeenCalledWith(root, `${method} /`);
  expect(root.setAttribute).toHaveBeenCalledWith("http.route", "/");
});

it.each([
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
])("uses the fixed route %s without a Sentry DSN", (path) => {
  const native = { updateName: vi.fn(), setAttribute: vi.fn() };
  nameWorkerRouteSpans(
    {},
    { surface: "mcp-server", tracing: { getActiveSpan: () => native } as never },
    { method: "GET", path },
  );
  expect(native.updateName).toHaveBeenCalledWith(`GET ${path}`);
});

it("leaves unmatched concrete MCP paths out of root names", () => {
  const native = { updateName: vi.fn(), setAttribute: vi.fn() };
  nameWorkerRouteSpans(
    {},
    { surface: "mcp-server", tracing: { getActiveSpan: () => native } as never },
    { method: "GET", path: "/private-customer" },
  );
  expect(native.updateName).not.toHaveBeenCalled();
  expect(native.setAttribute).not.toHaveBeenCalled();
});
