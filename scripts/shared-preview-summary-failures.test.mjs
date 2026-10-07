import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sha = "a".repeat(40);
const directory = mkdtempSync(join(tmpdir(), "spl-725-summary-"));
const evidencePath = join(directory, "evidence.json");
writeFileSync(
  evidencePath,
  JSON.stringify({
    deployedCommitSha: sha,
    platformTarget: "shared-preview",
    routes: [{ surface: "MCP", url: "https://mcp.example.test/health" }],
  }),
);

test("failed API smoke is annotated and names skipped phases without failing the deploy", () => {
  const result = summary({
    SPLITCH_SMOKE_OUTCOME: "failure",
    SPLITCH_DARK_LAUNCH_OUTCOME: "skipped",
    SPLITCH_SAFE_DELIVERY_OUTCOME: "skipped",
    SPLITCH_PANEL_BROWSER_OUTCOME: "skipped",
    SPLITCH_PANEL_SEED_OUTCOME: "skipped",
    SPLITCH_PANEL_SMOKE_OUTCOME: "skipped",
    SPLITCH_ARTIFACT_OUTCOME: "success",
    SPLITCH_SMOKE_EVIDENCE_FILE: join(directory, "missing.json"),
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /::error title=Shared preview smoke failed::API smoke failed/);
  assert.match(result.stderr, /deployment outcome: success/);
  assert.match(result.stdout, /## Shared preview smoke failed/);
  assert.match(result.stdout, /Failed phases: API smoke\./);
  assert.match(
    result.stdout,
    /Skipped phases: Dark-launch, Safe-delivery, Panel browser install, Panel login seed, Panel golden path\./,
  );
  assert.match(result.stdout, /Deployment outcome: `success`/);
  assert.match(result.stdout, /Cleanup outcome: `success`/);
  assert.doesNotMatch(result.stdout, /Verified smoke evidence/);
});

test("every failed post-deploy phase emits an annotation, including cleanup and artifacts", () => {
  for (const [name, phase] of [
    ["SEED", "Seed"],
    ["DARK_LAUNCH", "Dark-launch"],
    ["SAFE_DELIVERY", "Safe-delivery"],
    ["PANEL_BROWSER", "Panel browser install"],
    ["PANEL_SEED", "Panel login seed"],
    ["PANEL_SMOKE", "Panel golden path"],
    ["CLEANUP", "Cleanup"],
    ["ARTIFACT", "Failure artifact"],
  ]) {
    const result = summary({ [`SPLITCH_${name}_OUTCOME`]: "failure" });
    assert.equal(result.status, 0);
    assert.ok(result.stderr.includes(`::${phase} failed; deployment outcome: success.`));
    assert.ok(result.stdout.includes(`Failed phases: ${phase}.`));
  }
});

test("successful smoke has no failure banner or annotation and retains verified evidence", () => {
  const result = summary();
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /## Shared preview smoke\n/);
  assert.match(result.stdout, /Verified smoke evidence/);
  assert.doesNotMatch(result.stdout, /Failed phases:|Skipped phases:/);
});

function summary(overrides = {}) {
  return spawnSync(process.execPath, ["scripts/render-shared-preview-summary.mjs", "smoke"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      SPLITCH_WORKFLOW_REF: sha,
      SPLITCH_SMOKE_EVIDENCE_FILE: evidencePath,
      ...Object.fromEntries(
        [
          "DEPLOY",
          "SEED",
          "SMOKE",
          "DARK_LAUNCH",
          "SAFE_DELIVERY",
          "PANEL_BROWSER",
          "PANEL_SEED",
          "PANEL_SMOKE",
          "CLEANUP",
        ].map((name) => [`SPLITCH_${name}_OUTCOME`, "success"]),
      ),
      SPLITCH_ARTIFACT_OUTCOME: "skipped",
      ...overrides,
    },
  });
}
