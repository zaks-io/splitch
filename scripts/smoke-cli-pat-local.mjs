#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  capturedChild,
  createLocalPatFixture,
  createPatClient,
  repoRoot,
  requireSafeOutput,
} from "./cli-pat-local-fixture.mjs";

// Prerequisite: pnpm --filter @splitch/cli... build. This script never builds or deploys.
const { SPLITCH_CLI_SMOKE_BINARY: builtCliPath } = process.env;
const cliPath = resolve(repoRoot, builtCliPath ?? "apps/cli/dist/cli.js");
const organizationId = "org_acme_e2e";
const appId = "app_checkout_e2e";
const grant = { target: `org:${organizationId}`, role: "member", permissions: [] };
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort());
let fixture;
let patClient;
let workSignal = abort.signal;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function withToken(grants, use) {
  workSignal.throwIfAborted();
  const created = await patClient.mint(grants);
  try {
    check(/^pat_[0-9a-f]{32}$/.test(created.token.id), "Mint returned an invalid PAT id");
    check(/^spl_pat_[0-9a-f]{64}$/.test(created.secret), "Mint returned an invalid PAT secret");
    await use(created);
  } finally {
    const revoked = await createPatClient(fixture, abort.signal).revoke(created.token.id);
    check(typeof revoked.revokedAt === "string", "Session cleanup did not revoke its PAT");
    console.log("PASS session cleanup revoked test PAT");
  }
}

