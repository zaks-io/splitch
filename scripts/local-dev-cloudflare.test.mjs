import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  localDevCloudflareConfig,
  localDevServices,
} from "../apps/control-panel/local-dev-cloudflare.ts";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";

const envNames = [
  "SPLITCH_LOCAL_DEV_FLEET",
  "SPLITCH_LOCAL_DEV_GATEWAY_PORT",
  "ACCESS_TOKEN_SECRET",
];

test("full local configuration refuses hosted targets and missing run identity", (context) => {
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.SPLITCH_LOCAL_DEV_FLEET = "false";
  assert.equal(localDevCloudflareConfig(undefined, "production", true), undefined);
  process.env.SPLITCH_LOCAL_DEV_FLEET = "true";
  assert.throws(() => localDevCloudflareConfig(undefined, "local", false), /local E2E run ID/);
  assert.throws(() => localDevCloudflareConfig("test", "production", true), /local target/);
  process.env.SPLITCH_LOCAL_DEV_GATEWAY_PORT = "80";
  assert.throws(() => localDevCloudflareConfig("test", "local", false), /1024 to 65535/);
});

test("customizers replace original namespaces and keep fixture signing material out of the entry file", (context) => {
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.SPLITCH_LOCAL_DEV_FLEET = "true";
  process.env.SPLITCH_LOCAL_DEV_GATEWAY_PORT = "18800";
  process.env.ACCESS_TOKEN_SECRET = "fixture-private-signing-material";
  const plugin = localDevCloudflareConfig("test", "local", false);
  assert.equal(plugin.remoteBindings, false);
  assert.equal(plugin.auxiliaryWorkers.length, Object.keys(localDevServices).length);
  const namespaces = new Map();
  for (const worker of plugin.auxiliaryWorkers) {
    assert.equal(worker.devOnly, true);
    const original = parseWranglerConfigFile(worker.configPath);
    const customized = worker.config(original);
    assert.equal(customized.kv_namespaces, undefined);
    for (const namespace of original.kv_namespaces ?? []) {
      const previousId = namespaces.get(namespace.binding);
      if (previousId) assert.equal(namespace.id, previousId, `${namespace.binding} must be shared`);
      namespaces.set(namespace.binding, namespace.id);
    }
  }
  assert.notEqual(namespaces.get("CONFIG_STORE"), namespaces.get("SESSION_STORE"));
  const entry = parseWranglerConfigFile("apps/control-panel/wrangler.jsonc");
  const existingServices = [...entry.services];
  const customized = plugin.config(entry);
  assert.equal(customized.services, undefined);
  assert.deepEqual(entry.services.slice(0, existingServices.length), existingServices);
  const localServices = entry.services.filter((service) => service.binding.startsWith("LOCAL_"));
  assert.equal(localServices.length, Object.keys(localDevServices).length);
  assert.equal(new Set(localServices.map((service) => service.binding)).size, localServices.length);
  const source = readFileSync(customized.main, "utf8");
  assert.equal(source.includes(process.env.ACCESS_TOKEN_SECRET), false);
  const invalid = {
    name: "invalid",
    vars: { SPLITCH_PLATFORM_TARGET: "local" },
    secrets: { required: ["UNKNOWN_SECRET"] },
  };
  assert.throws(
    () => plugin.auxiliaryWorkers[0].config(invalid),
    /explicit fixture for UNKNOWN_SECRET/,
  );
});
