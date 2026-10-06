import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = join(repoRoot, "scripts/check-tinybird-local.mjs");
const fixtureClock = new URL("./lib/tinybird-fixture-clock.mjs", import.meta.url).href;

function sandbox(context) {
  const base = mkdtempSync(join(tmpdir(), "tinybird-cleanup-test-"));
  const temp = join(base, "temp");
  mkdirSync(temp);
  const preserved = join(temp, "splitch-tinybird-local-preserved");
  mkdirSync(preserved);
  writeFileSync(join(preserved, "user-file"), "preserve me");
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, temp, preserved };
}

function assertOnlyPreservedDirectory({ temp, preserved }) {
  assert.deepEqual(readdirSync(temp), ["splitch-tinybird-local-preserved"]);
  assert.equal(readFileSync(join(preserved, "user-file"), "utf8"), "preserve me");
}

function fakeCli(base, source) {
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tb"), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return bin;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`the checker removes only its staged directory and preserves ${signal} termination`, {
    timeout: 15_000,
  }, async (context) => {
    const area = sandbox(context);
    const ready = join(area.base, "ready.json");
    const bin = fakeCli(
      area.base,
      `require("node:fs").writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
setInterval(() => {}, 1000);`,
    );
    const child = spawn(process.execPath, [checker], {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: area.temp, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    let cliPid;
    context.after(() => {
      child.kill("SIGKILL");
      if (cliPid) {
        try {
          process.kill(cliPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
      await setTimeout(20);
    }
    assert.ok(existsSync(ready), `checker never reached its staged CLI: ${stderr}`);
    const { cwd, pid } = JSON.parse(readFileSync(ready, "utf8"));
    cliPid = pid;
    assert.equal(cwd.startsWith(join(realpathSync(area.temp), "splitch-tinybird-local-")), true);
    assert.ok(existsSync(join(cwd, "tinybird.config.json")));
    assert.equal(child.kill(signal), true);
    const [code, actualSignal] = await exited;
    assert.equal(code, null);
    assert.equal(actualSignal, signal);
    assert.equal(existsSync(cwd), false);
    assertOnlyPreservedDirectory(area);
  });
}

test("the checker removes its staged directory when CLI validation fails", (context) => {
  const area = sandbox(context);
  const bin = fakeCli(area.base, "process.exit(42);");
  const result = spawnSync(process.execPath, [checker], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: area.temp, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tinybird CLI command `tb` is required/);
  assertOnlyPreservedDirectory(area);
});

for (const failure of ["copy", "date shift"]) {
  test(`staging removes its partial copy after a ${failure} failure`, (context) => {
    const area = sandbox(context);
    cpSync(join(repoRoot, "infra/tinybird"), join(area.base, "tb"), { recursive: true });
    writeFileSync(join(area.base, "config.json"), "{}");
    if (failure === "date shift") {
      writeFileSync(join(area.base, "tb/tests/invalid.yaml"), "date: 2026-02-30\n");
    }
    const configPath = failure === "copy" ? "missing-config.json" : "config.json";
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { stageTinybirdProject } from ${JSON.stringify(fixtureClock)};
stageTinybirdProject({ configPath: ${JSON.stringify(configPath)}, root: "tb", now: Date.now() });`,
      ],
      {
        cwd: area.base,
        env: { ...process.env, TMPDIR: area.temp },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, failure === "copy" ? /ENOENT/ : /not a calendar date/);
    assertOnlyPreservedDirectory(area);
    assert.equal(readFileSync(join(area.base, "config.json"), "utf8"), "{}");
    assert.ok(existsSync(join(area.base, "tb/fixtures/raw_events.ndjson")));
  });
}
