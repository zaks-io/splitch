import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const proof = new URL("./lib/tinybird-app-audit-proof.mjs", import.meta.url).href;
const buildToken = "test-build-workspace-token";
const readToken = "test-endpoint-read-token";

function runProof(context, pipes) {
  const dir = mkdtempSync(join(tmpdir(), "splitch-audit-workspace-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const received = join(dir, "received.json");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tb"),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("info")) {
  process.stdout.write(JSON.stringify({ local: {
    token: "test-default-workspace-token", user_token: "test-local-user-token",
  } }));
} else if (args.includes("endpoint") && args.includes("ls")) {
  process.stdout.write(JSON.stringify({ pipes: ${JSON.stringify(pipes)} }));
} else {
  process.exit(2);
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(received)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  correctToken: process.env.SPLITCH_TEST_TINYBIRD_TOKEN === ${JSON.stringify(buildToken)},
  apiUrl: process.env.SPLITCH_TEST_TINYBIRD_API_URL,
}));
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
import { proveAppAuditBoundary } from ${JSON.stringify(proof)};
globalThis.fetch = async (url, init) => {
  if (url.pathname === "/v1/workspace") {
    assert.equal(init.headers.authorization, ${JSON.stringify(`Bearer ${readToken}`)});
    return Response.json({ id: "built-workspace" });
  }
  assert.equal(url.pathname, "/v1/user/workspaces");
  assert.equal(init.headers.authorization, "Bearer test-local-user-token");
  return Response.json({ workspaces: [
    { id: "default-workspace", token: "test-default-workspace-token" },
    { id: "built-workspace", token: ${JSON.stringify(buildToken)} },
  ] });
};
await proveAppAuditBoundary(${JSON.stringify(dir)});`,
    ],
    {
      env: {
        ...process.env,
        GITHUB_HEAD_REF: "spl-161-app-audit-events",
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return {
    result,
    received: result.status === 0 ? JSON.parse(readFileSync(received, "utf8")) : null,
  };
}

test("the audit proof uses the built endpoint workspace instead of the default info workspace", (context) => {
  const { result, received } = runProof(context, [
    {
      name: "app_audit_events",
      url: `http://localhost:7181/v0/pipes/app_audit_events.json?token=${readToken}`,
    },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(received.correctToken, true);
  assert.equal(received.apiUrl, "http://localhost:7181");
  assert.equal(received.cwd, process.cwd());
  assert.deepEqual(received.args, [
    "--filter",
    "@splitch/control-plane-api",
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.config.audit-integration.ts",
  ]);
  assert.equal(`${result.stdout}${result.stderr}`.includes(buildToken), false);
});

for (const [label, pipes] of [
  ["missing endpoint", []],
  [
    "missing token",
    [{ name: "app_audit_events", url: "http://localhost:7181/v0/pipes/app_audit_events.json" }],
  ],
  [
    "nonlocal endpoint",
    [
      {
        name: "app_audit_events",
        url: `https://api.tinybird.co/v0/pipes/app_audit_events.json?token=${buildToken}`,
      },
    ],
  ],
]) {
  test(`the audit proof refuses a ${label}`, (context) => {
    const { result } = runProof(context, pipes);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Tinybird Local App audit/);
    assert.equal(`${result.stdout}${result.stderr}`.includes(buildToken), false);
  });
}
