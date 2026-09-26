import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ActivityAttestor, type ActivityAttestation } from "./activity-attestation.js";
import { decodeAnchor, encodeAnchor, verifyAnchor } from "./activity-anchor.js";

const key = `0x${"1".repeat(64)}` as const;
const address = privateKeyToAccount(key).address;
const runId = "run-00000000-0000-4000-8000-000000000001";

async function log(count: number) {
  const records: ActivityAttestation[] = [];
  const attestor = new ActivityAttestor({ key, runId, chainId: 84532, taskId: 7n, agentId: 2, record: r => records.push(r) });
  for (let i = 0; i < count; i++) attestor.record({ type: "work_report", step: i, summary: `finding ${i}` });
  await attestor.flush();
  return records;
}

describe("onchain activity anchors", () => {
  it("round-trips the run, task, sequence and digest", async () => {
    const [record] = await log(1);
    const data = encodeAnchor({ runId, taskId: "7", sequence: 0, digest: record!.digest });
    expect(decodeAnchor(data)).toMatchObject({ taskId: "7", sequence: 0, digest: record!.digest });
    expect(decodeAnchor("0x12345678")).toBeNull();
  });

  it("verifies an anchor that commits the whole signed log up to its sequence", async () => {
    const records = await log(4);
    const tx = { from: address, to: address, value: 0n, input: encodeAnchor({ runId, taskId: "7", sequence: 3, digest: records[3]!.digest }) };
    expect(await verifyAnchor(tx, { runId, taskId: "7", address, activity: records })).toEqual({ ok: true, sequence: 3 });
  });

  it("rejects an anchor from another sender, another run, a wrong digest or an edited earlier record", async () => {
    const records = await log(3);
    const input = (sequence: number, digest = records[sequence]!.digest, run = runId) => encodeAnchor({ runId: run, taskId: "7", sequence, digest });
    const check = (tx: Parameters<typeof verifyAnchor>[0], activity = records) => verifyAnchor(tx, { runId, taskId: "7", address, activity });
    const other = `0x${"9".repeat(40)}` as const;
    expect((await check({ from: other, to: address, value: 0n, input: input(2) })).ok).toBe(false);
    expect((await check({ from: address, to: address, value: 0n, input: input(2, records[2]!.digest, "run-other") })).ok).toBe(false);
    expect((await check({ from: address, to: address, value: 0n, input: input(2, records[1]!.digest) })).ok).toBe(false);
    // Rewriting an earlier record breaks the chain the anchor commits to.
    const edited = records.map((r, i) => i === 0 ? { ...r, event: { type: "work_report", summary: "rewritten" } } : r);
    expect(await check({ from: address, to: address, value: 0n, input: input(2) }, edited)).toMatchObject({ ok: false });
  });
});
