import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InferenceBudget } from "@fleet/schemas";
import { InferenceBudgetLedger, InferenceReservation } from "./inference-budget.js";
import type { CompleteRequest, CompleteResult, Provider, Usage } from "./providers/types.js";

const Count = z.number().int().nonnegative().safe();
export const InferenceEvent = z.object({
  type: z.enum(["started", "completed", "denied"]),
  id: z.string().min(1),
  at: z.string().min(1),
  agentId: Count,
  provider: z.enum(["scripted", "openrouter", "claude-cli"]),
  model: z.string(),
  purpose: z.enum(["task", "vote"]),
  queueMs: Count,
  latencyMs: Count.optional(),
  outcome: z.string().optional(),
  inputTokens: Count.optional(),
  outputTokens: Count.optional(),
  costUsd: z.number().finite().nonnegative().optional(),
  reservation: InferenceReservation.optional(),
}).strict();
export type InferenceEvent = z.infer<typeof InferenceEvent>;
type Identity = Pick<InferenceEvent, "agentId" | "provider" | "model" | "purpose">;
type Ticket = { identity: Identity; id: string; queuedAt: number; timer: NodeJS.Timeout; reservation?: InferenceReservation; start: () => void; deny: (reason: string) => void };

/** One queue for every task step, objection, vote and schema-repair call in a run. The start
 * journal is written before dispatch. Replaying it preserves the call ceiling across restarts;
 * a start without completion stays charged and its usage remains unknown. Optional token and
 * dollar reservations share this journal and preserve a separate allocation for voting. */
export class InferenceScheduler {
  private readonly events: InferenceEvent[];
  private readonly pending: Ticket[] = [];
  private active = 0;
  private taskActive = 0;
  private started = 0;
  private taskStarted = 0;
  private readonly reservedVoteCalls: number;
  private peak = 0;
  private closed = false;
  private idle: (() => void)[] = [];
  private readonly budget: InferenceBudgetLedger | undefined;
  private pumping = false;
  private pumpAgain = false;

  constructor(private readonly opts: {
    concurrency: number;
    reservedVoteSlots: number;
    maxCalls: number;
    reservedVoteCalls?: number | undefined;
    budget?: InferenceBudget | undefined;
    /** Read the current charter immediately before admission, after queueing. */
    charterTokenLimit?: () => Promise<number>;
    history?: readonly InferenceEvent[];
    journal: (event: InferenceEvent) => void;
  }) {
    if (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 256) throw new Error("inference concurrency must be 1..256");
    if (!Number.isSafeInteger(opts.reservedVoteSlots) || opts.reservedVoteSlots < 0 || opts.reservedVoteSlots >= opts.concurrency) throw new Error("invalid reserved voting slots");
    if (!Number.isSafeInteger(opts.maxCalls) || opts.maxCalls < 1) throw new Error("inference maxCalls must be positive");
    this.reservedVoteCalls = opts.reservedVoteCalls ?? Math.floor(opts.maxCalls / 5);
    if (!Number.isSafeInteger(this.reservedVoteCalls) || this.reservedVoteCalls < 0 || this.reservedVoteCalls >= opts.maxCalls) throw new Error("invalid reserved voting calls");
    this.budget = opts.budget ? new InferenceBudgetLedger(opts.budget) : undefined;
    this.events = (opts.history ?? []).map(event => InferenceEvent.parse(event));
    const starts = new Map<string, InferenceEvent>();
    const finishes = new Set<string>();
    for (const event of this.events) {
      if (event.type === "started") {
        if (starts.has(event.id)) throw new Error("duplicate inference start");
        starts.set(event.id, event);
        this.started++;
        if (event.purpose === "task") this.taskStarted++;
        if (this.budget) {
          if (!event.reservation) throw new Error("historical inference has no budget reservation; reconcile it before resuming with a budget");
          this.budget.start(event.id, event.purpose, event.reservation);
        }
      } else if (event.type === "completed") {
        const start = starts.get(event.id);
        if (!start || finishes.has(event.id) || start.agentId !== event.agentId || start.purpose !== event.purpose || start.provider !== event.provider || start.model !== event.model) throw new Error("unmatched inference completion");
        finishes.add(event.id);
        this.budget?.complete(event.id, event);
      }
    }
  }

