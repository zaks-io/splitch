import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Walk every file a checkout actually contains, so a repo-wide tripwire also
 * sees files that are not staged yet. `git ls-files` sees only tracked paths,
 * which makes an untracked Worker config, spec, or module invisible to exactly
 * the sweeps written to catch it.
 *
 * Build artifacts are the reason a sweep cannot simply walk everything: they
 * hold copies of the source it is looking for. Git's own ignore rules decide
 * what is an artifact, so the two sweeps that need this share one answer.
 */

const ALWAYS_IGNORED_DIRECTORIES = ["node_modules", ".git", "dist", "coverage"];

function gitIgnoredDirectories(repoRoot) {
  return execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path.endsWith("/"))
    .map((path) => path.slice(0, -1));
}

/** Visit every file under `repoRoot`, skipping Git-ignored directories. */
export function walkRepoFiles(repoRoot, visit) {
  const ignored = gitIgnoredDirectories(repoRoot);
  const isGitIgnoredDirectory = (relativePath) =>
    ignored.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));

  function visitDirectory(directory) {
    for (const entry of readdirSync(directory)) {
      const absolutePath = join(directory, entry);
      const relativePath = relative(repoRoot, absolutePath);
      if (statSync(absolutePath).isDirectory()) {
        if (ALWAYS_IGNORED_DIRECTORIES.includes(entry) || isGitIgnoredDirectory(relativePath)) {
          continue;
        }
        visitDirectory(absolutePath);
        continue;
      }
      visit(relativePath, absolutePath);
    }
  }

  visitDirectory(repoRoot);
}
