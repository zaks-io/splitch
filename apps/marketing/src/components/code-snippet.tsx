import { Tabs, TabsContent, TabsList, TabsTrigger } from "@splitch/ui/components/tabs";

function Snippet({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 font-mono text-foreground text-sm leading-relaxed">
      <code>{code}</code>
    </pre>
  );
}

/* One command, two skins. Same contract underneath, so the tabs never drift. */
export function CodeSnippet({ cli, mcp, code }: { cli?: string; mcp?: string; code?: string }) {
  if (code !== undefined) {
    return <Snippet code={code} />;
  }
  if (cli === undefined || mcp === undefined) {
    throw new Error("CodeSnippet needs either `code` or both `cli` and `mcp`");
  }
  return (
    <Tabs defaultValue="mcp">
      <TabsList>
        <TabsTrigger value="mcp">Agent · MCP</TabsTrigger>
        <TabsTrigger value="cli">Human · CLI</TabsTrigger>
      </TabsList>
      <TabsContent value="mcp">
        <Snippet code={mcp} />
      </TabsContent>
      <TabsContent value="cli">
        <Snippet code={cli} />
      </TabsContent>
    </Tabs>
  );
}
