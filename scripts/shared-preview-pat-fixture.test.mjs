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
  "request-network-failure",
];

test("configured preview smoke authority allows the delivered finite grants and requires step-up for all or never", async () => {
  const config = await readFile(resolve(repoRoot, "apps/auth-api/wrangler.jsonc"), "utf8");
  const [, scopes] = config.match(/"SPLITCH_SMOKE_SCOPES": "([^"]+)"/) ?? [];
  assert.ok(scopes, "shared-preview smoke scopes must be configured");
  const { code, output } = await runPnpm([
    "--filter",
    "@splitch/cli",
    "exec",
    "tsx",
    "--eval",
    `
import assert from "node:assert/strict";
import { personalAccessTokenNeedsStepUp } from "../../packages/contracts/src/personal-access-token-step-up.ts";
const scopes = ${JSON.stringify(scopes.split(" "))};
assert.ok(scopes.includes("org:org_shared_preview_smoke:owner"));
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
for (const grant of [
  { target: "org:org_shared_preview_smoke", role: "admin", permissions: ["write", "delete", "credentials", "members", "privacy"] },
  { target: "org:org_shared_preview_smoke", role: "member", permissions: [] },
]) {
  for (const operation of ["create", "update", "rotate"]) {
    const input = { operation, grants: [grant], expiresAt, scopes,
      ...(operation === "create" ? {} : { current: { grants: [grant], expiresAt } }) };
    assert.equal(personalAccessTokenNeedsStepUp(input), false);
    assert.equal(personalAccessTokenNeedsStepUp({ ...input, grants: [{ ...grant, target: "all" }],
      ...(operation === "rotate" ? { current: { grants: [{ ...grant, target: "all" }], expiresAt } } : {}) }), true);
    assert.equal(personalAccessTokenNeedsStepUp({ ...input, expiresAt: null,
      ...(operation === "rotate" ? { current: { grants: [grant], expiresAt: null } } : {}) }), true);
  }
}
`,
  ]);
  verifyNoSecrets(output);
  assert.equal(code, 0, output);
});

