// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GuardianControls from "./GuardianControls.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installFetchMock() {
  const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, txHash: "0xabc", blockNumber: "42" }) }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("GuardianControls", () => {
  it("disables every action when the guardian key is absent, even with the phrase typed", async () => {
    installFetchMock();
    render(<GuardianControls runId="run-1" guardianKeyPresent={false} />);

    expect(screen.getByRole("alert").textContent).toMatch(/FLEET_GUARDIAN_KEY is not set/);

    const pauseInput = screen.getByLabelText("Confirm pause") as HTMLInputElement;
    expect(pauseInput.disabled).toBe(true);
    await userEvent.type(pauseInput, "pause fleet-run-1");

    const pauseButton = screen.getByRole("button", { name: "pause" }) as HTMLButtonElement;
    expect(pauseButton.disabled).toBe(true);
  });

  it("keeps the submit button disabled until the exact confirmation phrase is typed", async () => {
    installFetchMock();
    render(<GuardianControls runId="run-2" guardianKeyPresent={true} />);

    const pauseInput = screen.getByLabelText("Confirm pause") as HTMLInputElement;
    const pauseButton = screen.getByRole("button", { name: "pause" }) as HTMLButtonElement;
    expect(pauseButton.disabled).toBe(true);

    fireEvent.change(pauseInput, { target: { value: "pause fleet-run-2-wrong" } });
    expect(pauseButton.disabled).toBe(true);

    fireEvent.change(pauseInput, { target: { value: "pause fleet-run-2" } });
    expect(pauseButton.disabled).toBe(false);
  });

  it("posts the action to the guardian route once confirmed, and shows the result", async () => {
    const fetchMock = installFetchMock();
    render(<GuardianControls runId="run-3" guardianKeyPresent={true} />);

    const unpauseInput = screen.getByLabelText("Confirm unpause") as HTMLInputElement;
    fireEvent.change(unpauseInput, { target: { value: "unpause fleet-run-3" } });
    const unpauseButton = screen.getByRole("button", { name: "unpause" }) as HTMLButtonElement;
    expect(unpauseButton.disabled).toBe(false);
    fireEvent.click(unpauseButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-3/guardian", expect.objectContaining({ method: "POST" })));
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ action: "unpause" });

    await waitFor(() => expect(screen.getAllByRole("status")[0]?.textContent).toContain("done"));
  });

  it("requires a proposal id selection before cancel is enabled, even with the phrase confirmed", async () => {
    installFetchMock();
    render(<GuardianControls runId="run-4" guardianKeyPresent={true} cancelableProposalIds={["10", "20"]} />);

    const cancelInput = screen.getByLabelText("Confirm cancel") as HTMLInputElement;
    fireEvent.change(cancelInput, { target: { value: "cancel fleet-run-4" } });
    const cancelButton = screen.getByRole("button", { name: "cancel" }) as HTMLButtonElement;
    // A proposal id is pre-selected (the first option), so confirming the phrase alone enables it.
    expect(cancelButton.disabled).toBe(false);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });
    expect(cancelButton.disabled).toBe(true);
  });
});
