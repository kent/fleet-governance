import { describe, expect, it, vi } from "vitest";
import { dockerRunTests, runCommand } from "./docker.js";

describe("runCommand", () => {
  it("captures stdout from a successful command", async () => {
    const result = await runCommand("node", ["-e", "console.log('hello from runCommand')"], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("hello from runCommand");
  });

  it("reports a non-zero exit code without throwing", async () => {
    const result = await runCommand("node", ["-e", "process.exit(7)"], { timeoutMs: 10_000 });
    expect(result.code).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("kills a command that exceeds the timeout and reports timedOut", async () => {
    const result = await runCommand("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  }, 10_000);

  it("never rejects even when the binary does not exist", async () => {
    const result = await runCommand("this-binary-does-not-exist-anywhere", [], { timeoutMs: 5_000 });
    expect(result.code).toBeNull();
    expect(result.output.length).toBeGreaterThan(0);
  });
});

describe("dockerRunTests lifecycle", () => {
  it("removes the same uniquely named container after a timeout", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: null, timedOut: true, output: "" })
      .mockResolvedValueOnce({ code: 0, timedOut: false, output: "" });
    await expect(dockerRunTests("/tmp/workspace", { commandRunner: run })).rejects.toThrow("sandbox_timeout");
    const args = run.mock.calls[0]![1] as string[];
    const name = args[args.indexOf("--name") + 1];
    expect(name).toMatch(/^fleet-tests-/);
    expect(run.mock.calls[1]).toEqual(["docker", ["rm", "--force", name], { timeoutMs: 10_000 }]);
  });

  it("surfaces failed cleanup instead of claiming a completed sandbox run", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, timedOut: false, output: "tests passed" })
      .mockResolvedValueOnce({ code: 1, timedOut: false, output: "daemon unavailable" });
    await expect(dockerRunTests("/tmp/workspace", { commandRunner: run })).rejects.toThrow("sandbox_cleanup_failed");
  });

  it.each([null, 125, 126, 127])("fails closed on Docker exit %s", async (code) => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code, timedOut: false, output: "cannot start" })
      .mockResolvedValueOnce({ code: 1, timedOut: false, output: "No such container" });
    await expect(dockerRunTests("/tmp/workspace", { commandRunner: run })).rejects.toThrow("sandbox_unavailable");
    expect(run.mock.calls.every(([cmd]) => cmd === "docker")).toBe(true);
  });

  it("rejects mount-option injection before starting a subprocess", async () => {
    const run = vi.fn();
    await expect(dockerRunTests('/tmp/work,target=/host', { commandRunner: run })).rejects.toThrow("sandbox_invalid_workspace_path");
    expect(run).not.toHaveBeenCalled();
  });
});
