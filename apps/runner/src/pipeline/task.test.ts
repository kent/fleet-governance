import { describe, expect, it } from "vitest";
import { encodeEventTopics, encodeAbiParameters, keccak256, toHex } from "viem";
import type { Address, Log } from "viem";
import { fleetVotesAbi, taskLedgerAbi } from "@fleet/abi";
import { taskIdFromReceiptLogs } from "./task.js";

const LEDGER = `0x${"a4".repeat(20)}` as Address;
const TOKEN = `0x${"a2".repeat(20)}` as Address;

function taskOpenedLog(taskId: bigint, address: Address = LEDGER): Log {
  const operator = `0x${"11".repeat(20)}` as Address;
  const charterText = '{"schema":"fleet.charter.v1"}';
  const topics = encodeEventTopics({
    abi: taskLedgerAbi,
    eventName: "TaskOpened",
    args: { taskId, operator },
  });
  const data = encodeAbiParameters(
    [{ type: "uint64" }, { type: "bytes32" }, { type: "string" }],
    [1_700_000_000n, keccak256(toHex(charterText)), charterText],
  );
  return { address, topics, data } as unknown as Log;
}

function unrelatedLog(): Log {
  const topics = encodeEventTopics({
    abi: fleetVotesAbi,
    eventName: "DelegateChanged",
    args: {
      delegator: `0x${"22".repeat(20)}` as Address,
      fromDelegate: `0x${"33".repeat(20)}` as Address,
      toDelegate: `0x${"44".repeat(20)}` as Address,
    },
  });
  return { address: TOKEN, topics, data: "0x" } as unknown as Log;
}

describe("taskIdFromReceiptLogs (final review M4)", () => {
  it("reads the task id out of this transaction's own TaskOpened log", () => {
    expect(taskIdFromReceiptLogs([taskOpenedLog(7n)], LEDGER)).toBe(7n);
  });

  it("ignores logs from other contracts in the same transaction", () => {
    expect(taskIdFromReceiptLogs([unrelatedLog(), taskOpenedLog(3n), unrelatedLog()], LEDGER)).toBe(3n);
  });

  it("ignores a TaskOpened emitted by some other ledger address", () => {
    const other = `0x${"bb".repeat(20)}` as Address;
    expect(() => taskIdFromReceiptLogs([taskOpenedLog(9n, other)], LEDGER)).toThrow(/no TaskOpened log/);
  });

  it("matches the ledger address case-insensitively", () => {
    expect(taskIdFromReceiptLogs([taskOpenedLog(5n, LEDGER.toUpperCase() as Address)], LEDGER)).toBe(5n);
  });

  it("throws rather than guessing when the receipt carries no TaskOpened log", () => {
    expect(() => taskIdFromReceiptLogs([unrelatedLog()], LEDGER)).toThrow(/no TaskOpened log/);
    expect(() => taskIdFromReceiptLogs([], LEDGER)).toThrow(/no TaskOpened log/);
  });

  it("does not depend on taskCount, so a concurrently opened task cannot shift the id", () => {
    // The exact regression: reading taskCount() after the send returned whatever the ledger's
    // counter was at read time, which a second runner or a manual `fleet open-task` could have
    // moved. A receipt's own logs cannot be raced.
    const logs = [taskOpenedLog(2n), unrelatedLog()];
    expect(taskIdFromReceiptLogs(logs, LEDGER)).toBe(2n);
  });
});
