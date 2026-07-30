import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const panelConfig = JSON.parse(
  readFileSync(join(repoRoot, "apps/control-panel/wrangler.jsonc"), "utf8"),
);
const planeConfig = JSON.parse(
  readFileSync(join(repoRoot, "apps/control-plane-api/wrangler.jsonc"), "utf8"),
);
const rollbackScript = join(repoRoot, "scripts/rollback-control-panel-binding.mjs");
const compatDeployScript = join(repoRoot, "scripts/deploy-control-plane-compat.mjs");
const protocolPairs = new Set(["base:base", "base:compat", "signed:compat", "signed:final"]);

for (const environment of ["production", "shared-preview"]) {
  test(`${environment} deploy keeps every protocol transition functional`, () => {
    const rollout = packageJson.scripts[`deploy:cloudflare:${environment}`];
    const stages = [
      `control-plane-compat:${environment}`,
      `control-panel:${environment}`,
      `control-plane:${environment}`,
      `credential-cache:backfill:${environment}`,
      `remaining:${environment}`,
    ];

    const positions = stages.map((stage) => rollout.indexOf(stage));
    assert.equal(
      positions.every((position) => position >= 0),
      true,
    );
    assert.equal(
      positions.every((position, index) => index === 0 || positions[index - 1] < position),
      true,
    );
    assert.match(
      packageJson.scripts[`deploy:cloudflare:control-plane-compat:${environment}`],
      new RegExp(`deploy-control-plane-compat\\.mjs ${environment}$`, "u"),
    );
    assert.doesNotMatch(
      packageJson.scripts[`deploy:cloudflare:control-plane:${environment}`],
      /bounded-rollout/u,
    );
    assert.match(
      packageJson.scripts[`deploy:cloudflare:remaining:${environment}`],
      /!@splitch\/control-panel/u,
    );
  });

  test(`${environment} final config binds only signed V2 and disables predecessor sessions`, () => {
    const panelTarget =
      environment === "production" ? panelConfig.env.production : panelConfig.env[environment];
    const planeTarget =
      environment === "production" ? planeConfig.env.production : planeConfig.env[environment];

    assert.deepEqual(
      panelTarget.services.find((service) => service.binding === "CONTROL_PLANE_API"),
      {
        binding: "CONTROL_PLANE_API",
        service:
          environment === "production"
            ? "splitch-control-plane-api"
            : "splitch-control-plane-api-shared-preview",
        entrypoint: "SignedControlPanelEntrypoint",
      },
    );
    assert.equal(planeTarget.vars.CONTROL_PANEL_LEGACY_SESSION_MODE, "disabled");
    assert.equal(planeTarget.vars.CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT, "0");
  });
}

test("every forward failure boundary leaves an interoperable active protocol pair", () => {
  const activePairAfterFailure = [
    ["base", "base"],
    ["base", "compat"],
    ["signed", "compat"],
    ["signed", "final"],
    ["signed", "final"],
  ];

  for (const [panel, plane] of activePairAfterFailure) {
    assertProtocolAvailable(panel, plane);
  }
});

test("every rollback failure boundary leaves an interoperable active protocol pair", () => {
  const activePairAfterFailure = [
    ["signed", "final"],
    ["signed", "compat"],
    ["base", "compat"],
  ];

  for (const [panel, plane] of activePairAfterFailure) {
    assertProtocolAvailable(panel, plane);
  }
});

