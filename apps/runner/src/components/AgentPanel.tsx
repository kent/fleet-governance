import type { GatewayLogLineType, StepLineType } from "../pipeline/runfiles.js";

/**
 * `AgentPanel`: role, provider, model, last step, last gateway block reason, job state (task 6
 * controller notes). A step's `why` is the agent's own text and is labeled as such, separate from
 * the gateway's verdict and the job pipeline's onchain-adjacent state.
 */
export type AgentPanelProps = {
  agentId: number;
  address: string | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  lastStep: StepLineType | null;
  lastGatewayDecision: GatewayLogLineType | null;
  jobState: string;
};

const UNKNOWN = "unknown";

export default function AgentPanel(props: AgentPanelProps) {
  return (
    <article data-agent-id={props.agentId}>
      <h3>Agent {props.agentId}</h3>
      <p>
        <strong>Address:</strong> {props.address ?? UNKNOWN}
      </p>
      <p>
        <strong>Role:</strong> {props.role ?? UNKNOWN} · <strong>Provider:</strong> {props.provider ?? UNKNOWN} ·{" "}
        <strong>Model:</strong> {props.model ?? UNKNOWN} · <strong>Prompt version:</strong> {props.promptVersion ?? UNKNOWN}
      </p>
      <p>
        <strong>Job state:</strong> {props.jobState}
      </p>

      <section aria-label="Last step">
        <h4>Last step</h4>
        {props.lastStep ? (
          <div>
            <p>
              <strong>Onchain-adjacent tool call:</strong> {props.lastStep.tool.class} {props.lastStep.tool.target} (at{" "}
              {props.lastStep.at})
            </p>
            <p>
              <strong>Agent-authored text (why):</strong> {props.lastStep.why}
            </p>
          </div>
        ) : (
          <p>no step yet</p>
        )}
      </section>

      <section aria-label="Last gateway decision">
        <h4>Last gateway decision</h4>
        {props.lastGatewayDecision ? (
          <div>
            <p>
              <strong>Verdict:</strong> {props.lastGatewayDecision.verdict} for {props.lastGatewayDecision.descriptor.class}{" "}
              {props.lastGatewayDecision.descriptor.target} (at {props.lastGatewayDecision.ts})
            </p>
            {props.lastGatewayDecision.reason && (
              <p>
                <strong>Reason:</strong> {props.lastGatewayDecision.reason}
              </p>
            )}
            {props.lastGatewayDecision.basis && (
              <p>
                <strong>Basis:</strong> {props.lastGatewayDecision.basis}
              </p>
            )}
          </div>
        ) : (
          <p>no gateway decision yet</p>
        )}
      </section>
    </article>
  );
}
