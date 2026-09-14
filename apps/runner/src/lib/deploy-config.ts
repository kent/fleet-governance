import { privateKeyToAccount } from "viem/accounts";
import { DeployConfigV1 } from "@fleet/schemas";
import type { DeployConfigV1 as DeployConfigV1Type, ExperimentConfigV1 as ExperimentConfigV1Type } from "@fleet/schemas";
import { resolveRunKey, roleKeySpecs } from "../pipeline/run-keys.js";
import type { RunKeyOptions } from "../pipeline/run-keys.js";

/**
 * Builds the `fleet.deploy.v1` document `run-pipeline.ts`'s `DEPLOYED` stage reads from
 * `deployments/configs/<experiment.name>.deploy.json` (controller notes item 5), deriving every
 * address from the environment's private keys rather than carrying key material in the file
 * itself. Throws `RunnerEnvError` (name only, never a value) if a key is missing or malformed;
 * callers must have already checked presence with `findMissingEnvVar` for a clearer error, but
 * this also re-validates format (the 0x + 64 hex pattern), which presence-only checks do not.
 *
 * `keyOpts` carries the chain id the RPC reported, so the members and the operator and guardian
 * addresses this config names are the same accounts `fleet run` will actually sign with, including
 * the local-Anvil fallback. A deploy config that registered one set of addresses while the run
 * signed with another would produce a fleet whose every agent is unregistered.
 */
export function buildDeployConfig(
  experiment: ExperimentConfigV1Type,
  env: NodeJS.ProcessEnv,
  keyOpts: RunKeyOptions = {},
): DeployConfigV1Type {
  const specs = roleKeySpecs(experiment.fleet.members.length);
  const specFor = (variable: string): (typeof specs)[number] => {
    const spec = specs.find((s) => s.variable === variable);
    if (!spec) throw new Error(`buildDeployConfig: no key spec for ${variable}`);
    return spec;
  };
  const operatorKey = resolveRunKey(env, specFor("FLEET_OPERATOR_KEY"), keyOpts);
  const guardianKey = resolveRunKey(env, specFor("FLEET_GUARDIAN_KEY"), keyOpts);
  const members = experiment.fleet.members.map(
    (_, i) => privateKeyToAccount(resolveRunKey(env, specFor(`FLEET_AGENT_KEY_${i}`), keyOpts)).address,
  );
  const agentManifests = experiment.fleet.members.map((member) =>
    JSON.stringify({
      role: member.role,
      provider: member.provider,
      model: member.model,
      promptVersion: member.promptVersion,
      operator: member.operatorLabel,
    }),
  );
  const fleetManifest = JSON.stringify({
    experiment: experiment.name,
    constitution: "fleet.constitution.v1",
    harness: "runner-ui",
  });

  const candidate = {
    schema: "fleet.deploy.v1" as const,
    tokenName: experiment.fleet.tokenName,
    tokenSymbol: experiment.fleet.tokenSymbol,
    members,
    agentManifests,
    fleetManifest,
    operator: privateKeyToAccount(operatorKey).address,
    guardian: privateKeyToAccount(guardianKey).address,
    votingDelay: experiment.governance.votingDelay,
    votingPeriod: experiment.governance.votingPeriod,
    proposalThreshold: experiment.governance.proposalThreshold,
    quorumNumerator: experiment.governance.quorumNumerator,
    timelockDelay: experiment.governance.timelockDelay,
    maxTaskLifetime: experiment.governance.maxTaskLifetime,
  };
  return DeployConfigV1.parse(candidate);
}
