import { isDocumentedErrorCode } from "./errors";
import {
  cliDocMarkdown,
  codeAgentsDocMarkdown,
  errorIndexMarkdown,
  errorMarkdown,
  flagsDocMarkdown,
  llmsTxt,
  quickstartMarkdown,
  sdkTopicMarkdown,
} from "./markdown";
import { findSdkTopic } from "./sdk";
import { htmlPathForMarkdownUrl } from "./serve-markdown";

const staticMarkdown = new Map<string, () => string>([
  ["/", llmsTxt],
  ["/docs", llmsTxt],
  ["/docs/", llmsTxt],
  ["/quickstart", quickstartMarkdown],
  ["/docs/flags", flagsDocMarkdown],
  ["/docs/cli", cliDocMarkdown],
  ["/docs/code-agents", codeAgentsDocMarkdown],
  ["/docs/errors", errorIndexMarkdown],
]);

export const staticMarkdownPaths = [...staticMarkdown.keys()] as const;

export function markdownForPath(pathname: string): string | null {
  const documentPath = htmlPathForMarkdownUrl(pathname);
  const staticDocument = staticMarkdown.get(documentPath);
  if (staticDocument) return staticDocument();

  const sdkSlug = routeSegment(documentPath, "/docs/sdk/");
  if (sdkSlug !== null) {
    const topic = findSdkTopic(sdkSlug);
    return topic ? sdkTopicMarkdown(topic) : null;
  }

  const errorCode = routeSegment(documentPath, "/docs/error/");
  return errorCode !== null && isDocumentedErrorCode(errorCode) ? errorMarkdown(errorCode) : null;
}

function routeSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length);
  if (segment.length === 0 || segment.includes("/") || segment.endsWith(".md")) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
