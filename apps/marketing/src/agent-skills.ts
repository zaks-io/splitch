import splitchSkill from "../../../skills/splitch/SKILL.md?raw";

const DISCOVERY_PATH = "/.well-known/agent-skills/index.json";
const SKILL_PATH = "/.well-known/agent-skills/splitch/SKILL.md";
const SCHEMA_URL = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const SKILL_DESCRIPTION =
  "Operate and integrate Splitch feature flags and A/B experiments. Use when a project uses Splitch or a request involves Splitch Apps, Environments, Flags, Variants, Targeting Rules, Experiment Runs, Exposures, Metrics, credentials, SDK integration, or control-plane state. Prefer the Splitch CLI over browser automation.";

const sharedHeaders = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=300",
};

function response(body: string, request: Request, contentType: string): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      ...sharedHeaders,
      "content-type": contentType,
    },
  });
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}

export async function handleAgentSkillsRequest(request: Request): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);

  if (!pathname.startsWith("/.well-known/agent-skills/")) {
    return undefined;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }

  if (pathname === SKILL_PATH) {
    return response(splitchSkill, request, "text/markdown; charset=utf-8");
  }

  if (pathname === DISCOVERY_PATH) {
    const index = JSON.stringify({
      $schema: SCHEMA_URL,
      skills: [
        {
          name: "splitch",
          type: "skill-md",
          description: SKILL_DESCRIPTION,
          url: SKILL_PATH,
          digest: await sha256(splitchSkill),
        },
      ],
    });

    return response(index, request, "application/json; charset=utf-8");
  }

  return new Response(null, { status: 404 });
}
