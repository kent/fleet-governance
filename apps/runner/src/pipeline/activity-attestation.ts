import { keccak256, toHex, verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type ActivityAttestation = {
  schema: "fleet.activity.v1"; runId: string; chainId: number; taskId: string; agentId: number;
  address: Hex; sequence: number; previousHash: Hex; event: unknown; at: string;
  message: string; digest: Hex; signature: Hex;
};

/** Offchain attestations bind an observed event to an agent identity and this run. */
export class ActivityAttestor {
  private pending = Promise.resolve();
  private sequence = 0;
  private previousHash: Hex = `0x${"0".repeat(64)}`;
  constructor(private readonly options: { key: Hex; runId: string; chainId: number; taskId: bigint; agentId: number; record: (value: ActivityAttestation) => void }) {}

  record(event: unknown): void {
    // Freeze the event before callers can mutate it; signing happens in event order.
    const frozen = JSON.parse(JSON.stringify(event, (_, item) => typeof item === "bigint" ? item.toString() : item));
    const at = new Date().toISOString();
    this.pending = this.pending.then(async () => {
      const account = privateKeyToAccount(this.options.key);
      const payload = { schema: "fleet.activity.v1" as const, runId: this.options.runId, chainId: this.options.chainId, taskId: this.options.taskId.toString(), agentId: this.options.agentId, address: account.address, sequence: this.sequence++, previousHash: this.previousHash, event: frozen, at };
      const message = JSON.stringify(payload);
      const digest = keccak256(toHex(message));
      const signature = await account.signMessage({ message });
      this.options.record({ ...payload, message, digest, signature });
      this.previousHash = digest;
    });
    // Keep the rejection for flush(), while avoiding an unhandled rejection during work.
    void this.pending.catch(() => {});
  }
  async flush(): Promise<void> { await this.pending; }
}

export async function verifyActivity(attestation: ActivityAttestation): Promise<boolean> {
  try {
    const { message, digest, signature, ...payload } = attestation;
    if (JSON.stringify(payload) !== message || keccak256(toHex(message)) !== digest) return false;
    return await verifyMessage({ address: attestation.address, message, signature });
  } catch { return false; }
}
