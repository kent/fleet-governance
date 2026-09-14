// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ExecutionPanel from "./ExecutionPanel.js";

afterEach(cleanup);
it("distinguishes a saved chain snapshot and unused permission from a publication", () => {
  render(<ExecutionPanel execution={{ source: "record", blockNumber: "10", blockHash: "0xabc", events: [],
    artifacts: [{ taskId: "1", digest: "0x000", revision: "0" }] }} />);
  expect(screen.getByText(/Saved chain capture at block 10/)).toBeTruthy();
  expect(screen.getByText(/No resource execution/)).toBeTruthy();
  expect(screen.getByRole("cell", { name: "0" })).toBeTruthy();
});

it("shows the chain transaction that published the artifact", () => {
  render(<ExecutionPanel execution={{ source: "chain", blockNumber: "11", blockHash: "0xabc",
    events: [{ type: "ArtifactPublished", txHash: "0xdef", blockHash: "0xabc", blockNumber: "11", logIndex: 0 }],
    artifacts: [{ taskId: "1", digest: "0x123", revision: "1" }] }} />);
  expect(screen.getByText(/Read from the chain at block 11/)).toBeTruthy();
  expect(screen.getByRole("listitem").textContent).toContain("ArtifactPublished at block 11, transaction 0xdef");
});
