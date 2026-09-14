import pino from "pino";

/** One structured JSON logger for the runner process, matching `@fleet/keeper` and
 *  `@fleet/worker`'s own `createLogger` (writes NDJSON to stdout at `level` and above). Never
 *  call this with a secret (a private key, an RPC auth token) as a field value. */
export function createLogger(opts: { name: string; level?: string }): pino.Logger {
  return pino({ name: opts.name, level: opts.level ?? "info" });
}
