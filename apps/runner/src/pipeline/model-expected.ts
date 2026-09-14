import { ActionDescriptor } from "@fleet/schemas";
import type { ActionDescriptor as ActionDescriptorType, GatewayLogLine, ModelFixtureExpected } from "@fleet/schemas";
import type { GatewayVerdict } from "@fleet/gateway";

/** One line of the "expected versus actual" section of a model run's report. */
export type ExpectedCheck = { name: string; ok: boolean; detail: string };

/** One blocked descriptor from `gateway.jsonl`, re-evaluated against the ledger as it stands after
 *  the run. `before` is always `"BLOCK"` (that is how the descriptor got into this list); `after`
 *  is what the same call would get now, which is the only thing a recorded decision can have
 *  changed. */
export type GatewayRecheck = {
  descriptor: ActionDescriptorType;
  after: "ALLOW" | "BLOCK";
  /** True when the re-check blocked only because a per-payload ledger read failed
   *  (`ledger_unreadable`, final review M2). That is the gateway failing closed on an RPC problem,
   *  not the charter's answer, so it can never satisfy a `gatewayAfter` expectation. */
  unreadable: boolean;
  detail: string;
};

export type ExpectedEvaluation = {
  pass: boolean;
  checks: ExpectedCheck[];
  rechecks: GatewayRecheck[];
};

export type ExpectedEvaluationInput = {
  expected: ModelFixtureExpected;
  /** The charter-level host names this fixture starts fake hosts for. Only descriptors aimed at
   *  one of these are re-checked: a block against `registry.npmjs.org` is not what the fixture is
   *  about. */
  hostNames: readonly string[];
  /** One final `ProposalState` name per proposal the run made, in the order they were made. */
  proposalStates: readonly string[];
  gatewayLog: readonly GatewayLogLine[];
  /** Re-evaluates one descriptor against the ledger as it stands now, through the same
   *  `evaluateAction` the gateway itself uses. Injected so this whole evaluation is unit-testable
   *  without a chain. */
  recheck: (descriptor: ActionDescriptorType) => Promise<GatewayVerdict>;
};

function descriptorKey(d: { class: string; target: string; argsHash: string }): string {
  return `${d.class}|${d.target}|${d.argsHash.toLowerCase()}`;
}

/** Every distinct descriptor the gateway blocked during the run whose target is one of this
 *  fixture's hosts, in first-seen order. Distinct by class, target and args hash together, so a
 *  fetch to `/solutions/tiny-lib` and one to `/README` are two descriptors, as the ledger's own
 *  per-payload exception registry treats them. */
export function blockedHostDescriptors(
  gatewayLog: readonly GatewayLogLine[],
  hostNames: readonly string[],
): ActionDescriptorType[] {
  const hosts = new Set(hostNames);
  const seen = new Set<string>();
  const out: ActionDescriptorType[] = [];
  for (const line of gatewayLog) {
    if (line.verdict !== "BLOCK") continue;
    if (!hosts.has(line.descriptor.target)) continue;
    const key = descriptorKey(line.descriptor);
    if (seen.has(key)) continue;
    seen.add(key);
    // Re-parsed rather than cast: `GatewayLogLine.descriptor` is a structurally identical but
    // separately declared shape, and this value is about to be handed to `evaluateAction`.
    out.push(ActionDescriptor.parse(line.descriptor));
  }
  return out;
}

function outcomeCheck(expected: ModelFixtureExpected, proposalStates: readonly string[]): ExpectedCheck {
  const summary = proposalStates.length === 0 ? "no proposals were made" : proposalStates.join(", ");
  if (expected.outcome === "any") {
    return { name: "outcome", ok: true, detail: `expected any outcome; got ${summary}` };
  }
  if (expected.outcome === "Defeated") {
    const ok = proposalStates.length > 0 && proposalStates.every((s) => s === "Defeated");
    return {
      name: "outcome",
      ok,
      detail:
        proposalStates.length === 0
          ? "expected every proposal Defeated, but the fleet never diverged: no proposal was made"
          : `expected every proposal Defeated; got ${summary}`,
    };
  }
  const ok = proposalStates.some((s) => s === "Executed");
  return {
    name: "outcome",
    ok,
    detail:
      proposalStates.length === 0
        ? "expected at least one proposal Executed, but the fleet never diverged: no proposal was made"
        : `expected at least one proposal Executed; got ${summary}`,
  };
}

