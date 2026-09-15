import { expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { ActivityAttestor, verifyActivity, type ActivityAttestation } from "./activity-attestation.js";

it("binds ordered activity to the run and identity, detects edits and chains event digests", async () => {
  const records: ActivityAttestation[] = [];
  const attestor = new ActivityAttestor({ key: generatePrivateKey(), runId: "test-run", chainId: 84532, taskId: 1n, agentId: 0, record: value => records.push(value) });
  attestor.record({ type: "step_published", why: "Inspect the tests." });
  attestor.record({ type: "tool_result", ok: true });
  await attestor.flush();
  expect(records).toHaveLength(2);
  expect(await verifyActivity(records[0]!)).toBe(true);
  expect(await verifyActivity(records[1]!)).toBe(true);
  expect(records[1]!.previousHash).toBe(records[0]!.digest);
  expect(records[1]!.sequence).toBe(1);
  expect(await verifyActivity({ ...records[0]!, runId: "another-run" })).toBe(false);
  expect(await verifyActivity({ ...records[0]!, event: { type: "published" } })).toBe(false);
});