// Exercise the real Playwright fixture lifecycle over HTTP, including teardown errors.
for (const surface of ["MCP", "CLI"]) {
  test(`shared-preview ${surface} PAT fixture revokes on success and failure`, async (t) => {
    const cases =
      surface === "CLI"
        ? [...scenarios, "cli-output-secret", "cli-command-failure", "cli-nonzero"]
        : scenarios;
    for (const scenario of cases) {
      await t.test(scenario, async () => {
        const state = { minted: 0, revoked: 0, calls: 0 };
        const server = createServer((request, response) =>
          handleRequest(request, response, scenario, state, surface),
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
          if (surface === "CLI") await writeCli(directory, scenario);
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
            fixtureSpec(origin, directory, surface, scenario),
          );
          const { code, output } = await runPnpm([
            "exec",
            "playwright",
            "test",
            "--workers=2",
            "-c",
            resolve(directory, "playwright.config.ts"),
          ]);
          verifyResult(scenario, state, code, output, surface);
          verifyNoSecrets(await readFile(resolve(directory, "report.json"), "utf8"));
          if (surface === "CLI" && scenario !== "invalid-secret") {
            const cliHome = await readFile(resolve(directory, "cli-home"), "utf8");
            await assert.rejects(readdir(cliHome), { code: "ENOENT" });
          }
          await verifyArtifacts(directory);
        } finally {
          server.close();
          await once(server, "close");
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });
}

async function verifyArtifacts(directory) {
  const artifacts = await readdir(directory, { recursive: true });
  for (const file of artifacts.filter((name) => /\.(json|md|txt|log)$/.test(name))) {
    verifyNoSecrets(await readFile(resolve(directory, file), "utf8"));
  }
  assert.equal(
    artifacts.some((file) => file.endsWith(".zip")),
    false,
    "API smoke must not retain secret-bearing traces",
  );
}

function fixtureSpec(origin, directory, surface, scenario) {
  return `
import { test } from "../../tests/shared-preview/${surface === "CLI" ? "cli-fixtures" : "fixtures"}";
${surface === "CLI" ? `test.use({ builtCliPath: ${JSON.stringify(resolve(directory, "cli.mjs"))} });` : ""}
test.use({ smokeConfig: {
  authBaseUrl: ${JSON.stringify(origin)}, controlPlaneBaseUrl: ${JSON.stringify(origin)},
  mcpBaseUrl: ${JSON.stringify(origin)}, mcpProtectedResource: ${JSON.stringify(`${origin}/mcp`)},
  panelBaseUrl: ${JSON.stringify(origin)}, expectedPlatformTarget: "shared-preview",
  expectedCommitSha: "${"a".repeat(40)}", healthRoutes: [], runId: "fixture",
  smokeOrgId: "org_fixture", smokeOrgSlug: "fixture", smokeAppId: "app_fixture",
  smokeClientId: "fixture", smokeClientSecret: "fixture-only",
  smokeEnvironmentId: "env_fixture", smokeFlagId: "flag_fixture", smokeFlagKey: "fixture"
} });
test("uses the PAT fixture", async ({ ${surface === "CLI" ? "cliPersonalAccessToken" : "mcpPersonalAccessToken, smoke"} }) => {
  ${
    surface === "CLI"
      ? `await cliPersonalAccessToken.run(["context"]);
  await cliPersonalAccessToken.run(["apps", "list", "--org", "org_fixture"]);`
      : `await smoke.listTools(mcpPersonalAccessToken);
  await smoke.listTools(mcpPersonalAccessToken);`
  }
  ${scenario === "body-failure" ? 'throw new Error("intentional body failure");' : ""}
});
`;
}

async function writeCli(directory, scenario) {
  await writeFile(
    resolve(directory, "cli.mjs"),
    `
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
assert.equal(process.cwd(), process.env.HOME);
assert.deepEqual(await readdir(process.env.HOME), []);
assert.deepEqual(process.argv.slice(2), process.argv[2] === "context" ? ["context", "--json"] : ["apps", "list", "--org", "org_fixture", "--json"]);
assert.equal(process.env.SPLITCH_APP, undefined);
assert.equal(process.env.SPLITCH_ENV, undefined);
await writeFile(${JSON.stringify(resolve(directory, "cli-home"))}, process.env.HOME);
const response = await fetch(process.env.CONTROL_PLANE_API_ORIGIN + "/cli-smoke", {
  headers: { authorization: "Bearer " + process.env.SPLITCH_TOKEN, "user-agent": "splitch-shared-preview-smoke/cli-fixture" }
});
const body = await response.json();
${scenario === "cli-command-failure" ? "process.stderr.write(process.env.SPLITCH_TOKEN); process.exit(1);" : scenario === "cli-nonzero" ? "process.exit(2);" : "console.log(JSON.stringify(body));"}
`,
  );
}

async function runPnpm(args) {
  const child = spawn("pnpm", args, {
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

async function handleRequest(request, response, scenario, state, surface) {
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
      "/personal-access-tokens": () => mintPat(request, raw, scenario, state, surface),
      [`/personal-access-tokens/${tokenId}/revoke`]: () => {
        assert.equal(request.headers.authorization === `Bearer ${controlPlaneToken}`, true);
        state.revoked++;
        if (scenario === "revoke-network-failure") response.destroy();
        response.statusCode = scenario === "revoke-failure" ? 500 : 200;
        return { revokedAt: scenario === "revoke-no-op" ? null : new Date().toISOString() };
      },
      "/cli-smoke": () => {
        assert.equal(request.headers.authorization === `Bearer ${pat}`, true);
        state.calls++;
        if (scenario === "request-network-failure") response.destroy();
        return scenario === "cli-output-secret" ? { secret: pat } : {};
      },
      "/mcp": () => {
        assert.equal(request.headers["content-type"], "application/json");
        assert.equal(request.headers.authorization === `Bearer ${pat}`, true);
        state.calls++;
        if (scenario === "request-network-failure") response.destroy();
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

function mintPat(request, raw, scenario, state, surface) {
  assert.equal(request.headers.authorization === `Bearer ${controlPlaneToken}`, true);
  assert.equal(request.headers["splitch-pat-authorization"], undefined);
  assert.equal(request.headers["content-type"], "application/json");
  const body = JSON.parse(raw);
  assert.deepEqual(
    body.grants,
    surface === "CLI"
      ? [{ target: "org:org_fixture", role: "member", permissions: [] }]
      : [
          {
            target: "org:org_fixture",
            role: "admin",
            permissions: ["write", "delete", "credentials", "members", "privacy"],
          },
        ],
  );
  const ttl = Date.parse(body.expiresAt) - Date.now();
  assert.ok(ttl > 3_590_000 && ttl <= 3_600_000);
  state.minted++;
  return {
    token: { id: tokenId },
    secret: scenario === "invalid-secret" ? "invalid-pat-fixture" : pat,
  };
}

function verifyResult(scenario, state, code, output, surface) {
  verifyNoSecrets(output);
  assert.equal(code, scenario === "success" ? 0 : 1, output);
  assert.deepEqual(state, {
    minted: 1,
    revoked: 1,
    calls:
      scenario === "invalid-secret"
        ? 0
        : [
              "request-network-failure",
              "cli-output-secret",
              "cli-command-failure",
              "cli-nonzero",
            ].includes(scenario)
          ? 1
          : 2,
  });
  const expectedErrors = {
    "body-failure": /intentional body failure/,
    "invalid-secret": /created (CLI )?PAT secret is valid/,
    "revoke-failure": /Control Plane POST .*revoke/,
    "revoke-no-op": /smoke PAT was revoked/,
    "revoke-network-failure": /revoke/,
    "request-network-failure": surface === "CLI" ? /CLI smoke command/ : /MCP|mcp/,
    "cli-output-secret": /CLI smoke command emitted a PAT secret/,
    "cli-command-failure": /CLI smoke command emitted a PAT secret/,
    "cli-nonzero": /CLI smoke command failed before successful completion/,
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
