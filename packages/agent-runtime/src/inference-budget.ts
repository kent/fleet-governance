import { z } from "zod";
import { InferenceBudget as BudgetConfig } from "@fleet/schemas";
import type { CompleteRequest, Provider } from "./providers/types.js";

const Count = z.number().int().nonnegative().safe();
export const InferenceReservation = z.object({
  inputTokens: Count,
  outputTokens: Count,
  costNanodollars: z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict();
export type InferenceReservation = z.infer<typeof InferenceReservation>;
type Purpose = "task" | "vote";
type Charge = { tokens: number; cost: bigint; purpose: Purpose; reservation: InferenceReservation };

function nanodollars(value: number, roundUp: boolean): bigint {
  // Convert the decimal spelling, not a floating-point multiplication that can round an exact
  // allowance up or manufacture a one-nanodollar overrun at the boundary.
  const [mantissa, exponent = "0"] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const shift = 9 + Number(exponent) - fraction.length;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (digits + (roundUp ? divisor - 1n : 0n)) / divisor;
}
const nanoCeil = (value: number): bigint => nanodollars(value, true);
const usd = (nano: bigint): number => Number(nano) / 1e9;

/** Accounting for one run owner. Starts reserve before transport; completions release only
 * reported usage. Unknown and interrupted calls retain their reservations. Money is accumulated
 * in integer nanodollars; each conversion rounds charges up and the configured ceiling down. */
export class InferenceBudgetLedger {
  readonly config: BudgetConfig;
  private tokenLimit: number;
  private readonly dollarLimit: bigint;
  private readonly votingDollars: bigint;
  private readonly votingTokens: number;
  private readonly charges = new Map<string, Charge>();
  private tokens = 0;
  private cost = 0n;
  private taskTokens = 0;
  private taskCost = 0n;
  private breached = false;

  constructor(config: BudgetConfig) {
    this.config = BudgetConfig.parse(config);
    this.tokenLimit = this.config.maxTokens;
    this.dollarLimit = nanodollars(this.config.maxCostUsd, false);
    this.votingDollars = this.config.reservedVoteCostUsd === undefined ? this.dollarLimit / 5n : nanoCeil(this.config.reservedVoteCostUsd);
    this.votingTokens = this.config.reservedVoteTokens ?? Math.floor(this.config.maxTokens / 5);
    if (this.dollarLimit <= 0n || this.votingDollars >= this.dollarLimit) throw new Error("invalid inference dollar allowance");
  }

  /** The current onchain charter can lower this run's operator-approved ceiling. Raising a
   * charter never raises the operator's configured token or dollar allowance. */
  setCharterTokenLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("invalid charter inference budget");
    this.tokenLimit = Math.min(limit, this.config.maxTokens);
  }

  prepare<T>(provider: Provider, model: string, req: CompleteRequest<T>): { request: CompleteRequest<T>; reservation: InferenceReservation } {
    if (!provider.estimateInputTokens) throw new Error("inference_budget_unsupported_provider");
    const price = this.config.prices[model];
    if (!price) throw new Error("inference_budget_missing_price");
    if (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0) throw new Error("invalid_output_limit");
    const maxTokens = Math.min(req.maxTokens, this.config.maxOutputTokensPerCall);
    const inputTokens = provider.estimateInputTokens({ ...req, maxTokens });
    if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0 || inputTokens > this.config.maxInputTokensPerCall) throw new Error("inference_input_limit");
    const numerator = BigInt(inputTokens) * nanoCeil(price.inputUsdPerMillion) + BigInt(maxTokens) * nanoCeil(price.outputUsdPerMillion);
    const costNanodollars = ((numerator + 999_999n) / 1_000_000n).toString();
    return {
      request: { ...req, maxTokens, spending: { inputTokens, ...price } },
      reservation: { inputTokens, outputTokens: maxTokens, costNanodollars },
    };
  }

  refusal(reservation: InferenceReservation, purpose: Purpose): string | null {
    if (this.breached) return "inference_reservation_breached";
    const tokens = reservation.inputTokens + reservation.outputTokens;
    const cost = BigInt(reservation.costNanodollars);
    if (this.tokens + tokens > this.tokenLimit) return "inference_token_limit";
    if (this.cost + cost > this.dollarLimit) return "inference_dollar_limit";
    if (purpose === "task") {
      if (this.taskTokens + tokens > Math.max(0, this.tokenLimit - this.votingTokens)) return "inference_task_token_limit";
      if (this.taskCost + cost > this.dollarLimit - this.votingDollars) return "inference_task_dollar_limit";
    }
    return null;
  }

  start(id: string, purpose: Purpose, reservation: InferenceReservation): void {
    if (this.charges.has(id)) throw new Error("duplicate inference reservation");
    const parsed = InferenceReservation.parse(reservation);
    const tokens = parsed.inputTokens + parsed.outputTokens;
    if (!Number.isSafeInteger(tokens)) throw new Error("invalid inference token reservation");
    const cost = BigInt(parsed.costNanodollars);
    this.charges.set(id, { tokens, cost, purpose, reservation: parsed });
    this.adjust(tokens, cost, purpose);
  }

  complete(id: string, result: { inputTokens?: number | undefined; outputTokens?: number | undefined; costUsd?: number | undefined }): void {
    const charge = this.charges.get(id);
    if (!charge) throw new Error("missing inference reservation");
    const knownTokens = result.inputTokens !== undefined && result.outputTokens !== undefined;
    const tokens = knownTokens ? result.inputTokens! + result.outputTokens! : charge.tokens;
    const cost = result.costUsd === undefined ? charge.cost : nanoCeil(result.costUsd);
    if ((knownTokens && (result.inputTokens! > charge.reservation.inputTokens || result.outputTokens! > charge.reservation.outputTokens)) || cost > BigInt(charge.reservation.costNanodollars)) {
      this.breached = true;
    }
    this.adjust(tokens - charge.tokens, cost - charge.cost, charge.purpose);
    charge.tokens = tokens;
    charge.cost = cost;
  }

  private adjust(tokens: number, cost: bigint, purpose: Purpose): void {
    this.tokens += tokens;
    this.cost += cost;
    if (purpose === "task") { this.taskTokens += tokens; this.taskCost += cost; }
    if (!Number.isSafeInteger(this.tokens) || !Number.isSafeInteger(this.taskTokens)) throw new Error("inference token accounting overflow");
  }

  canStartTask(): boolean {
    return !this.breached && this.tokens < this.tokenLimit && this.cost < this.dollarLimit && this.taskTokens < Math.max(0, this.tokenLimit - this.votingTokens) && this.taskCost < this.dollarLimit - this.votingDollars;
  }

  summary() {
    return {
      maxTokens: this.config.maxTokens, effectiveMaxTokens: this.tokenLimit,
      maxCostUsd: usd(this.dollarLimit), reservedVoteTokens: this.votingTokens, reservedVoteCostUsd: usd(this.votingDollars),
      chargedTokens: this.tokens, chargedCostUsd: usd(this.cost),
      chargedTaskTokens: this.taskTokens, chargedTaskCostUsd: usd(this.taskCost),
      reservationBreached: this.breached,
    };
  }
}
