import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

// .cursor/install.sh reads its version pins out of the CI definitions instead
// of holding a fourth copy of each one. That only stays safe while the shapes
// it greps for hold, and nothing else in CI would notice them changing: a
// reshaped pin breaks a Cursor Build, which no gate here can run. These tests
// execute the script's own sed expressions so the break lands in test:scripts.
const INSTALL_PATH = ".cursor/install.sh";
const START_PATH = ".cursor/start.sh";
const ENVIRONMENT_PATH = ".cursor/environment.json";

const install = readFileSync(INSTALL_PATH, "utf8");
const pins = [...install.matchAll(/^([A-Z_]+)="\$\(pin (\S+) '(.+?)' /gmu)].map(
  ([, variable, file, expression]) => ({ variable, file, expression }),
);

test("every pin in the install script resolves to exactly one version", () => {
  assert.ok(pins.length > 0, "no pin invocations found; did the script change shape?");

  for (const { variable, file, expression } of pins) {
    assert.ok(existsSync(file), `${variable} reads ${file}, which does not exist`);

    const matches = execFileSync("sed", ["-n", expression, file], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const unique = [...new Set(matches)];

    assert.equal(unique.length, 1, `${variable} matched ${unique.length} versions in ${file}`);
    assert.match(unique[0], /^\d+\.\d+\.\d+$/, `${variable} matched a non-version in ${file}`);
  }
});

test("the install script still pins the whole toolchain", () => {
  const pinned = new Set(pins.map(({ variable }) => variable));

  for (const variable of [
    "NODE_VERSION",
    "GITLEAKS_VERSION",
    "TINYBIRD_CLI_VERSION",
    "PNPM_VERSION",
  ]) {
    assert.ok(pinned.has(variable), `${variable} is no longer derived from a CI definition`);
  }
});

test("the install script pins docker-ce for the Cloud Agent Ubuntu release", () => {
  assert.match(
    install,
    /DOCKER_VERSION="28\.5\.2"/,
    "docker client pin drifted from Cursor's documented noble version",
  );
  assert.match(install, /docker-ce=\$\{DOCKER_CE_PIN\}/);
  assert.match(install, /docker-ce-cli=\$\{DOCKER_CE_PIN\}/);
  assert.match(install, /fuse-overlayfs/);
  assert.match(install, /iptables-legacy/);
  assert.match(install, /storage-driver": "fuse-overlayfs/);
  assert.match(
    install,
    /force-confold/,
    "apt must keep existing fuse.conf; a conffile prompt fails the Build",
  );
  assert.match(
    install,
    /docker is not on PATH after installing docker-ce/,
    "the fail-loud check after install is gone; a missing client would look like success",
  );
  assert.match(
    install,
    /export PATH="\/usr\/local\/bin:\$\{PATH\}"/,
    "proofs would otherwise observe /exec-daemon/node instead of the pinned toolchain",
  );
});

test("the environment hooks exist and are executable", () => {
  const environment = JSON.parse(readFileSync(ENVIRONMENT_PATH, "utf8"));

  assert.equal(environment.install, `./${INSTALL_PATH}`);
  assert.equal(environment.start, `./${START_PATH}`);

  for (const path of [INSTALL_PATH, START_PATH]) {
    assert.ok(statSync(path).mode & 0o111, `${path} is not executable`);
  }
});
