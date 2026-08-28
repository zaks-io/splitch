import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { appScope } from "./scope";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

const NOW = "2026-08-28T00:00:00.000Z";
const USER = "user_selector_primary";
const OTHER_USER = "user_selector_other";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("identity selector reads", () => {
  it("requires both User membership predicates for same-key App candidates", async () => {
    await seedSelectorGraph(local.d1);

    await expect(repo.identity.findAppSelectorCandidatesForUser(USER, "neuron")).resolves.toEqual([
      { orgSlug: "alpha", appId: "app_alpha", appSlug: "neuron" },
    ]);
  });

  it("keeps Environment key reads inside the App scope", async () => {
    await seedSelectorGraph(local.d1);
    const alpha = appScope("app_alpha");

    await expect(repo.identity.getEnvironmentByKey(alpha, "production")).resolves.toMatchObject({
      id: "env_alpha_production",
      appId: "app_alpha",
    });
    await expect(repo.identity.getEnvironmentByKey(alpha, "victim-only")).resolves.toBeNull();
  });
});

async function seedSelectorGraph(d1: D1Database): Promise<void> {
  const statements = [
    `INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES
       ('org_alpha', 'Alpha', 'alpha', 'free', 0, '${NOW}', '${NOW}'),
       ('org_bravo', 'Bravo', 'bravo', 'free', 0, '${NOW}', '${NOW}'),
       ('org_charlie', 'Charlie', 'charlie', 'free', 0, '${NOW}', '${NOW}'),
       ('org_delta', 'Delta', 'delta', 'free', 0, '${NOW}', '${NOW}')`,
    `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
       ('app_alpha', 'org_alpha', 'Alpha App', 'neuron', '${NOW}', '${NOW}', '${USER}'),
       ('app_bravo', 'org_bravo', 'Bravo App', 'neuron', '${NOW}', '${NOW}', '${OTHER_USER}'),
       ('app_charlie', 'org_charlie', 'Charlie App', 'neuron', '${NOW}', '${NOW}', '${OTHER_USER}'),
       ('app_delta', 'org_delta', 'Delta App', 'neuron', '${NOW}', '${NOW}', '${OTHER_USER}')`,
    `INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
       ('org_alpha', '${USER}', 'owner', '${NOW}'),
       ('org_bravo', '${OTHER_USER}', 'owner', '${NOW}'),
       ('org_charlie', '${USER}', 'member', '${NOW}'),
       ('org_charlie', '${OTHER_USER}', 'owner', '${NOW}'),
       ('org_delta', '${OTHER_USER}', 'owner', '${NOW}')`,
    `INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
       ('app_alpha', '${USER}', 'owner', '${NOW}'),
       ('app_bravo', '${OTHER_USER}', 'owner', '${NOW}'),
       ('app_charlie', '${OTHER_USER}', 'owner', '${NOW}'),
       ('app_delta', '${USER}', 'member', '${NOW}'),
       ('app_delta', '${OTHER_USER}', 'owner', '${NOW}')`,
    `INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES
       ('env_alpha_production', 'app_alpha', 'production', 'Production', '${NOW}', '${NOW}', '${USER}'),
       ('env_bravo_production', 'app_bravo', 'production', 'Production', '${NOW}', '${NOW}', '${OTHER_USER}'),
       ('env_bravo_victim', 'app_bravo', 'victim-only', 'Victim', '${NOW}', '${NOW}', '${OTHER_USER}')`,
  ];
  for (const statement of statements) await d1.prepare(statement).run();
}