test("compatibility deploy enables predecessor sessions with a self-expiring deadline", () => {
  const fixture = makeFakePnpm();
  const before = Math.floor(Date.now() / 1000);
  const result = spawnSync(process.execPath, [compatDeployScript, "production"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      SPLITCH_FAKE_PNPM_CALLS: fixture.callsPath,
      SPLITCH_FAKE_PNPM_FAIL_CALL: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = readCalls(fixture.callsPath);
  assert.deepEqual(calls[0], ["turbo", "run", "build", "--filter=@splitch/control-plane-api"]);
  assert.deepEqual(calls[1].slice(0, 6), [
    "turbo",
    "run",
    "deploy",
    "--only",
    "--filter=@splitch/control-plane-api",
    "--",
  ]);
  assert.equal(calls[1].includes("CONTROL_PANEL_LEGACY_SESSION_MODE:bounded-rollout"), true);
  const expiry = calls[1].find((arg) => arg.startsWith("CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT:"));
  const expiresAt = Number(expiry?.split(":", 2)[1]);
  assert.ok(expiresAt >= before + 30 * 60);
  assert.ok(expiresAt <= Math.floor(Date.now() / 1000) + 30 * 60);
});

test("completed rollback keeps self-expiring compatibility authority active", () => {
  const fixture = makeFakePnpm();
  const before = Math.floor(Date.now() / 1000);
  const result = runRollback(fixture);

  assert.equal(result.status, 0, result.stderr);
  const calls = readCalls(fixture.callsPath);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["turbo", "run", "build", "--filter=@splitch/control-plane-api"]);
  assert.deepEqual(calls[1].slice(0, 11), [
    "turbo",
    "run",
    "deploy",
    "--only",
    "--filter=@splitch/control-plane-api",
    "--",
    "--env",
    "production",
    "--strict",
    "--var",
    "CONTROL_PANEL_LEGACY_SESSION_MODE:bounded-rollout",
  ]);
  const expiry = calls[1].find((arg) => arg.startsWith("CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT:"));
  const expiresAt = Number(expiry?.split(":", 2)[1]);
  assert.ok(expiresAt >= before + 30 * 60);
  assert.ok(expiresAt <= Math.floor(Date.now() / 1000) + 30 * 60);
  assert.deepEqual(calls[2].slice(0, 7), [
    "--dir",
    "apps/control-panel",
    "exec",
    "wrangler",
    "versions",
    "deploy",
    "11111111-1111-1111-1111-111111111111@100%",
  ]);
  assertProtocolAvailable("base", "compat");
});

test("rollback leaves compatibility authority active if the Panel cannot be activated", () => {
  const fixture = makeFakePnpm("3");
  const result = runRollback(fixture);

  assert.equal(result.status, 19);
  assert.equal(readCalls(fixture.callsPath).length, 3);
  assertProtocolAvailable("signed", "compat");
});

test("rollback leaves signed V2 active if the compatibility build fails", () => {
  const fixture = makeFakePnpm("1");
  const result = runRollback(fixture);

  assert.equal(result.status, 19);
  assert.equal(readCalls(fixture.callsPath).length, 1);
  assertProtocolAvailable("signed", "final");
});

test("rollback leaves signed V2 active if the compatibility deploy fails", () => {
  const fixture = makeFakePnpm("2");
  const result = runRollback(fixture);

  assert.equal(result.status, 19);
  assert.equal(readCalls(fixture.callsPath).length, 2);
  assertProtocolAvailable("signed", "final");
});

function runRollback(fixture) {
  return spawnSync(process.execPath, [rollbackScript, "production"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      SPLITCH_FAKE_PNPM_CALLS: fixture.callsPath,
      SPLITCH_FAKE_PNPM_FAIL_CALL: fixture.failCall,
      SPLITCH_ROLLBACK_CONTROL_PANEL_VERSION_ID: "11111111-1111-1111-1111-111111111111",
    },
  });
}

function makeFakePnpm(failCall = "0") {
  const root = mkdtempSync(join(tmpdir(), "splitch-panel-rollout-test-"));
  const binDir = join(root, "bin");
  const callsPath = join(root, "calls.jsonl");
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "pnpm"),
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const callsPath = process.env.SPLITCH_FAKE_PNPM_CALLS;
const count = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\\n").length : 0;
appendFileSync(callsPath, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(String(count + 1) === process.env.SPLITCH_FAKE_PNPM_FAIL_CALL ? 19 : 0);
`,
  );
  chmodSync(join(binDir, "pnpm"), 0o755);
  return { binDir, callsPath, failCall };
}

function readCalls(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function assertProtocolAvailable(panel, plane) {
  assert.equal(
    protocolPairs.has(`${panel}:${plane}`),
    true,
    `${panel} panel must interoperate with ${plane} Control Plane`,
  );
}
