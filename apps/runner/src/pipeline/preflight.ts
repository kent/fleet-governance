import { execFileSync } from "node:child_process";
import type { Address } from "viem";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type PreflightCheck = { name: string; ok: boolean; detail: string };
export type PreflightReport = { checks: PreflightCheck[]; ok: boolean };

/** Every I/O `runPreflight` needs, injected so every check is fakeable in a unit test (task 8
 *  finding 2: "Unit-test with fakes"). `hasBinary` defaults to a real `which` lookup in
 *  `defaultPreflightDeps`; every other field has no default, since what it should return is
 *  entirely caller/context-specific (which chain, which keys, which read-side URLs). */
export type PreflightDeps = {
  hasBinary: (name: string) => boolean;
  getChainId: () => Promise<number>;
  getBalanceWei: (address: Address) => Promise<bigint>;
  /** A plain `fetch`-shaped HTTP GET, returning just `ok`/`status` (never throws on a non-2xx
   *  response; a network failure should reject, matching `fetch` itself). */
  fetchUrl: (url: string) => Promise<{ ok: boolean; status: number }>;
};

function requiredOverride(name: string): () => never {
  return () => {
    throw new Error(`defaultPreflightDeps: ${name} must be provided by the caller`);
  };
}

export function defaultPreflightDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  const base: PreflightDeps = {
    hasBinary: (name) => {
      try {
        execFileSync("which", [name], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    getChainId: requiredOverride("getChainId"),
    getBalanceWei: requiredOverride("getBalanceWei"),
    fetchUrl: async (url) => {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status };
    },
  };
  return { ...base, ...overrides };
}

export type PreflightOptions = {
  deps: PreflightDeps;
  /** Whether the read side (Docker Compose stack) is part of this run, gating the `docker` tool
   *  check and the container-health/bucket checks. */
  readSideEnabled: boolean;
  /** `{label, address}` for every key this run will sign with: deployer, operator, guardian,
   *  keeper, and each fleet agent (spec 12.2: "key balances"). */
  keyAddresses: readonly { label: string; address: Address }[];
  /** When a manifest already exists at the run's deploy output path, its `chainId`, to catch a
   *  target RPC that does not match an existing deployment before anything is (re)deployed. */
  existingManifestChainId?: number;
  readSide?: { daoNodeUrl: string; cplsUrl: string; agoraNextUrl: string };
  /** A URL whose `fetchUrl` result decides bucket access: the fake-gcs bucket listing endpoint
   *  offline, or a `HEAD` against the real bucket's public base URL otherwise. */
  bucketCheckUrl?: string;
};

/**
 * Spec 12.2: "PREFLIGHT checks tool versions, container health, key balances, chain ID, and
 * bucket access." Runs every check (never stops at the first failure, so one `fleet run` invocation
 * reports everything wrong at once) and returns a report; throws nothing itself; `ok` is
 * `false` when any check failed.
 */
export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  const tools = ["forge", "anvil", "cast", ...(opts.readSideEnabled ? ["docker"] : [])];
  for (const tool of tools) {
    const ok = opts.deps.hasBinary(tool);
    checks.push({ name: `tool:${tool}`, ok, detail: ok ? `${tool} found on PATH` : `${tool} not found on PATH` });
  }

  try {
    const chainId = await opts.deps.getChainId();
    if (opts.existingManifestChainId !== undefined && opts.existingManifestChainId !== chainId) {
      checks.push({
        name: "chain_id",
        ok: false,
        detail: `RPC reports chainId ${chainId}, but the existing manifest at the deploy output path was for chainId ${opts.existingManifestChainId}`,
      });
    } else {
      checks.push({ name: "chain_id", ok: true, detail: `reachable, chainId ${chainId}` });
    }
  } catch (err) {
    checks.push({ name: "chain_id", ok: false, detail: `chain not reachable: ${errorMessage(err)}` });
  }

  for (const { label, address } of opts.keyAddresses) {
    try {
      const balance = await opts.deps.getBalanceWei(address);
      const ok = balance > 0n;
      checks.push({
        name: `balance:${label}`,
        ok,
        detail: ok ? `${address} balance ${balance.toString()} wei` : `${address} (${label}) has a zero balance`,
      });
    } catch (err) {
      checks.push({ name: `balance:${label}`, ok: false, detail: `could not read balance for ${address} (${label}): ${errorMessage(err)}` });
    }
  }

  if (opts.readSideEnabled && opts.readSide) {
    const endpoints: [string, string][] = [
      ["dao_node:/v1/progress", `${opts.readSide.daoNodeUrl.replace(/\/$/, "")}/v1/progress`],
      ["cpls:/health", `${opts.readSide.cplsUrl.replace(/\/$/, "")}/health`],
      ["agora_next:/proposals", `${opts.readSide.agoraNextUrl.replace(/\/$/, "")}/proposals`],
    ];
    for (const [name, url] of endpoints) {
      try {
        const res = await opts.deps.fetchUrl(url);
        checks.push({ name, ok: res.ok, detail: res.ok ? `${url} -> ${res.status}` : `${url} -> ${res.status}` });
      } catch (err) {
        checks.push({ name, ok: false, detail: `${url} unreachable: ${errorMessage(err)}` });
      }
    }

    if (opts.bucketCheckUrl) {
      try {
        const res = await opts.deps.fetchUrl(opts.bucketCheckUrl);
        checks.push({
          name: "bucket_access",
          ok: res.ok,
          detail: res.ok ? `${opts.bucketCheckUrl} -> ${res.status}` : `${opts.bucketCheckUrl} -> ${res.status}`,
        });
      } catch (err) {
        checks.push({ name: "bucket_access", ok: false, detail: `${opts.bucketCheckUrl} unreachable: ${errorMessage(err)}` });
      }
    } else {
      checks.push({ name: "bucket_access", ok: false, detail: "read side enabled but no bucketCheckUrl was configured" });
    }
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

/** Renders a `PreflightReport` as plain text lines, one per check, `[ok]`/`[FAIL]` prefixed. */
export function formatPreflightReport(report: PreflightReport): string {
  return report.checks.map((c) => `[${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`).join("\n");
}
