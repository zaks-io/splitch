import { expect, test } from "./cli-fixtures";

test("a test-scoped PAT runs the built CLI from a clean HOME", async ({
  cliPersonalAccessToken: cli,
  smoke,
}) => {
  const context = await cli.run<Record<string, unknown>>(["context"]);
  expect(context).toMatchObject({
    authenticated: true,
    credentialMode: "token",
    personalAccessToken: {
      ...cli.token,
      effective: {
        scopes: expect.arrayContaining([
          `org:${smoke.config.smokeOrgId}:member`,
          `app:${smoke.config.smokeAppId}:member`,
        ]),
        permissions: Object.fromEntries(
          ["write", "delete", "credentials", "members", "privacy"].map((permission) => [
            permission,
            { scopes: [], all: false },
          ]),
        ),
      },
    },
  });
  expect(context).not.toHaveProperty("principal");
  const apps = await cli.run<{ items: { id: string }[] }>([
    "apps",
    "list",
    "--org",
    smoke.config.smokeOrgId,
  ]);
  expect(apps.items.map((app) => app.id)).toContain(smoke.config.smokeAppId);
});