  wrap(provider: Provider, identity: Omit<Identity, "provider">, signal?: AbortSignal): Provider {
    return { name: provider.name, complete: <T>(req: CompleteRequest<T>) => this.complete(provider, { ...identity, provider: provider.name }, req, signal) };
  }

  private emit(event: InferenceEvent): void {
    this.opts.journal(event);
    this.events.push(event);
  }

  private complete<T>(provider: Provider, identity: Identity, req: CompleteRequest<T>, signal?: AbortSignal): Promise<CompleteResult<T>> {
    const queuedAt = Date.now();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const deny = (reason: string) => {
        signal?.removeEventListener("abort", abort);
        try {
          this.emit({ type: "denied", id, at: new Date().toISOString(), ...identity, queueMs: Date.now() - queuedAt, outcome: reason });
          resolve({ ok: false, error: reason === "queue_timeout" ? "timeout" : "provider", raw: reason, latencyMs: Date.now() - queuedAt });
        } catch (error) { this.closed = true; reject(error); }
      };
      const abort = () => {
        const index = this.pending.findIndex(ticket => ticket.id === id);
        if (index >= 0) {
          const [ticket] = this.pending.splice(index, 1);
          clearTimeout(ticket!.timer);
          deny("inference_aborted");
        }
      };
      if (this.closed) return deny("inference_closed");
      if (signal?.aborted) return deny("inference_aborted");
      if (this.pending.length >= 4096) return deny("inference_queue_full");
      if (!Number.isSafeInteger(req.timeoutMs) || req.timeoutMs <= 0) return deny("invalid_timeout");
      let reservation: InferenceReservation | undefined;
      if (this.budget) {
        try {
          const prepared = this.budget.prepare(provider, identity.model, req);
          req = prepared.request;
          reservation = prepared.reservation;
        } catch (error) { return deny(error instanceof Error ? error.message : "inference_budget_prepare_failed"); }
      }
      const timer = setTimeout(() => {
        const index = this.pending.findIndex(ticket => ticket.id === id);
        if (index >= 0) { this.pending.splice(index, 1); deny("queue_timeout"); }
      }, req.timeoutMs);
      const start = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const queueMs = Date.now() - queuedAt;
        if (queueMs >= req.timeoutMs) return deny("queue_timeout");
        try {
          // A broken journal must prevent the paid call, not merely lose its accounting.
          this.emit({ type: "started", id, at: new Date().toISOString(), ...identity, queueMs, ...(reservation ? { reservation } : {}) });
          if (reservation) this.budget!.start(id, identity.purpose, reservation);
        } catch (error) { this.closed = true; reject(error); return; }
        this.started++;
        if (identity.purpose === "task") this.taskStarted++;
        this.active++;
        if (identity.purpose === "task") this.taskActive++;
        this.peak = Math.max(this.peak, this.active);
        void (async () => {
          let result: CompleteResult<T>;
          const sentAt = Date.now();
          try { result = await provider.complete({ ...req, timeoutMs: Math.min(60_000, req.timeoutMs - queueMs) }); }
          catch { result = { ok: false, error: "provider", raw: "provider threw", latencyMs: Date.now() - sentAt }; }
          try {
            const usage = knownUsage(result.usage);
            const completion: InferenceEvent = { type: "completed", id, at: new Date().toISOString(), ...identity, queueMs, latencyMs: Date.now() - sentAt,
              outcome: result.ok ? "ok" : result.error, ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
              ...(result.usage?.costUsd !== undefined && Number.isFinite(result.usage.costUsd) && result.usage.costUsd >= 0 ? { costUsd: result.usage.costUsd } : {}),
            };
            this.emit(completion);
            this.budget?.complete(id, completion);
            resolve(result);
          } catch (error) { this.closed = true; reject(error); }
          finally {
            this.active--;
            if (identity.purpose === "task") this.taskActive--;
            void this.pump();
            if (this.active === 0) this.idle.splice(0).forEach(done => done());
          }
        })();
      };
      this.pending.push({ identity, id, queuedAt, timer, start, deny, ...(reservation ? { reservation } : {}) });
      signal?.addEventListener("abort", abort, { once: true });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
    while (this.pending.length) {
      if (this.closed || this.started >= this.opts.maxCalls) {
        for (const ticket of this.pending.splice(0)) {
          clearTimeout(ticket.timer);
          ticket.deny(this.closed ? "inference_closed" : "inference_call_limit");
        }
        return;
      }
      if (this.active >= this.opts.concurrency) return;
      // Votes take the next free slot; task work cannot occupy the reserved voting capacity.
      let index = this.pending.findIndex(ticket => ticket.identity.purpose === "vote");
      if (index < 0) {
        if (this.taskStarted >= this.opts.maxCalls - this.reservedVoteCalls) {
          for (const ticket of this.pending.splice(0)) {
            clearTimeout(ticket.timer);
            ticket.deny("inference_task_call_limit");
          }
          return;
        }
        if (this.taskActive >= this.opts.concurrency - this.opts.reservedVoteSlots) return;
        index = 0;
      }
      const ticket = this.pending[index]!;
      if (this.budget && ticket.reservation) {
        if (this.opts.charterTokenLimit) {
          try { this.budget.setCharterTokenLimit(await this.opts.charterTokenLimit()); }
          catch {
            const current = this.pending.indexOf(ticket);
            if (current >= 0) {
              this.pending.splice(current, 1);
              clearTimeout(ticket.timer);
              ticket.deny("inference_charter_unavailable");
            }
            continue;
          }
          // Cancellation, shutdown and queue expiry can happen during the ledger read.
          if (this.closed || !this.pending.includes(ticket)) continue;
        }
        const refusal = this.budget.refusal(ticket.reservation, ticket.identity.purpose);
        if (refusal) {
          // A completion may release unused tokens or dollars. Keep the original deadline while
          // waiting; do not reject affordable work just because another call holds a reservation.
          if (this.active > 0 && refusal !== "inference_reservation_breached") return;
          this.pending.splice(this.pending.indexOf(ticket), 1);
          clearTimeout(ticket.timer);
          ticket.deny(refusal);
          continue;
        }
      }
      this.pending.splice(this.pending.indexOf(ticket), 1);
      ticket.start();
    }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) { this.pumpAgain = false; void this.pump(); }
      if (this.active === 0 && this.pending.length === 0) this.idle.splice(0).forEach(done => done());
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pump();
    if (this.active || this.pumping || this.pending.length) await new Promise<void>(resolve => this.idle.push(resolve));
  }

  canStartTask(): boolean {
    return !this.closed && this.started < this.opts.maxCalls && this.taskStarted < this.opts.maxCalls - this.reservedVoteCalls && (this.active > 0 || !this.budget || this.budget.canStartTask());
  }

  summary() {
    const completed = this.events.filter(event => event.type === "completed");
    const knownTokens = completed.filter(event => event.inputTokens !== undefined && event.outputTokens !== undefined);
    return {
      scope: "all_provider_completions" as const,
      callsStarted: this.started, callsCompleted: completed.length,
      callsDenied: this.events.filter(event => event.type === "denied").length,
      inputTokens: knownTokens.reduce((sum, event) => sum + event.inputTokens!, 0),
      outputTokens: knownTokens.reduce((sum, event) => sum + event.outputTokens!, 0),
      unknownUsageCalls: this.started - knownTokens.length,
      reportedCostUsd: completed.reduce((sum, event) => sum + (event.costUsd ?? 0), 0),
      unknownCostCalls: this.started - completed.filter(event => event.costUsd !== undefined).length,
      peakConcurrency: this.peak, maxConcurrency: this.opts.concurrency, maxCalls: this.opts.maxCalls, reservedVoteCalls: this.reservedVoteCalls,
      ...(this.budget ? { budget: this.budget.summary() } : {}),
    };
  }
}

function knownUsage(usage?: Usage): Usage | null {
  return usage && usage.known !== false && usage.model !== "unknown" && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 ? usage : null;
}
export type InferenceSummary = ReturnType<InferenceScheduler["summary"]>;
