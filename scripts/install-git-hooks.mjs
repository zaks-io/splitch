import { spawnSync } from "node:child_process";

// `lefthook install` refuses outright when core.hooksPath is set, and both of its
// escape hatches destroy whatever set it: --force renames the existing hook to
// <hook>.old and never calls it again, and --reset-hooks-path deletes the config
// entry, global scope included. Cursor cloud agents point core.hooksPath at their
// own dispatcher (~/.cursor/agent-hooks/), so running either from `prepare` would
// silently disable the host's hooks on every install. Yield the hooks instead, and
// say so loudly.

const probe = spawnSync("git", ["config", "--show-scope", "--get", "core.hooksPath"], {
  encoding: "utf8",
});

if (probe.error) {
  console.error(`prepare: could not run git to read core.hooksPath: ${probe.error.message}`);
  process.exit(1);
}

// 1 is git's "no such key", which is the ordinary case. Any other non-zero is a
// real failure and must not be read as "unset".
if (probe.status !== 0 && probe.status !== 1) {
  console.error(`prepare: \`git config --get core.hooksPath\` exited ${probe.status}.`);
  console.error(probe.stderr.trim());
  process.exit(1);
}

const owner = probe.status === 0 ? parseScopedValue(probe.stdout) : null;

if (owner) {
  console.warn(
    [
      "",
      `prepare: git core.hooksPath is set in ${owner.scope} config to ${owner.value}`,
      "prepare: something else owns this repo's git hooks, so lefthook was NOT installed.",
      "prepare: pre-commit verify:commit and pre-push verify:push will not run here.",
      "prepare: run them yourself before pushing, or take the hooks back with",
      `prepare:   pnpm exec lefthook install --reset-hooks-path   (unsets the ${owner.scope} setting)`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const install = spawnSync("lefthook", ["install"], { stdio: "inherit" });

if (install.error) {
  console.error(`prepare: could not run lefthook: ${install.error.message}`);
  process.exit(1);
}

process.exit(install.status ?? 1);

// `--show-scope` prints "<scope>\t<value>", and a hooks path may contain spaces.
function parseScopedValue(stdout) {
  const line = stdout.split("\n").find((candidate) => candidate.includes("\t"));
  if (!line) {
    console.error(
      `prepare: could not parse git's core.hooksPath output: ${JSON.stringify(stdout)}`,
    );
    process.exit(1);
  }
  const separator = line.indexOf("\t");
  return { scope: line.slice(0, separator), value: line.slice(separator + 1).trim() };
}
