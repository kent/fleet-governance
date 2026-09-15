import { setTimeout as delay } from "node:timers/promises";
import type { Provider } from "@fleet/agent-runtime";
import { permitsTaskExecution, type ComputeAllocation, type ComputeState } from "./compute-policy.js";
import { isComputeRunBlocked, readComputeAllocation, readComputeState } from "./compute-store.js";

export type TaskAuthority = { blocked: boolean; allocation: ComputeAllocation | null; state: ComputeState | null };
export function taskAuthority(authority: TaskAuthority, runId: string, now: number): "allow" | "wait" | "halt" {
  if (authority.blocked) return "halt";
  const { allocation, state } = authority;
  if (!allocation) return "allow"; // Explicitly unarmed legacy/research mode.
  if (allocation.runId !== runId || now >= allocation.stopAt || state?.phase === "halted"
    || state && state.allocationId !== allocation.allocationId) return "halt";
  return state && permitsTaskExecution(state, allocation, now) ? "allow" : "wait";
}

/** Shared by all task agents. It gates new inference, tool dispatch and task proposals.
 * Governance vote providers stay available while a required vote is pending. The
 * independent GCP controller, not this cooperative gate, owns power-off authority. */
export function computeTaskGate(runId: string, controller: AbortController) {
  let armed = false;
  let pending: Promise<TaskAuthority> | undefined;
  let last: TaskAuthority | undefined;
  let fetchedAt = 0;
  const read = async (): Promise<TaskAuthority> => {
    if (last && Date.now() - fetchedAt < 1000) return last;
    pending ??= (async () => {
      const [blocked, allocation] = await Promise.all([isComputeRunBlocked(runId), readComputeAllocation()]);
      const state = allocation ? (await readComputeState(allocation.allocationId))?.value ?? null : null;
      if (allocation) armed = true;
      last = { blocked: blocked || (armed && !allocation), allocation, state };
      fetchedAt = Date.now();
      return last;
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const check = async () => {
    try {
      const verdict = taskAuthority(await read(), runId, Math.floor(Date.now() / 1000));
      if (verdict === "halt") controller.abort(new Error("Compute governance halted this run."));
      return verdict;
    } catch {
      controller.abort(new Error("Compute authority could not be verified."));
      return "halt" as const;
    }
  };
  const wait = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const verdict = await check();
      if (verdict === "allow") return;
      if (verdict === "halt") break;
      await delay(2000, undefined, { signal: controller.signal });
    }
    throw new Error("Compute governance closed task execution.");
  };
  const timer = setInterval(() => { void check(); }, 3000);
  timer.unref();
  controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  return {
    wait,
    close: () => clearInterval(timer),
    wrap: (provider: Provider): Provider => ({ ...provider, name: provider.name,
      ...(provider.estimateInputTokens ? { estimateInputTokens: provider.estimateInputTokens.bind(provider) } : {}),
      complete: async request => { await wait(); return provider.complete(request); },
    }),
  };
}
