import type { Address } from "viem";

/**
 * `HealthPanel`'s data (spec 12.3: "keeper and indexer health"; task 6 controller notes' ruling):
 * DAO Node `/v1/progress` lag, CPLS `/health` reachability, Agora Next reachability, the keeper's
 * last logged action, and every signer's balance. Every probe has a 3s timeout and reports
 * `unreachable` rather than throwing (controller notes: "reports `unreachable` rather than
 * throwing").
 */

export type ProbeResult = { ok: boolean; detail: string };
export type DaoNodeHealth = ProbeResult & { lagBlocks: number | null };
export type SignerBalance = { label: string; address: string; balanceWei: string | null; ok: boolean };

export type HealthView = {
  daoNode: DaoNodeHealth;
  cpls: ProbeResult;
  agoraNext: ProbeResult;
  keeperLastAction: string | null;
  signerBalances: SignerBalance[];
};

/** A plain, timeout-bounded HTTP GET, returning just enough to probe reachability and parse a
 *  JSON body. Never throws for a non-2xx response (matches `pipeline/preflight.ts`'s
 *  `PreflightDeps.fetchUrl`); a genuine network failure (timeout, DNS, connection refused) still
 *  rejects, which every caller below catches. */
export type FetchProbe = (url: string, timeoutMs: number) => Promise<{ ok: boolean; status: number; text: string }>;

export const defaultFetchProbe: FetchProbe = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
};

/** Field names DAO Node's `/v1/progress` might report the chain head it has indexed under. No
 *  vendored `infra/dao-node` source is checked into this repository (it is built from a pinned
 *  upstream fork at infra build time), so this tries every plausible key rather than assuming one;
 *  see the task 6 report's Deviations. */
const PROGRESS_BLOCK_KEYS = ["blockNumber", "block", "block_number", "head", "highestBlockNumber", "latestBlock"];

function extractReportedBlock(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of PROGRESS_BLOCK_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/** DAO Node's indexing lag: chain tip minus the block it last reported through `/v1/progress`.
 *  `getChainHead` is only called when the HTTP probe itself succeeds, so an unreachable DAO Node
 *  never also charges a chain read to the health check. */
export async function probeDaoNode(
  daoNodeUrl: string,
  getChainHead: () => Promise<bigint>,
  fetchProbe: FetchProbe = defaultFetchProbe,
  timeoutMs = 3000,
): Promise<DaoNodeHealth> {
  const url = `${daoNodeUrl.replace(/\/+$/, "")}/v1/progress`;
  let res: Awaited<ReturnType<FetchProbe>>;
  try {
    res = await fetchProbe(url, timeoutMs);
  } catch (err) {
    return { ok: false, lagBlocks: null, detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, lagBlocks: null, detail: `${url} -> HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    return { ok: true, lagBlocks: null, detail: `${url} -> HTTP ${res.status}, response was not JSON` };
  }
  const reportedBlock = extractReportedBlock(body);
  if (reportedBlock === null) {
    return { ok: true, lagBlocks: null, detail: `${url} -> HTTP ${res.status}, no recognized block field in the response` };
  }
  try {
    const head = await getChainHead();
    const lag = Number(head) - reportedBlock;
    return { ok: true, lagBlocks: lag, detail: `reports block ${reportedBlock}, chain head ${head.toString()}` };
  } catch (err) {
    return { ok: true, lagBlocks: null, detail: `reports block ${reportedBlock}, could not read chain head: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A plain reachability probe: `ok` iff the request resolves with a 2xx/3xx-ish HTTP response
 *  within `timeoutMs`. */
export async function probeReachable(url: string, fetchProbe: FetchProbe = defaultFetchProbe, timeoutMs = 3000): Promise<ProbeResult> {
  try {
    const res = await fetchProbe(url, timeoutMs);
    return res.ok ? { ok: true, detail: `${url} -> HTTP ${res.status}` } : { ok: false, detail: `${url} -> HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The last `run.log` line mentioning "keeper" (case-insensitive), controller notes: "keeper last
 *  action from run.log lines containing 'keeper'". `null` when the log has no such line yet. */
export function keeperLastActionFromLog(logText: string): string | null {
  const lines = logText.split("\n").filter((line) => /keeper/i.test(line));
  const last = lines.at(-1);
  return last && last.trim().length > 0 ? last.trim() : null;
}

export async function probeSignerBalance(
  label: string,
  address: Address,
  getBalanceWei: (address: Address) => Promise<bigint>,
): Promise<SignerBalance> {
  try {
    const balance = await getBalanceWei(address);
    return { label, address, balanceWei: balance.toString(), ok: true };
  } catch {
    return { label, address, balanceWei: null, ok: false };
  }
}

export type HealthDeps = {
  daoNodeUrl: string;
  cplsUrl: string;
  agoraNextUrl: string | null;
  getChainHead: () => Promise<bigint>;
  getBalanceWei: (address: Address) => Promise<bigint>;
  signers: readonly { label: string; address: Address }[];
  logText: string;
  fetchProbe?: FetchProbe;
  timeoutMs?: number;
};

/** Assembles the whole `HealthPanel` view in parallel: DAO Node lag, CPLS and Agora Next
 *  reachability, the keeper's last logged action, and every signer's balance. Agora Next is
 *  skipped (reported unreachable, "not configured") when `agoraNextUrl` is unset. */
export async function probeHealth(deps: HealthDeps): Promise<HealthView> {
  const fetchProbe = deps.fetchProbe ?? defaultFetchProbe;
  const timeoutMs = deps.timeoutMs ?? 3000;

  const [daoNode, cpls, agoraNext, signerBalances] = await Promise.all([
    probeDaoNode(deps.daoNodeUrl, deps.getChainHead, fetchProbe, timeoutMs),
    probeReachable(`${deps.cplsUrl.replace(/\/+$/, "")}/health`, fetchProbe, timeoutMs),
    deps.agoraNextUrl ? probeReachable(deps.agoraNextUrl, fetchProbe, timeoutMs) : Promise.resolve({ ok: false, detail: "not configured (display.agoraNextBaseUrl unset)" }),
    Promise.all(deps.signers.map((s) => probeSignerBalance(s.label, s.address, deps.getBalanceWei))),
  ]);

  return { daoNode, cpls, agoraNext, keeperLastAction: keeperLastActionFromLog(deps.logText), signerBalances };
}
