import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileCredentialStore } from "./credentials.js";
import { storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

describe("credential store filesystem modes", () => {
  it("creates the credential directory at 0700 and the file at 0600", async () => {
    const credentialPath = join((await makeTempHome()).dir, "creds", "credentials.json");
    const store = createFileCredentialStore(credentialPath);

    await store.save(storedCredential());

    expect((await stat(dirname(credentialPath))).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it("repairs a pre-existing world-writable directory and group-readable file on save", async () => {
    const credentialPath = join((await makeTempHome()).dir, "creds", "credentials.json");
    await mkdir(dirname(credentialPath), { recursive: true, mode: 0o777 });
    await chmod(dirname(credentialPath), 0o777);
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`, { mode: 0o644 });
    await chmod(credentialPath, 0o644);

    await createFileCredentialStore(credentialPath).save(storedCredential());

    expect((await stat(dirname(credentialPath))).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it("repairs a pre-existing loose directory and file on load", async () => {
    const credentialPath = join((await makeTempHome()).dir, "creds", "credentials.json");
    await mkdir(dirname(credentialPath), { recursive: true, mode: 0o777 });
    await chmod(dirname(credentialPath), 0o777);
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`, { mode: 0o644 });
    await chmod(credentialPath, 0o644);

    await expect(createFileCredentialStore(credentialPath).load()).resolves.toMatchObject({
      principal: { userId: "user_test" },
    });

    expect((await stat(dirname(credentialPath))).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });
});
