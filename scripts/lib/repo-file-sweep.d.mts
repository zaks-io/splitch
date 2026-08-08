export function walkRepoFiles(
  repoRoot: string,
  visit: (relativePath: string, absolutePath: string) => void,
): void;
