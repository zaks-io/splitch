import { dirname, resolve } from "node:path";
import {
  createCompilerHost,
  createProgram,
  createSourceFile,
  type Diagnostic,
  flattenDiagnosticMessageText,
  parseJsonConfigFileContent,
  readConfigFile,
  ScriptKind,
  sys,
  type CompilerOptions,
  type Program,
} from "typescript";

interface ParsedConfig {
  fileNames: string[];
  options: CompilerOptions;
}

export function projectProgram(configPath: string): Program {
  const parsed = parsedConfig(configPath);
  return createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

export function sourceProgram(
  configPath: string,
  sources: Readonly<Record<string, string>>,
): Program {
  const parsed = parsedConfig(configPath);
  const sourceByPath = new Map(
    Object.entries(sources).map(([fileName, source]) => [resolve(fileName), source]),
  );
  const host = createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) => sourceByPath.has(resolve(fileName)) || fileExists(fileName);
  host.readFile = (fileName) => sourceByPath.get(resolve(fileName)) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sourceByPath.get(resolve(fileName));
    if (source === undefined) {
      return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    return createSourceFile(
      fileName,
      source,
      languageVersion,
      true,
      fileName.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
    );
  };

  return createProgram({
    rootNames: [...sourceByPath.keys()],
    options: parsed.options,
    host,
  });
}

function parsedConfig(configPath: string): ParsedConfig {
  const config = readConfigFile(configPath, sys.readFile);
  if (config.error) throw new Error(diagnosticMessage(config.error));
  const parsed = parseJsonConfigFileContent(
    config.config,
    sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(diagnosticMessage).join("\n"));
  }
  return parsed;
}

function diagnosticMessage(diagnostic: Pick<Diagnostic, "messageText">): string {
  return flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
