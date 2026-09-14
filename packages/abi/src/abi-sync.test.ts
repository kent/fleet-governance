import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The committed ABIs against the compiled contracts (final review M9). `contracts/script/
 * export-abi.sh` copies `jq '.abi' contracts/out/<C>.sol/<C>.json` into `packages/abi/abis/<C>.json`
 * by hand, and `scripts/generate.ts` then freezes those files into `src/index.ts`. Nothing failed
 * if a contract changed and the export was not re-run: the SDK would encode calldata for a stale
 * signature and only the onchain revert would show it.
 *
 * Skipped when `contracts/out` is absent, since that only means `forge build` has not run in this
 * checkout, not that anything is wrong.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(currentDir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const forgeOutDir = path.join(repoRoot, "contracts", "out");
const abisDir = path.join(packageDir, "abis");

/** Every contract `export-abi.sh` exports, named exactly as it names them. */
const EXPORTED_CONTRACTS = [
  "FleetRegistry",
  "FleetVotes",
  "FleetHook",
  "TaskLedger",
  "AgoraGovernor",
  "TimelockController",
] as const;

const FORGE_OUT_AVAILABLE = existsSync(forgeOutDir);

function forgeArtifactAbi(contract: string): unknown {
  const artifactPath = path.join(forgeOutDir, `${contract}.sol`, `${contract}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown };
  return artifact.abi;
}

function committedAbi(contract: string): unknown {
  return JSON.parse(readFileSync(path.join(abisDir, `${contract}.json`), "utf8"));
}

describe.skipIf(!FORGE_OUT_AVAILABLE)("committed ABIs match the compiled contracts", () => {
  for (const contract of EXPORTED_CONTRACTS) {
    it(`${contract}.json is what forge compiled`, () => {
      const artifactPath = path.join(forgeOutDir, `${contract}.sol`, `${contract}.json`);
      expect(existsSync(artifactPath), `no forge artifact at ${artifactPath}; run forge build`).toBe(true);
      // Deep equality on parsed JSON, so formatting and key order are irrelevant and only the
      // interface itself has to agree. Re-running contracts/script/export-abi.sh is the fix when
      // this fails.
      expect(committedAbi(contract), `packages/abi/abis/${contract}.json is stale; re-run contracts/script/export-abi.sh`).toEqual(
        forgeArtifactAbi(contract),
      );
    });
  }

  it("src/index.ts's frozen copies match the abis/ directory", async () => {
    // `scripts/generate.ts` is the only thing that writes src/index.ts, from abis/, so a stale
    // index means `pnpm --filter @fleet/abi generate` was not re-run after an export.
    const generated = (await import("./index.js")) as Record<string, unknown>;
    for (const contract of EXPORTED_CONTRACTS) {
      const exportName = `${contract.charAt(0).toLowerCase()}${contract.slice(1)}Abi`;
      expect(generated[exportName], `${exportName} is not exported from src/index.ts`).toBeDefined();
      expect(generated[exportName], `${exportName} is stale; re-run pnpm --filter @fleet/abi generate`).toEqual(
        committedAbi(contract),
      );
    }
  });
});

describe.skipIf(FORGE_OUT_AVAILABLE)("ABI sync check (skipped)", () => {
  it("skips cleanly when contracts/out is absent", () => {
    expect(FORGE_OUT_AVAILABLE).toBe(false);
  });
});
