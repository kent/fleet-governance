// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import HealthPanel from "./HealthPanel.js";
import type { HealthPanelProps } from "./HealthPanel.js";

afterEach(() => cleanup());

function props(overrides: Partial<HealthPanelProps> = {}): HealthPanelProps {
  return {
    daoNode: { ok: true, lagBlocks: 2, detail: "reports block 98, chain head 100" },
    cpls: { ok: true, detail: "http://localhost:8001/health -> HTTP 200" },
    agoraNext: { ok: false, detail: "not configured (display.agoraNextBaseUrl unset)" },
    keeperLastAction: "keeper recorded decision 3",
    signerBalances: [{ label: "guardian", address: "0xabc", balanceWei: "1000000000000000000", ok: true }],
    ...overrides,
  };
}

describe("HealthPanel", () => {
  it("renders lag, reachability, keeper action, and signer balances", () => {
    render(<HealthPanel {...props()} />);
    expect(screen.getByText(/lag 2 blocks/)).toBeTruthy();
    expect(screen.getByText(/keeper recorded decision 3/)).toBeTruthy();
    expect(screen.getByText(/1000000000000000000 wei/)).toBeTruthy();
  });

  it("falls back to a placeholder when the keeper has logged nothing yet", () => {
    render(<HealthPanel {...props({ keeperLastAction: null })} />);
    expect(screen.getByText(/no keeper activity logged yet/)).toBeTruthy();
  });

  it("shows a balance could not be read when the signer probe failed", () => {
    render(<HealthPanel {...props({ signerBalances: [{ label: "keeper", address: "0xdef", balanceWei: null, ok: false }] })} />);
    expect(screen.getByText(/could not read balance/)).toBeTruthy();
  });
});
