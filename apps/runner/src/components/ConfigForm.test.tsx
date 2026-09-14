// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConfigForm from "./ConfigForm.js";

const DEFAULT_FIXTURES = {
  fixtures: [
    { name: "hf-replay", kind: "model", description: "Model-driven replay of the Hugging Face temptation." },
    { name: "legit-amendment", kind: "scripted", description: "Scripted benign amendment." },
  ],
};

const DEFAULT_ENV_VARS = {
  vars: [
    { name: "FLEET_DEPLOYER_KEY", present: true },
    { name: "FLEET_OPERATOR_KEY", present: false },
    { name: "FLEET_GUARDIAN_KEY", present: true },
    { name: "FLEET_KEEPER_KEY", present: true },
    { name: "FLEET_AGENT_KEY_0", present: true },
    { name: "FLEET_AGENT_KEY_1", present: true },
    { name: "FLEET_AGENT_KEY_2", present: true },
    { name: "FLEET_AGENT_KEY_3", present: true },
    { name: "FLEET_AGENT_KEY_4", present: true },
  ],
};

function fakeResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

function installFetchMock() {
  const fn = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith("/api/fixtures")) return fakeResponse(DEFAULT_FIXTURES);
    if (url.startsWith("/api/env")) return fakeResponse(DEFAULT_ENV_VARS);
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ConfigForm", () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the seven spec 12.1 sections", async () => {
    render(<ConfigForm />);
    for (const name of ["Target", "Fleet", "Governance", "Task", "Scenario", "Capture", "Display"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
  });

  it("shows the effective yes count for the default fleet and updates it when N changes", async () => {
    render(<ConfigForm />);
    expect(await screen.findByText(/effective yes count: 3 of 5/)).toBeTruthy();

    const roleInputsBefore = screen.getAllByLabelText(/^role$/i);
    expect(roleInputsBefore).toHaveLength(5);

    const fleetSizeInput = screen.getByLabelText(/fleet size/i);
    fireEvent.change(fleetSizeInput, { target: { value: "6" } });

    const roleInputsAfter = screen.getAllByLabelText(/^role$/i);
    expect(roleInputsAfter).toHaveLength(6);
    expect(await screen.findByText(/effective yes count: 4 of 6/)).toBeTruthy();
  });

  it("shows an inline error and disables Run for an invalid RPC URL", async () => {
    render(<ConfigForm />);
    const runButton = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);

    const rpcInput = screen.getByLabelText(/rpc http url/i);
    await userEvent.clear(rpcInput);
    await userEvent.type(rpcInput, "not-a-url");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(runButton.disabled).toBe(true);
  });

  it("shows key names and presence markers, never values", async () => {
    render(<ConfigForm />);
    expect(await screen.findByText(/FLEET_DEPLOYER_KEY/)).toBeTruthy();
    expect(screen.getByText(/FLEET_OPERATOR_KEY/).textContent).toMatch(/missing/);
    expect(screen.getByText(/FLEET_DEPLOYER_KEY/).textContent).toMatch(/present/);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/0x[0-9a-fA-F]{66}/);
    expect(bodyText).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("flips the scripted toggle off when a model fixture is selected", async () => {
    render(<ConfigForm />);
    const scriptedCheckbox = screen.getByLabelText(/scripted agents/i) as HTMLInputElement;
    const fixtureSelect = await screen.findByLabelText(/scenario fixture/i);

    await userEvent.selectOptions(fixtureSelect, "legit-amendment");
    expect(scriptedCheckbox.checked).toBe(true);

    await userEvent.selectOptions(fixtureSelect, "hf-replay");
    expect(scriptedCheckbox.checked).toBe(false);
  });
});
