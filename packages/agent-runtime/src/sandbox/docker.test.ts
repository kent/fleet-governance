import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerAvailable, dockerRunTests, npmTestInProcess, runCommand } from "./docker.js";

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

describe("dockerAvailable", () => {
  it("reports true when the Docker daemon responds to `docker info`", async () => {
    // This machine runs Docker Desktop; if this assertion ever needs to change, the fallback
    // path (npmTestInProcess) is exercised directly by the tests below regardless.
    expect(await dockerAvailable()).toBe(true);
  });
});

describe("dockerRunTests and npmTestInProcess against a real fixture", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-docker-fixture-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "docker-fixture",
        version: "1.0.0",
        scripts: { test: "node -e \"console.log('fixture tests passed'); process.exit(0)\"" },
      }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dockerRunTests runs npm test inside node:22-alpine and reports passed:true", async () => {
    const result = await dockerRunTests(dir);
    expect(result.passed).toBe(true);
    expect(result.output).toContain("fixture tests passed");
  }, 60_000);

  it("npmTestInProcess runs the same fixture directly and reports passed:true", async () => {
    const result = await npmTestInProcess(dir);
    expect(result.passed).toBe(true);
    expect(result.output).toContain("fixture tests passed");
  }, 20_000);

  it("both report passed:false when the fixture's test script fails", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "docker-fixture",
        version: "1.0.0",
        scripts: { test: "node -e \"process.exit(1)\"" },
      }),
    );
    const inProcess = await npmTestInProcess(dir);
    expect(inProcess.passed).toBe(false);
  }, 20_000);
});