async function cli(secret, args, expectedExit = 0) {
  workSignal.throwIfAborted();
  const home = join(fixture.root, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    SPLITCH_TOKEN: secret,
    SPLITCH_PLATFORM_TARGET: "local",
    CONTROL_PLANE_API_ORIGIN: fixture.origin,
    AUTH_API_ORIGIN: fixture.issuerOrigin,
  };
  for (const name of ["SPLITCH_APP", "SPLITCH_ENV", "EVALUATION_API_ORIGIN"]) delete env[name];
  const run = capturedChild([cliPath, ...args, "--json"], {
    cwd: home,
    env,
    signal: AbortSignal.any([workSignal, AbortSignal.timeout(30_000)]),
  });
  const result = await run.completed;
  requireSafeOutput(result.stdout + result.stderr);
  const command = args
    .slice(0, 2)
    .filter((arg) => !arg.startsWith("--"))
    .join(" ");
  check(
    result.code === expectedExit,
    `CLI ${command} exited ${result.code}; expected ${expectedExit}; private output suppressed`,
  );
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new Error(`CLI ${command} did not return JSON`);
  }
  check((await readdir(home)).length === 0, "Token mode wrote to the clean HOME");
  const commandLine = args
    .map((arg) => (/^[\w./:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");
  console.log(`PASS splitch ${commandLine} --json (exit ${result.code}, output scanned)`);
  return json;
}

async function readSmoke() {
  await withToken([grant], async ({ token, secret }) => {
    const context = await cli(secret, ["context"]);
    check(
      context.authenticated === true && context.credentialMode === "token",
      "Context missed token mode",
    );
    check(context.personalAccessToken?.id === token.id, "Context missed minted PAT metadata");
    for (const name of ["name", "grants", "expiresAt"]) {
      check(
        isDeepStrictEqual(context.personalAccessToken[name], token[name]),
        `Context changed the PAT ${name} metadata`,
      );
    }
    check(!("principal" in context), "Token context fabricated a session principal");
    check(
      Array.isArray(context.nextSteps) &&
        context.nextSteps.every((step) => !/splitch (login|logout|bind)/.test(step)),
      "Token context suggested a session auth command",
    );
    const effective = context.personalAccessToken.effective;
    check(
      effective.scopes.includes(`org:${organizationId}:member`),
      "Context missed Org read authority",
    );
    for (const name of ["write", "delete", "credentials", "members", "privacy"]) {
      const permission = effective.permissions[name];
      check(
        permission.all === false && permission.scopes.length === 0,
        "Org read PAT gained a permission",
      );
    }
    const apps = await cli(secret, ["apps", "list", "--org", organizationId]);
    check(
      apps.items.some((app) => app.id === appId),
      "Org apps list missed the fixture App",
    );
  });
}

async function writeSmoke() {
  await withToken(
    [{ target: `app:${appId}`, role: "admin", permissions: ["write"] }],
    async ({ secret }) => {
      const key = `pat-smoke-${randomUUID()}`;
      const created = await cli(secret, [
        "flags",
        "create",
        "--app",
        appId,
        "--key",
        key,
        "--variants",
        "on,off",
        "--lifecycle-class",
        "ops",
      ]);
      check(typeof created.id === "string", "Flag creation did not return a Flag id");
      await cli(secret, [
        "flag-config",
        "update",
        created.id,
        "--app",
        appId,
        "--env",
        "env_checkout_dev_e2e",
        "--enabled",
        "true",
        "--body-json",
        JSON.stringify({ availableVariantNames: ["on", "off"] }),
      ]);
      const promoted = await cli(secret, [
        "flags",
        "promote",
        created.id,
        "--app",
        appId,
        "--env",
        "env_checkout_create_e2e",
        "--from-environment-id",
        "env_checkout_dev_e2e",
        "--body-json",
        JSON.stringify({ select: { enabled: true } }),
      ]);
      check(
        promoted.diff?.before.enabled === false && promoted.diff.after.enabled === true,
        "Flag promotion did not copy the enabled source configuration",
      );
      const output = join(fixture.root, "refused-api-key.txt");
      const refused = await cli(
        secret,
        [
          "api-keys",
          "create",
          "--app",
          appId,
          "--env",
          "env_checkout_dev_e2e",
          "--body-json",
          JSON.stringify({ scopes: ["data-plane:evaluate"] }),
          "--output-file",
          output,
        ],
        4,
      );
      check(refused.code === "FORBIDDEN", "Credentials refusal lost its server error code");
      check(
        JSON.stringify(refused).includes("credentials"),
        "Credentials refusal did not name its permission",
      );
      check(
        await access(output).then(
          () => false,
          () => true,
        ),
        "Refused credentials call wrote a file",
      );
    },
  );
}

async function invalidSmoke() {
  for (const secret of ["", "malformed"]) {
    const result = await cli(secret, ["context"], 2);
    check(result.code === "CLI_TOKEN_INVALID", "Malformed token lost its auth error code");
  }
  const mutations = {
    revoked: "revoked_at='2000-01-01T00:00:00.000Z'",
    expired: "expires_at='2000-01-01T00:00:00.000Z'",
    rotated: "token_hash=lower(hex(randomblob(32)))",
  };
  for (const [state, mutation] of Object.entries(mutations)) {
    await withToken([grant], async ({ token, secret }) => {
      await cli(secret, ["context"]);
      // Mutate D1 only, preserving the active KV entry written by minting.
      await fixture.sql(
        `UPDATE personal_access_tokens SET ${mutation} WHERE id='${token.id}';`,
        workSignal,
      );
      const result = await cli(secret, ["context"], 2);
      check(result.code === "CLI_TOKEN_INVALID", `D1 ${state} token lost its auth error code`);
      console.log(`PASS D1 ${state} PAT rejected despite active KV`);
    });
  }
}

try {
  await access(cliPath);
  fixture = await createLocalPatFixture(abort.signal);
  await fixture.start();
  console.log(
    "PASS isolated issuer and real Analysis/Control Plane Workers healthy; native actor limiter 1102",
  );
  await fixture.run(async (signal) => {
    workSignal = signal;
    patClient = createPatClient(fixture, signal);
    await readSmoke();
    await writeSmoke();
    await invalidSmoke();
  });
  console.log("PASS real session to PAT to built CLI smoke, including AC1/AC2 and invalid mapping");
} catch (error) {
  // Only our fixed diagnostic messages are public. Native errors can carry headers or bodies.
  const message = error instanceof Error ? error.message : "unknown failure";
  requireSafeOutput(message);
  console.error(`Local CLI PAT smoke failed: ${message}`);
  process.exitCode = 1;
} finally {
  await fixture?.close();
}
