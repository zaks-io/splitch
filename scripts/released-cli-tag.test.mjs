import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCliTags,
  githubPublicationLookup,
  newestPublishedCliTag,
} from "./lib/released-cli-tag.mjs";

test("skips a newer draft tag and anchors on the newest published release", async () => {
  const drafts = new Set(["cli-v0.8.0"]);
  const isPublished = async (tag) => !drafts.has(tag);
  assert.equal(
    await newestPublishedCliTag(["cli-v0.7.5", "cli-v0.8.0", "sdk-v9.0.0"], isPublished),
    "cli-v0.7.5",
  );
  assert.equal(await newestPublishedCliTag(["cli-v0.8.0"], isPublished), undefined);
});

test("asks about tags newest first and stops at the first published one", async () => {
  const asked = [];
  const isPublished = async (tag) => {
    asked.push(tag);
    return true;
  };
  await newestPublishedCliTag(["cli-v0.7.5", "cli-v0.10.0", "cli-v0.9.9"], isPublished);
  assert.deepEqual(asked, ["cli-v0.10.0"]);
});

test("fails loud without a token instead of guessing which release is published", () => {
  assert.throws(
    () => githubPublicationLookup({ env: {}, originUrl: () => "git@github.com:o/r.git" }),
    /GH_TOKEN \(or GITHUB_TOKEN\) is required/,
  );
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
