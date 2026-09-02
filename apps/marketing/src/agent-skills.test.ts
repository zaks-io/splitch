import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import splitchSkill from "../../../skills/splitch/SKILL.md?raw";
import { handleAgentSkillsRequest } from "./agent-skills";

const origin = "https://splitch.dev";
const indexUrl = `${origin}/.well-known/agent-skills/index.json`;
const skillUrl = `${origin}/.well-known/agent-skills/splitch/SKILL.md`;

describe("Agent Skills discovery", () => {
  it("publishes a v0.2.0 index whose digest matches the served artifact", async () => {
    const indexResponse = await handleAgentSkillsRequest(new Request(indexUrl));

    expect(indexResponse).toBeDefined();
    expect(indexResponse?.status).toBe(200);
    expect(indexResponse?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(indexResponse?.headers.get("access-control-allow-origin")).toBe("*");

    const index = (await indexResponse?.json()) as {
      $schema: string;
      skills: Array<{
        name: string;
        type: string;
        description: string;
        url: string;
        digest: string;
      }>;
    };
    const frontmatterDescription = splitchSkill.match(/^description: (.+)$/m)?.[1];
    expect(frontmatterDescription).toBeDefined();
    expect(index).toEqual({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "splitch",
          type: "skill-md",
          description: frontmatterDescription,
          url: "/.well-known/agent-skills/splitch/SKILL.md",
          digest: `sha256:${createHash("sha256").update(splitchSkill).digest("hex")}`,
        },
      ],
    });

    const skillResponse = await handleAgentSkillsRequest(new Request(skillUrl));
    expect(skillResponse?.status).toBe(200);
    expect(skillResponse?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await skillResponse?.text()).toBe(splitchSkill);
  });

  it("supports HEAD and rejects unsupported methods", async () => {
    const headResponse = await handleAgentSkillsRequest(new Request(indexUrl, { method: "HEAD" }));
    expect(headResponse?.status).toBe(200);
    expect(await headResponse?.text()).toBe("");

    const postResponse = await handleAgentSkillsRequest(new Request(indexUrl, { method: "POST" }));
    expect(postResponse?.status).toBe(405);
    expect(postResponse?.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns 404 for unknown skill artifacts and ignores unrelated paths", async () => {
    const missingResponse = await handleAgentSkillsRequest(
      new Request(`${origin}/.well-known/agent-skills/missing/SKILL.md`),
    );
    expect(missingResponse?.status).toBe(404);

    expect(await handleAgentSkillsRequest(new Request(`${origin}/docs`))).toBeUndefined();
  });
});
