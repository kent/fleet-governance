import pino from "pino";

/** One structured JSON logger for this process, `name` tagging every line (`"keeper"` in
 *  `main.ts`, a distinct name in tests where useful). Writes NDJSON to stdout at `level` and
 *  above; never call this with a secret (a private key, an RPC auth token) as a field value. */
export function createLogger(opts: { name: string; level: string }): pino.Logger {
  return pino({ name: opts.name, level: opts.level });
}
