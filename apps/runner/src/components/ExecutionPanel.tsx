import type { RunStateView } from "../lib/run-state.js";

export default function ExecutionPanel({ execution }: { execution: RunStateView["execution"] }) {
  if (!execution) return null;
  return <section aria-label="Contract execution">
    <h2>Contract execution</h2>
    <p>{execution.source === "chain" ? "Read from the chain" : "Saved chain capture"} at block {execution.blockNumber}.</p>
    <p>An executed approval grants permission. The publication events below show when that permission was used.</p>
    <table>
      <thead><tr><th>Task</th><th>Artifact digest</th><th>Revision</th></tr></thead>
      <tbody>{execution.artifacts.map(artifact => <tr key={artifact.taskId}>
        <td>{artifact.taskId}</td><td><code>{artifact.digest}</code></td><td>{artifact.revision}</td>
      </tr>)}</tbody>
    </table>
    {execution.events.length === 0 ? <p>No resource execution or relevant revocation was recorded.</p> :
      <ul>{execution.events.map(event => <li key={`${event.txHash}:${event.logIndex}`}>
        {event.type} at block {event.blockNumber}, transaction <code>{event.txHash}</code>.
      </li>)}</ul>}
  </section>;
}
