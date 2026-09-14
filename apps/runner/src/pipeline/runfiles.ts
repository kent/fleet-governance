import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export {
  GatewayLogLine,
  InterventionLine,
  LoopEventLine,
  ObjectionLine,
  StepLine,
  ToolCallLine,
} from "@fleet/schemas";
export type {
  GatewayLogLine as GatewayLogLineType,
  InterventionLine as InterventionLineType,
  LoopEventLine as LoopEventLineType,
  ObjectionLine as ObjectionLineType,
  StepLine as StepLineType,
  ToolCallLine as ToolCallLineType,
} from "@fleet/schemas";

/**
 * Append and read helpers for the JSON-lines files in a run directory
 * (`experiments/reports/<runId>/`). The line shapes themselves are `@fleet/schemas` exports
 * (`GatewayLogLine`, `StepLine`, `ObjectionLine`, `InterventionLine`, `LoopEventLine`), shared by
 * the pipeline that writes them and the Runner UI that reads them.
 */

/** The part of a zod schema `readJsonl` needs, named structurally so this package does not import
 *  zod itself. Every `@fleet/schemas` export satisfies it. */
export type LineSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } };
};

/** File names inside a run directory. */
export const RUN_FILES = {
  gateway: "gateway.jsonl",
  steps: "steps.jsonl",
  objections: "objections.jsonl",
  interventions: "interventions.jsonl",
  loopEvents: "loop-events.jsonl",
  log: "run.log",
  record: "record.json",
  report: "report.md",
} as const;

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Appends one JSON line, creating the directory if needed. Synchronous on purpose: the writers
 *  are event sinks that must not reorder lines. */
export function appendJsonl(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(value, bigintReplacer)}\n`, "utf8");
}

/** Reads every line of a JSON-lines file through `schema`. A missing file is an empty list. A line
 *  that does not parse or does not match the schema throws, naming the file and line number. */
export function readJsonl<T>(filePath: string, schema: LineSchema<T>): T[] {
  if (!existsSync(filePath)) return [];
  const out: T[] = [];
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`${filePath}:${i + 1}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${filePath}:${i + 1}: does not match the expected line shape: ${parsed.error.message}`);
    }
    out.push(parsed.data);
  }
  return out;
}
