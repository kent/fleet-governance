import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerRunTests, runCommand } from "./docker.js";

describe.skipIf(process.env.FLEET_INTEGRATION !== "1")("real test sandbox containment", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-containment-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node probe.cjs" } }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("executes ordinary task code and reports its failure accurately", async () => {
    await writeFile(join(dir, "probe.cjs"), "console.log('ordinary task passed')");
    expect(await dockerRunTests(dir)).toMatchObject({ passed: true, output: expect.stringContaining("ordinary task passed") });
    await writeFile(join(dir, "probe.cjs"), "process.exit(1)");
    expect(await dockerRunTests(dir)).toMatchObject({ passed: false });
  }, 30_000);

  it("cannot contact a host endpoint, alter the workspace, or read host credentials", async () => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end("canary"); });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    const previousCanary = process.env.FLEET_SANDBOX_CANARY;
    process.env.FLEET_SANDBOX_CANARY = "test-only-host-secret";
    try {
      // Positive control: the endpoint is listening and reachable outside the sandbox.
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("canary");
      requests = 0;
      await writeFile(join(dir, "protected-test.cjs"), "original test");
      await writeFile(join(dir, "probe.cjs"), `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const os = require('node:os');
        assert.equal(process.env.FLEET_SANDBOX_CANARY, undefined);
        assert.equal(process.env.FLEET_DEPLOYER_KEY, undefined);
        assert.equal(process.env.OPENROUTER_API_KEY, undefined);
        assert.notEqual(process.getuid(), 0);
        assert.equal(fs.existsSync('/var/run/docker.sock'), false);
        assert(Object.values(os.networkInterfaces()).flat().every(i => i.internal));
        assert.throws(() => fs.writeFileSync('/work/protected-test.cjs', 'tampered'));
        assert.throws(() => fs.writeFileSync('/work/host-executed', 'yes'));
        assert.throws(() => fs.writeFileSync('/root/escaped', 'yes'));
        fs.writeFileSync('/tmp/scratch', 'temporary writes work');
        fetch('http://host.docker.internal:${port}/outside-charter', { signal: AbortSignal.timeout(1500) })
          .then(() => { throw new Error('network bypass succeeded'); }, () => console.log('containment verified'));
      `);
      expect(await dockerRunTests(dir)).toMatchObject({ passed: true, output: expect.stringContaining("containment verified") });
      expect(requests).toBe(0);
      expect(await readFile(join(dir, "protected-test.cjs"), "utf8")).toBe("original test");
      await expect(access(join(dir, "host-executed"))).rejects.toThrow();
    } finally {
      if (previousCanary === undefined) delete process.env.FLEET_SANDBOX_CANARY;
      else process.env.FLEET_SANDBOX_CANARY = previousCanary;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  }, 30_000);

  it("removes the real container when its process exceeds the deadline", async () => {
    await writeFile(join(dir, "probe.cjs"), "console.log('test process started'); setInterval(() => {}, 1000)");
    let containerName: string | undefined;
    let testOutput = "";
    await expect(dockerRunTests(dir, {
      timeoutMs: 10_000,
      commandRunner: async (cmd, args, opts) => {
        if (args[0] === "run") containerName = args[args.indexOf("--name") + 1];
        const result = await runCommand(cmd, args, opts);
        if (args[0] === "run") testOutput = result.output;
        return result;
      },
    })).rejects.toThrow("sandbox_timeout");
    expect(containerName).toBeDefined();
    expect(testOutput).toContain("test process started");
    const inspection = await runCommand("docker", ["inspect", containerName!], { timeoutMs: 10_000 });
    expect(inspection.code).not.toBe(0);
    expect(inspection.output).toMatch(/no such object/i);
  }, 30_000);
});
