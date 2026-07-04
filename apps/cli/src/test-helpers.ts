import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

export async function cleanupTempHomes(): Promise<void> {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
}

export async function makeTempHome(): Promise<{ dir: string; credentialPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "splitch-cli-"));
  tempDirs.push(dir);
  const credentialPath = join(dir, ".splitch", "credentials.json");
  await mkdir(join(dir, ".splitch"), { recursive: true });
  return { dir, credentialPath };
}
