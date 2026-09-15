import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, formatEther, http, parseEther, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { CloudError, PROJECT, googleRequest, readObject, readSecret, writeObject } from "./google.js";

const WALLET_SECRET = "fleet-base-sepolia-wallets";
const CAPACITY = 25;
const FIXED = ["FLEET_DEPLOYER_KEY", "FLEET_OPERATOR_KEY", "FLEET_GUARDIAN_KEY", "FLEET_KEEPER_KEY"];
type WalletBundle = { schema: "fleet.wallets.v1"; chainId: 84532; keys: Record<string, Hex> };
export function walletNames(count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 2 || count > CAPACITY) throw new Error("This worker supports 2 to 25 funded agents.");
  return [...FIXED, ...Array.from({ length: count }, (_, id) => `FLEET_AGENT_KEY_${id}`)];
}

function parseWallets(raw: string): WalletBundle {
  const bundle = JSON.parse(raw) as WalletBundle;
  if (bundle.schema !== "fleet.wallets.v1" || bundle.chainId !== 84532 || !bundle.keys) throw new Error("Invalid testnet wallet bundle.");
  const addresses = new Set<string>();
  for (const name of walletNames(CAPACITY)) {
    const key = bundle.keys[name];
    if (!key || !/^0x[0-9a-f]{64}$/.test(key)) throw new Error("Testnet wallet bundle is incomplete.");
    addresses.add(privateKeyToAccount(key).address);
  }
  if (addresses.size !== CAPACITY + FIXED.length) throw new Error("Testnet wallets must have separate identities.");
  return bundle;
}

/** CI calls once. Runtime reads version 1 and never creates or rotates signing keys. */
export async function provisionWallets(): Promise<void> {
  try { parseWallets(await readSecret(WALLET_SECRET)); return; }
  catch (error) { if (!(error instanceof CloudError) || error.status !== 404) throw error; }
  // No overwrite on retry, disabled version or rotation. An ambiguous write must be read back.
  const versions = await (await googleRequest("secretmanager", `v1/projects/${PROJECT}/secrets/${WALLET_SECRET}/versions?pageSize=1`)).json() as { versions?: unknown[] };
  if (versions.versions?.length) throw new Error("Wallet versions already exist; automatic rotation is refused.");
  const bundle: WalletBundle = { schema: "fleet.wallets.v1", chainId: 84532, keys: Object.fromEntries(walletNames(CAPACITY).map(name => [name, generatePrivateKey()])) };
  await googleRequest("secretmanager", `v1/projects/${PROJECT}/secrets/${WALLET_SECRET}:addVersion`, { method: "POST", body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(bundle)).toString("base64") } }) });
  if (JSON.stringify(parseWallets(await readSecret(WALLET_SECRET))) !== JSON.stringify(bundle)) throw new Error("Wallet readback mismatch.");
}

export function faucetJwt(keyId: string, secret: string, now = Math.floor(Date.now() / 1000)): string {
  const bytes = Buffer.from(secret, "base64");
  if (bytes.length !== 64) throw new Error("Invalid CDP signing credential.");
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const publicBytes = createPublicKey(key).export({ format: "der", type: "spki" });
  if (!Buffer.from(publicBytes).subarray(-32).equals(bytes.subarray(32))) throw new Error("CDP key pair mismatch.");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "EdDSA", typ: "JWT", kid: keyId, nonce: randomBytes(16).toString("hex") })}.${encode({ sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uri: "POST api.cdp.coinbase.com/platform/v2/evm/faucet" })}`;
  return `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`;
}

/** Bounded faucet funding. A durable journal prevents retries of ambiguous requests. */
export async function fundWallets(count: number, progress: (message: string) => Promise<void> = async () => {}): Promise<Record<string, Hex>> {
  const names = walletNames(count);
  const bundle = parseWallets(await readSecret(WALLET_SECRET));
  const rpc = await readSecret("fleet-base-sepolia-rpc-url");
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 1 }) });
  if (await client.getChainId() !== 84532) throw new Error("Funding requires Base Sepolia 84532.");
  const [keyId, keySecret] = await Promise.all([readSecret("fleet-cdp-api-key-id"), readSecret("fleet-cdp-api-key-secret")]);
  for (const name of names) {
    const address = privateKeyToAccount(bundle.keys[name]!).address;
    const target = parseEther(name === "FLEET_DEPLOYER_KEY" ? "0.001" : name === "FLEET_KEEPER_KEY" ? "0.0003" : "0.0001");
    const journalPath = `wallets/faucet/${address.toLowerCase()}.json`;
    let balance = await client.getBalance({ address });
    const prior = await readObject<{ state: string; balanceBefore: string; txHash?: string }>(journalPath);
    if (prior?.state === "requested" && balance <= BigInt(prior.balanceBefore)) throw new Error(`Funding ${name} needs reconciliation of the previous faucet request.`);
    for (let attempt = 0; balance < target && attempt < 12; attempt++) {
      await progress(`Funding ${name.replace("FLEET_", "").replace("_KEY", "").toLowerCase()}: ${formatEther(balance)} Base Sepolia ETH.`);
      await writeObject(journalPath, { state: "requested", address, balanceBefore: balance.toString(), requestedAt: new Date().toISOString() });
      let response: Response;
      try {
        response = await fetch("https://api.cdp.coinbase.com/platform/v2/evm/faucet", { method: "POST", headers: { Authorization: `Bearer ${faucetJwt(keyId, keySecret)}`, "content-type": "application/json" }, body: JSON.stringify({ network: "base-sepolia", address, token: "eth" }), signal: AbortSignal.timeout(30_000) });
      } catch { throw new Error(`Faucet response for ${name} was uncertain; no automatic retry.`); }
      if (!response.ok) {
        // Provider rejection has no transfer. Do not retry quota errors in a tight loop.
        if (response.status < 500) await writeObject(journalPath, { state: "rejected", address, status: response.status });
        throw new Error(`CDP faucet returned HTTP ${response.status}. Funding can be retried after the provider limit clears.`);
      }
      const receipt = await response.json() as { transactionHash?: string };
      const before = balance;
      for (let poll = 0; poll < 30 && balance <= before; poll++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        balance = await client.getBalance({ address });
      }
      if (balance <= before) throw new Error(`Faucet funding for ${name} is still pending; no duplicate request sent.`);
      await writeObject(journalPath, { state: "funded", address, balance: balance.toString(), txHash: receipt.transactionHash, confirmedAt: new Date().toISOString() });
    }
    if (balance < target) throw new Error(`Funding target not reached for ${name}.`);
    await progress(`${name.replace("FLEET_", "").replace("_KEY", "").toLowerCase()} funded: ${address}, ${formatEther(balance)} Base Sepolia ETH.`);
  }
  return Object.fromEntries(names.map(name => [name, bundle.keys[name]!])) as Record<string, Hex>;
}
