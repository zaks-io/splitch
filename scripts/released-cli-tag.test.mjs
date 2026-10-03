import assert from "node:assert/strict";
import test from "node:test";
import { compareCliTags, fetchNpmCliVersions, newestCliTagOnNpm } from "./lib/released-cli-tag.mjs";

test("skips a tag whose GitHub Release is published but whose version never reached npm", () => {
  // cli-v0.7.6 has a tag and a published release, but cli-publish failed before npm publish.
  const tags = ["cli-v0.7.5", "cli-v0.7.6", "sdk-v9.0.0"];
  assert.equal(newestCliTagOnNpm(tags, new Set(["0.7.4", "0.7.5"])), "cli-v0.7.5");
  assert.equal(newestCliTagOnNpm(tags, new Set(["0.7.5", "0.7.6"])), "cli-v0.7.6");
  assert.equal(newestCliTagOnNpm(["cli-v0.8.0"], new Set(["0.7.5"])), undefined);
});

test("picks the highest SemVer tag on npm and ignores build metadata npm drops", () => {
  const onNpm = new Set(["0.9.9", "0.10.0", "1.0.0"]);
  assert.equal(newestCliTagOnNpm(["cli-v0.9.9", "cli-v0.10.0"], onNpm), "cli-v0.10.0");
  assert.equal(
    newestCliTagOnNpm(["cli-v0.9.9", "cli-v1.0.0+build.5"], onNpm),
    "cli-v1.0.0+build.5",
  );
});

test("fails loud when build metadata makes the npm version match several tags", () => {
  // npm shows 1.0.0 for cli-v1.0.0+published; cli-v1.0.0+draft never shipped.
  const tags = ["cli-v0.9.0", "cli-v1.0.0+published", "cli-v1.0.0+draft"];
  assert.throws(
    () => newestCliTagOnNpm(tags, new Set(["0.9.0", "1.0.0"])),
    /npm version 1\.0\.0 matches several tags \(cli-v1\.0\.0\+published, cli-v1\.0\.0\+draft\)/,
  );
});

const respond = (status, body) => async () => ({ status, json: async () => body });

test("reads every CLI version from the public npm registry", async () => {
  let requested;
  const fetchImpl = async (url, init) => {
    requested = { url, accept: init.headers.accept };
    return respond(200, { versions: { "0.7.5": {}, "0.7.6": {} } })();
  };
  assert.deepEqual([...(await fetchNpmCliVersions(fetchImpl))], ["0.7.5", "0.7.6"]);
  assert.equal(requested.url, "https://registry.npmjs.org/%40splitch%2Fcli");
  assert.equal(requested.accept, "application/vnd.npm.install-v1+json");
});

test("fails loud on registry errors instead of falling back", async () => {
  await assert.rejects(fetchNpmCliVersions(respond(503, {})), /returned HTTP 503/);
  await assert.rejects(fetchNpmCliVersions(respond(404, {})), /returned HTTP 404/);
  await assert.rejects(fetchNpmCliVersions(respond(200, {})), /returned no versions/);
  const offline = async () => {
    throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
  };
  await assert.rejects(fetchNpmCliVersions(offline), /failed: getaddrinfo ENOTFOUND/);
});

const untilAborted = (signal) =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

test("times out a stalled registry request and a stalled body read", async () => {
  const stalledRequest = (_url, init) => untilAborted(init.signal);
  await assert.rejects(fetchNpmCliVersions(stalledRequest, 20), /timed out after 20ms/);
  const stalledBody = async (_url, init) => ({
    status: 200,
    json: () => untilAborted(init.signal),
  });
  await assert.rejects(fetchNpmCliVersions(stalledBody, 20), /timed out after 20ms/);
});

test("orders prerelease identifiers by SemVer precedence, not locale order", () => {
  assert.ok(compareCliTags("cli-v1.0.0-1a", "cli-v1.0.0-9") > 0);
  const specOrder = [
    "cli-v1.0.0-alpha",
    "cli-v1.0.0-alpha.1",
    "cli-v1.0.0-alpha.beta",
    "cli-v1.0.0-beta",
    "cli-v1.0.0-beta.2",
    "cli-v1.0.0-beta.11",
    "cli-v1.0.0-rc.1",
    "cli-v1.0.0",
    "cli-v1.0.1+build.5",
  ];
  const shuffled = [...specOrder].reverse();
  assert.deepEqual(shuffled.sort(compareCliTags), specOrder);
  assert.ok(compareCliTags("cli-v1.0.0-rc+build+x", "cli-v0.9.0") > 0);
});

test("fails loud on a cli tag it cannot order instead of skipping it", () => {
  assert.throws(() => compareCliTags("cli-v0.7.5", "cli-vbad"), /cli-vbad is not a release semver/);
});
