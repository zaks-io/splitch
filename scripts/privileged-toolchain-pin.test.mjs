import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const ACTION_USES = /uses:\s+(\S+)/g;
const FLOATING_PACKAGE =
  /(?:npm|pnpm|yarn|npx|pip|uv|cargo)\s+(?:install|add|exec)\s[^\n]*@[\^~*]|npm@[\^~]|npm@(?:latest|next)\b/;
const MUTABLE_INSTALLER = /curl[^\n]*\|\s*(?:ba)?sh\b/;
const FULL_SHA = /^[0-9a-f]{40}$/;

const actions = readdirSync(".github/actions", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: `.github/actions/${entry.name}/action.yml`,
    source: readFileSync(`.github/actions/${entry.name}/action.yml`, "utf8"),
  }));
const workflows = readdirSync(".github/workflows")
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({
    name: `.github/workflows/${name}`,
    source: readFileSync(`.github/workflows/${name}`, "utf8"),
  }));
const files = [...actions, ...workflows];

function jobBodies(source) {
  return [
    ...source.matchAll(/\n {2}([A-Za-z][\w-]*):\n([\s\S]*?)(?=\n {2}(?:#|[A-Za-z][\w-]*:\n)|$)/g),
  ].map(([, name, body]) => ({ name, body }));
}

function isPrivileged(workflow, job) {
  return (
    /id-token:\s*write/.test(workflow) ||
    /id-token:\s*write/.test(job) ||
    /environment:\s*production/.test(job) ||
    /environment:\s*shared-preview/.test(job)
  );
}

function isOidcEnabled(workflow, job) {
  return /id-token:\s*write/.test(workflow) || /id-token:\s*write/.test(job);
}

function runScripts(source) {
  return [...source.matchAll(/\n\s+run:\s*\|\n((?:[ \t]+.*\n)+)/g)].flatMap(([, body]) =>
    body
      .split("\n")
      .map((line) => line.replace(/^[ \t]+/, ""))
      .filter((line) => line && !line.startsWith("#")),
  );
}

test("every third-party action pin is a full commit SHA with a version comment", () => {
  for (const { name, source } of files) {
    for (const match of source.matchAll(ACTION_USES)) {
      const ref = match[1];
      if (ref.startsWith("./") || ref.startsWith(".github/")) continue;
      const [action, pin] = ref.split("@");
      assert.ok(pin, `${name} uses unpinned ${action}`);
      assert.match(pin, FULL_SHA, `${name} uses ${ref} without a full SHA`);
      const line = source.slice(0, match.index).split("\n").at(-1) ?? "";
      const rest = source.slice(match.index).split("\n")[0] ?? "";
      assert.match(`${line}${rest}`, /# v?\d/, `${name} uses ${ref} without a version comment`);
    }
  }
});

test("no privileged job executes a mutable installer", () => {
  for (const { name, source } of files) {
    const privileged =
      name.endsWith("action.yml") ||
      jobBodies(source).some((job) => isPrivileged(source, job.body));
    if (!privileged) continue;
    for (const script of runScripts(source)) {
      assert.doesNotMatch(script, MUTABLE_INSTALLER, `${name} pipes a remote installer to a shell`);
    }
    assert.doesNotMatch(source, /astral\.sh\/uv\/install/, `${name} uses the mutable uv installer`);
  }
});

test("no OIDC-enabled job installs a floating package range", () => {
  for (const { name, source } of workflows) {
    for (const job of jobBodies(source)) {
      if (!isOidcEnabled(source, job.body)) continue;
      assert.doesNotMatch(
        job.body,
        FLOATING_PACKAGE,
        `${name} job ${job.name} installs a floating package range`,
      );
    }
  }
});

test("cloudflare-publish pins and verifies an exact npm version before OIDC publish", () => {
  const workflow = readFileSync(".github/workflows/cloudflare-publish.yml", "utf8");
  const publishJob = workflow.match(/\n {2}publish:\n([\s\S]*?)\n {2}linear-release:\n/)?.[1] ?? "";

  assert.match(publishJob, /id-token: write/);
  assert.match(publishJob, /NPM_VERSION: 11\.15\.0/);
  assert.match(publishJob, /npm install --global "npm@\$\{NPM_VERSION\}"/);
  assert.match(publishJob, /npm reports '\$\{installed\}', expected \$\{NPM_VERSION\}/);
  assert.doesNotMatch(publishJob, /npm@[\^~]/);
  assert.doesNotMatch(publishJob, /npm@(?:latest|next)\b/);
});
