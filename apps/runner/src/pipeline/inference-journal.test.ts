import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openInferenceJournal } from "./inference-journal.js";

const dirs: string[] = [];
function file() { const dir = mkdtempSync(path.join(tmpdir(), "fleet-inference-owner-")); dirs.push(dir); return path.join(dir, "inference.jsonl"); }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const event = { type: "started" as const, id: "attempt", at: "now", agentId: 0, provider: "openrouter" as const, model: "test", purpose: "task" as const, queueMs: 0,
  reservation: { inputTokens: 100, outputTokens: 20, costNanodollars: "140000" } };

it("excludes a second owner and retains a synced interrupted reservation on reopen", () => {
  const journalFile = file();
  const journal = openInferenceJournal(journalFile, "chain:ledger:task");
  try {
    journal.append(event);
    expect(() => openInferenceJournal(journalFile, "chain:ledger:task")).toThrow("already owned");
    expect(JSON.parse(readFileSync(journalFile, "utf8"))).toEqual(event);
  } finally { journal.close(); }
  const reopened = openInferenceJournal(journalFile, "chain:ledger:task");
  try { expect(reopened.history).toEqual([event]); } finally { reopened.close(); }
});

it("refuses another task's journal and rejects corrupt usage without retaining its lock", () => {
  const journalFile = file();
  openInferenceJournal(journalFile, "first").close();
  expect(() => openInferenceJournal(journalFile, "second")).toThrow("different chain or task");
  const journal = openInferenceJournal(journalFile, "first");
  journal.close();
  writeFileSync(journalFile, '{"type":');
  expect(() => openInferenceJournal(journalFile, "first")).toThrow("not valid JSON");
  writeFileSync(journalFile, "");
  openInferenceJournal(journalFile, "first").close();
});

it("does not steal a stale-looking lock and refuses writes after ownership changes", () => {
  const journalFile = file();
  const journal = openInferenceJournal(journalFile, "scope");
  const owner = readFileSync(`${journalFile}.lock`, "utf8");
  writeFileSync(`${journalFile}.lock`, '{"pid":999999999,"host":"other"}');
  expect(() => openInferenceJournal(journalFile, "scope")).toThrow("already owned");
  expect(() => journal.append(event)).toThrow("ownership lost");
  writeFileSync(`${journalFile}.lock`, owner);
  journal.close();
  expect(() => journal.append(event)).toThrow("ownership lost");
});
