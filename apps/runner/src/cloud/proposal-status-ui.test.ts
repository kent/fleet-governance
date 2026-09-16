// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const txHash = `0x${"a".repeat(64)}`;
beforeEach(() => { vi.useFakeTimers(); window.history.replaceState({}, "", "/proposals/123"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.documentElement.innerHTML = ""; });
async function load(state: unknown) {
  document.documentElement.innerHTML = readFileSync("apps/runner/public/proposal-status.html", "utf8");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => state })));
  new Function(readFileSync("apps/runner/public/proposal-status.js", "utf8"))();
  await vi.waitFor(() => expect(document.getElementById("run-phase")?.textContent).not.toBe("Loading the recorded run"));
}
describe("proposal evidence fallback", () => {
  it("keeps confirmed partial ballots visible when indexing fails and compute is off", async () => {
    await load({ observedAt: new Date().toISOString(), simulationWork: { proposalId: "123", proposeTxHash: txHash },
      vm: { status: "TERMINATED" }, state: { phase: "halted", reason: "vote_failed" },
      simulationStatus: { runId: "run-current", phase: "failed", agents: [
        { agentId: 0, phase: "voted", txHash, vote: { support: "AGAINST", rationale: "<img src=x onerror=alert(1)>" } },
        { agentId: 1, phase: "submitting", txHash, vote: { support: "FOR" } },
      ], votes: [] } });
    expect(document.getElementById("proposal-vote-count")?.textContent).toBe("1 / 5 confirmed ballots");
    expect(document.getElementById("proposal-ballots")?.textContent).toContain("AGAINST");
    expect(document.querySelectorAll("#proposal-ballots img")).toHaveLength(0);
    expect(document.getElementById("proposal-worker")?.textContent).toBe("TERMINATED");
    expect(document.getElementById("run-phase")?.textContent).toBe("Compute authority closed");
    expect(fetch).toHaveBeenCalledWith("/api/compute-policy", { cache: "no-store" });
  });
  it("never substitutes a different run's evidence for the requested proposal", async () => {
    await load({ simulationWork: { proposalId: "456" }, simulationStatus: { runId: "wrong-run" }, evidence: { proposalId: "789", runId: "wrong-evidence" } });
    expect(document.getElementById("run-phase")?.textContent).toBe("No matching run evidence yet");
    expect(document.body.textContent).not.toContain("wrong-run");
    expect(document.body.textContent).not.toContain("wrong-evidence");
  });
});
