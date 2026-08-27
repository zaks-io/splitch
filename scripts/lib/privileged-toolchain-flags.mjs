import { flagKinds } from "./privileged-toolchain-command.mjs";

export const UNRESOLVABLE_FLAGS = new Set(["-r", "--requirement", "--git"]);

export const NPM_FLAGS = flagKinds(
  [
    "-g",
    "--global",
    "-h",
    "--help",
    "-s",
    "--silent",
    "-q",
    "--quiet",
    "-v",
    "--version",
    "-y",
    "--yes",
    "--activate",
    "--force",
    "--offline",
    "--prefer-offline",
    "--frozen-lockfile",
    "--immutable",
    "--ignore-scripts",
    "--no-save",
    "--save-dev",
    "--save-exact",
    "--strict-peer-dependencies",
  ],
  [
    "-C",
    "-w",
    "--cache",
    "--dir",
    "--filter",
    "--loglevel",
    "--prefix",
    "--registry",
    "--workspace",
  ],
);

export const PIP_FLAGS = flagKinds(
  [
    "--user",
    "--isolated",
    "--break-system-packages",
    "--no-deps",
    "--no-cache-dir",
    "--pre",
    "-U",
    "--upgrade",
    "-q",
    "--quiet",
  ],
  ["-i", "--index-url", "--extra-index-url", "--proxy", "--root", "--target", "--prefix"],
);

export const UV_FLAGS = flagKinds(
  [
    "--offline",
    "--no-cache",
    "-h",
    "--help",
    "-n",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--version",
    "--force",
    "--no-progress",
  ],
  [
    "--cache-dir",
    "--config-file",
    "--directory",
    "--index",
    "--index-url",
    "--project",
    "--python",
  ],
);

export const CARGO_GLOBAL_FLAGS = flagKinds(
  [
    "--locked",
    "--offline",
    "--frozen",
    "-h",
    "--help",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--version",
  ],
  ["--color", "--config"],
);

export const CARGO_INSTALL_FLAGS = flagKinds(
  ["--locked", "--offline", "--frozen", "-q", "--quiet", "-v", "--verbose", "--force", "--debug"],
  ["--bin", "--color", "--features", "--profile", "--registry", "--root", "--target", "--version"],
);