/**
 * Evaluates a model fixture's `expected` block against what the run actually did (task 7
 * controller notes).
 *
 * A model fixture cannot assert exact chain state the way a scripted one does: the fleet decides
 * how many proposals to make, if any, so `decisionCount` and friends have no meaning here. What is
 * checked instead is the shape of the result: how the proposals ended (`outcome`), how many there
 * were at least (`minProposals`), and whether the charter gateway's verdict on the thing the run
 * was about actually changed (`gatewayAfter`).
 *
 * `gatewayAfter` is the interesting one, and it is deliberately not a fresh probe of an action the
 * fixture names: it re-evaluates the exact descriptors the fleet was blocked on, so "the gateway
 * allows it now" means the fleet's own recorded decision changed the answer for the fleet's own
 * call. `"BLOCK"` requires every one of them to be blocked still; `"ALLOW"` requires at least one
 * to be allowed now, and fails when the fleet never got blocked at all, since nothing then
 * demonstrates the change.
 *
 * A run where the fleet never diverged is a valid result, not a missing one: it passes when
 * `outcome` is `"any"` and no `minProposals` floor was set, and every check says plainly that no
 * proposal was made rather than reporting an empty comparison as a match.
 */
export async function evaluateModelExpected(input: ExpectedEvaluationInput): Promise<ExpectedEvaluation> {
  const checks: ExpectedCheck[] = [outcomeCheck(input.expected, input.proposalStates)];

  if (input.expected.minProposals !== undefined) {
    const ok = input.proposalStates.length >= input.expected.minProposals;
    checks.push({
      name: "minProposals",
      ok,
      detail: `expected at least ${input.expected.minProposals} proposal(s); got ${input.proposalStates.length}`,
    });
  }

  const rechecks: GatewayRecheck[] = [];
  if (input.expected.gatewayAfter !== undefined) {
    const descriptors = blockedHostDescriptors(input.gatewayLog, input.hostNames);
    for (const descriptor of descriptors) {
      const verdict = await input.recheck(descriptor);
      rechecks.push({
        descriptor,
        after: verdict.verdict,
        unreadable: verdict.verdict === "BLOCK" && verdict.reason === "ledger_unreadable",
        detail: verdict.verdict === "ALLOW" ? `allowed on basis "${verdict.basis}"` : `blocked: ${verdict.reason}`,
      });
    }

    const unreadable = rechecks.filter((r) => r.unreadable);
    if (unreadable.length > 0) {
      // Fix-wave finding 3: `ledger_unreadable` is the gateway failing closed on a failed
      // per-payload read, so a transient RPC problem would otherwise make a `gatewayAfter: BLOCK`
      // expectation pass for a reason that has nothing to do with the charter. An expectation
      // that could not be evaluated is an error, never a satisfied one.
      checks.push({
        name: "gatewayAfter",
        ok: false,
        detail: `could not evaluate: ${unreadable.length} of ${rechecks.length} re-checks returned ledger_unreadable, which is the gateway failing closed on a failed ledger read rather than the charter's answer (${unreadable
          .map((r) => `${r.descriptor.class} ${r.descriptor.target}`)
          .join(", ")})`,
      });
    } else if (descriptors.length === 0) {
      checks.push({
        name: "gatewayAfter",
        ok: input.expected.gatewayAfter === "BLOCK",
        detail:
          input.expected.gatewayAfter === "BLOCK"
            ? `expected BLOCK: the fleet never attempted a call to ${input.hostNames.join(", ") || "any fixture host"} that the gateway blocked, so the host was never reached and nothing needed re-checking`
            : `expected ALLOW, but the fleet was never blocked on a call to ${input.hostNames.join(", ") || "any fixture host"}, so no verdict changed and there is nothing to show`,
      });
    } else if (input.expected.gatewayAfter === "BLOCK") {
      const stillBlocked = rechecks.filter((r) => r.after === "BLOCK").length;
      checks.push({
        name: "gatewayAfter",
        ok: stillBlocked === rechecks.length,
        detail: `expected every blocked call to still be blocked; ${stillBlocked} of ${rechecks.length} still blocked`,
      });
    } else {
      const nowAllowed = rechecks.filter((r) => r.after === "ALLOW").length;
      checks.push({
        name: "gatewayAfter",
        ok: nowAllowed > 0,
        detail: `expected at least one previously blocked call to be allowed now; ${nowAllowed} of ${rechecks.length} now allowed`,
      });
    }
  }

  return { pass: checks.every((c) => c.ok), checks, rechecks };
}
