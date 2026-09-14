/**
 * `HealthPanel`: DAO Node `/v1/progress` lag, CPLS reachability, Agora Next reachability, keeper
 * last action, and signer balances (task 6 controller notes). Duck-typed against
 * `src/lib/health.ts`'s `HealthView` rather than importing it, so this stays a plain
 * presentational component.
 */
export type HealthPanelProps = {
  daoNode: { ok: boolean; lagBlocks: number | null; detail: string };
  cpls: { ok: boolean; detail: string };
  agoraNext: { ok: boolean; detail: string };
  keeperLastAction: string | null;
  signerBalances: readonly { label: string; address: string; balanceWei: string | null; ok: boolean }[];
};

function statusWord(ok: boolean): string {
  return ok ? "ok" : "unreachable";
}

export default function HealthPanel(props: HealthPanelProps) {
  return (
    <section aria-label="Health">
      <h3>Health</h3>
      <ul>
        <li data-status={statusWord(props.daoNode.ok)}>
          <strong>DAO Node:</strong> {statusWord(props.daoNode.ok)}
          {props.daoNode.lagBlocks !== null ? ` (lag ${props.daoNode.lagBlocks} blocks)` : ""}, {props.daoNode.detail}
        </li>
        <li data-status={statusWord(props.cpls.ok)}>
          <strong>CPLS:</strong> {statusWord(props.cpls.ok)}, {props.cpls.detail}
        </li>
        <li data-status={statusWord(props.agoraNext.ok)}>
          <strong>Agora Next:</strong> {statusWord(props.agoraNext.ok)}, {props.agoraNext.detail}
        </li>
        <li>
          <strong>Keeper last action:</strong> {props.keeperLastAction ?? "no keeper activity logged yet"}
        </li>
      </ul>
      <h4>Signer balances</h4>
      <ul>
        {props.signerBalances.map((signer) => (
          <li key={signer.address} data-status={statusWord(signer.ok)}>
            {signer.label} ({signer.address}):{" "}
            {signer.ok && signer.balanceWei !== null ? `${signer.balanceWei} wei` : "could not read balance"}
          </li>
        ))}
      </ul>
    </section>
  );
}
