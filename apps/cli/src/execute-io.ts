import type { CliIo } from "./execute-types.js";

export function emit(io: CliIo, asJson: boolean, payload: unknown): void {
  if (asJson) {
    io.log(JSON.stringify(payload));
    return;
  }
  io.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
}

export function consoleIo(): CliIo {
  return {
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
  };
}
