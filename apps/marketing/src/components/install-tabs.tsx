import { Tabs, TabsContent, TabsList, TabsTrigger } from "@splitch/ui/components/tabs";
import { SPLITCH_SKILL_SOURCE } from "../docs/code-agents";
import { CodeSnippet } from "./code-snippet";

/* MCP leads because it is the agent's primary door (ADR-0023): one line, and the
   agent signs in on its first tool call. Shell comments carry the captions so the
   copied text still runs. */
const installPaths = [
  {
    value: "mcp",
    label: "MCP",
    code: `claude mcp add --transport http splitch https://mcp.splitch.dev
# Your agent signs in on its first tool call. No key to copy.`,
  },
  {
    value: "skill",
    label: "Skill",
    code: `npx skills add ${SPLITCH_SKILL_SOURCE}
# Codex, Claude Code, and OpenCode drive the CLI through its JSON output.`,
  },
  {
    value: "cli",
    label: "CLI",
    code: `npm install --global @splitch/cli
splitch login`,
  },
] as const;

export function InstallTabs() {
  return (
    <Tabs className="min-w-0 flex-col gap-3" defaultValue="mcp">
      <TabsList aria-label="How to connect">
        {installPaths.map((path) => (
          <TabsTrigger className="px-3" key={path.value} value={path.value}>
            {path.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {installPaths.map((path) => (
        <TabsContent className="min-w-0" key={path.value} value={path.value}>
          <CodeSnippet code={path.code} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
