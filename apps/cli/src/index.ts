// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); placeholder until the CLI surface is built out and re-exports are reorganized
export { runCli } from "./cli";
export {
  cliClientErrorCodes,
  cliErrorCodes,
  formatCliError,
  SplitchCliError,
} from "./errors";
export type { CliClientErrorCode, CliErrorDetail, SplitchCliErrorCode } from "./errors";
