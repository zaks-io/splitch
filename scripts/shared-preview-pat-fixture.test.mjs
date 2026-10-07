import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokenId = `pat_${"a".repeat(32)}`;
const pat = `spl_pat_${"b".repeat(64)}`;
const controlPlaneToken = "fixture.payload.signature";
const scenarios = [
  "success",
  "body-failure",
  "invalid-secret",
  "revoke-failure",
  "revoke-no-op",
  "revoke-network-failure",
  "mcp-network-failure",
];

// Exercise the real Playwright fixture lifecycle over HTTP, including teardown errors.
test("shared-preview MCP PAT fixture mints once and revokes on success and failure", async (t) => {
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const state = { minted: 0, revoked: 0, calls: 0 };
      const server = createServer((request, response) =>
        handleRequest(request, response, scenario, state),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const artifactsRoot = resolve(repoRoot, "test-results");
      await mkdir(artifactsRoot, { recursive: true });
      const directory = await mkdtemp(resolve(artifactsRoot, "pat-fixture-"));
      try {
        // On GitHub Actions Playwright embeds the PR diff in report metadata by default, and this
        // file's fixture secrets are in that diff, so the leak assertions would scan our own source.
        await writeFile(
          resolve(directory, "playwright.config.ts"),
          `
import config from "../../tests/shared-preview/playwright.config";
export default { ...config, testDir: ${JSON.stringify(directory)}, retries: 0,
  captureGitInfo: { commit: false, diff: false },
  reporter: [["line"], ["json", { outputFile: ${JSON.stringify(resolve(directory, "report.json"))} }]], outputDir: ${JSON.stringify(resolve(directory, "results"))},
  projects: config.projects?.filter(project => project.name === "api") };
`,
        );
        await writeFile(
          resolve(directory, "fixture.spec.ts"),
          `
import { test } from "../../tests/shared-preview/fixtures";
test.use({ smokeConfig: {
  authBaseUrl: ${JSON.stringify(origin)}, controlPlaneBaseUrl: ${JSON.stringify(origin)},
  mcpBaseUrl: ${JSON.stringify(origin)}, mcpProtectedResource: ${JSON.stringify(`${origin}/mcp`)},
  panelBaseUrl: ${JSON.stringify(origin)}, expectedPlatformTarget: "shared-preview",
  expectedCommitSha: "${"a".repeat(40)}", healthRoutes: [], runId: "fixture",
  smokeOrgId: "org_fixture", smokeOrgSlug: "fixture", smokeAppId: "app_fixture",
  smokeClientId: "fixture", smokeClientSecret: "fixture-only",
  smokeEnvironmentId: "env_fixture", smokeFlagId: "flag_fixture", smokeFlagKey: "fixture"
} });
test("uses the PAT fixture", async ({ mcpPersonalAccessToken, smoke }) => {
  await smoke.listTools(mcpPersonalAccessToken);
  await smoke.listTools(mcpPersonalAccessToken);
  ${scenario === "body-failure" ? 'throw new Error("intentional body failure");' : ""}
});
`,
        );
        const { code, output } = await runPlaywright(resolve(directory, "playwright.config.ts"));
        verifyResult(scenario, state, code, output);
        verifyNoSecrets(await readFile(resolve(directory, "report.json"), "utf8"));
        const artifacts = await readdir(directory, { recursive: true });
        assert.equal(
          artifacts.some((file) => file.endsWith(".zip")),
          false,
          "API smoke must not retain secret-bearing traces",
        );
      } finally {
        server.close();
        await once(server, "close");
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

async function runPlaywright(config) {
  const child = spawn("pnpm", ["exec", "playwright", "test", "-c", config], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, output };
}

async function handleRequest(request, response, scenario, state) {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    assert.match(request.headers["user-agent"], /^splitch-shared-preview-smoke\//);
    response.setHeader("content-type", "application/json");
    const routes = {
      "/oauth2/token": () => {
        assert.match(request.headers["content-type"], /^application\/x-www-form-urlencoded/);
        assert.equal(new URLSearchParams(raw).get("grant_type"), "client_credentials");
        return { token_type: "Bearer", access_token: controlPlaneToken, expires_in: 3600 };
      },
      "/personal-access-tokens": () => mintPat(request, raw, scenario, state),
      [`/personal-access-tokens/${tokenId}/revoke`]: () => {
        assert.equal(request.headers.authorization === `Bearer ${controlPlaneToken}`, true);
        state.revoked++;
        if (scenario === "revoke-network-failure") response.destroy();
        response.statusCode = scenario === "revoke-failure" ? 500 : 200;
        return { revokedAt: scenario === "revoke-no-op" ? null : new Date().toISOString() };
      },
      "/mcp": () => {
        assert.equal(request.headers["content-type"], "application/json");
        assert.equal(request.headers.authorization === `Bearer ${pat}`, true);
        state.calls++;
        if (scenario === "mcp-network-failure") response.destroy();
        return { jsonrpc: "2.0", id: "tools-list-smoke", result: { tools: [] } };
      },
    };
    assert.ok(routes[request.url]);
    response.end(JSON.stringify(routes[request.url]()));
  } catch {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "fixture request contract failed" }));
  }
}

function mintPat(request, raw, scenario, state) {
  assert.equal(request.headers.authorization === `Bearer ${controlPlaneToken}`, true);
  assert.equal(request.headers["content-type"], "application/json");
  const body = JSON.parse(raw);
  assert.deepEqual(body.grants, [
    { target: "org:org_fixture", role: "admin", access: "read-write" },
  ]);
  const ttl = Date.parse(body.expiresAt) - Date.now();
  assert.ok(ttl > 3_590_000 && ttl <= 3_600_000);
  state.minted++;
  return {
    token: { id: tokenId },
    secret: scenario === "invalid-secret" ? "invalid-pat-fixture" : pat,
  };
}

function verifyResult(scenario, state, code, output) {
  verifyNoSecrets(output);
  assert.equal(code, scenario === "success" ? 0 : 1);
  assert.deepEqual(state, {
    minted: 1,
    revoked: 1,
    calls: scenario === "invalid-secret" ? 0 : scenario === "mcp-network-failure" ? 1 : 2,
  });
  const expectedErrors = {
    "body-failure": /intentional body failure/,
    "invalid-secret": /created PAT secret is valid/,
    "revoke-failure": /Control Plane POST .*revoke/,
    "revoke-no-op": /smoke PAT was revoked/,
    "revoke-network-failure": /revoke/,
    "mcp-network-failure": /MCP|mcp/,
  };
  if (expectedErrors[scenario]) assert.match(output, expectedErrors[scenario]);
}

function verifyNoSecrets(output) {
  assert.equal(output.includes(pat), false, "PAT must not appear in failure output");
  assert.equal(
    output.includes(controlPlaneToken),
    false,
    "Control Plane token must not appear in failure output",
  );
  assert.equal(
    output.includes("invalid-pat-fixture"),
    false,
    "malformed secret must not appear in failure output",
  );
}
