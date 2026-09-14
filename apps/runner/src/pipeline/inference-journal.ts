import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { InferenceEvent } from "@fleet/agent-runtime";
import { readJsonl } from "./runfiles.js";

/** One coordinator owns a run journal. The lock is never stolen automatically: an interrupted
 * run needs its old owner confirmed stopped before lock removal. Use a shared filesystem when
 * moving a run between hosts; separate copies cannot coordinate one allowance. */
export function openInferenceJournal(file: string, scope: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const owner = JSON.stringify({ id: randomUUID(), pid: process.pid, host: hostname(), scope });
  let lockFd: number;
  try { lockFd = openSync(lock, "wx", 0o600); }
  catch { throw new Error("inference journal is already owned or its lock cannot be created; confirm the prior owner has stopped before recovery"); }
  let fd: number | undefined;
  try {
    writeSync(lockFd, owner);
    fsyncSync(lockFd);
    const scopeFile = `${file}.scope`;
    try {
      const scopeFd = openSync(scopeFile, "wx", 0o600);
      try { writeSync(scopeFd, scope); fsyncSync(scopeFd); } finally { closeSync(scopeFd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readFileSync(scopeFile, "utf8") !== scope) throw new Error("inference journal belongs to a different chain or task");
    }
    const history = readJsonl(file, InferenceEvent);
    fd = openSync(file, "a", 0o600);
    const directory = openSync(path.dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    let closed = false;
    return {
      history,
      append(event: InferenceEvent): void {
        if (closed || readFileSync(lock, "utf8") !== owner) throw new Error("inference journal ownership lost");
        const line = Buffer.from(`${JSON.stringify(InferenceEvent.parse(event))}\n`);
        let written = 0;
        while (written < line.length) {
          const count = writeSync(fd!, line, written, line.length - written);
          if (count === 0) throw new Error("inference journal write made no progress");
          written += count;
        }
        fsyncSync(fd!);
      },
      close(): void {
        if (closed) return;
        closed = true;
        try { closeSync(fd!); } finally {
          closeSync(lockFd);
          if (readFileSync(lock, "utf8") === owner) unlinkSync(lock);
        }
      },
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    closeSync(lockFd);
    unlinkSync(lock);
    throw error;
  }
}
