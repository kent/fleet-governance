import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CharterV1 } from "@fleet/schemas";
import { TaskState } from "@fleet/sdk";
import { LedgerWatcher } from "@fleet/gateway";
import type { GatewayLogRecord } from "@fleet/gateway";
import { Workspace } from "./workspace.js";
import { ToolRouter } from "./tools.js";
import { DockerPackageInstaller } from "./package-installer.js";
import { runCommand } from "./docker.js";

describe.skipIf(process.env.FLEET_INTEGRATION !== "1")("isolated npm installation with gateway downloads", () => {
  let dir: string;
  let router: ToolRouter;
  let installer: DockerPackageInstaller;
  let requests: string[];
  let logs: GatewayLogRecord[];
  let bytes: Buffer;
  let target = "registry.example";
  let paused: boolean;
  let approved: Set<string>;
  let charter: CharterV1;
  let workspace: Workspace;
  let getResponse: (url: string) => Promise<Response>;
  let server: ReturnType<typeof createServer> | undefined;
  let previousCanary: string | undefined;
  const tool = { class: "package_install" as const, target: "registry.example", args: { pkg: "fleet-fixture@1.0.0" } };

  beforeEach(async () => {
    previousCanary = process.env.FLEET_INSTALLER_HOST_CANARY;
    process.env.FLEET_INSTALLER_HOST_CANARY = "host-only-integration-canary";
    dir = await mkdtemp(join(tmpdir(), "fleet-npm-"));
    await mkdir(join(dir, "package")); await mkdir(join(dir, "workspace"));
    await writeFile(join(dir, "package/package.json"), JSON.stringify({ name: "fleet-fixture", version: "1.0.0", main: "index.cjs",
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('/project/lifecycle-ran','bad')\"" } }));
    await writeFile(join(dir, "package/index.cjs"), "module.exports = 42;\n");
    execFileSync("tar", ["-czf", join(dir, "fixture.tgz"), "-C", dir, "package"]);
    bytes = await readFile(join(dir, "fixture.tgz"));
    await writeFile(join(dir, "workspace/package.json"), JSON.stringify({ scripts: { test: "node probe.cjs" } }));
    await writeFile(join(dir, "workspace/probe.cjs"), `
      const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os');
      assert.equal(require('fleet-fixture'),42);
      assert.equal(process.env.OPENROUTER_API_KEY,undefined);
      assert.equal(process.env.FLEET_INSTALLER_HOST_CANARY,undefined);
      assert.notEqual(process.getuid(),0);
      assert(Object.values(os.networkInterfaces()).flat().every(i=>i.internal));
      assert.throws(()=>fs.writeFileSync('/work/node_modules/fleet-fixture/index.cjs','tampered'));
      assert.throws(()=>fs.writeFileSync('/work/package.json','tampered'));
      console.log('isolated dependency works');
    `);
    // An agent-controlled npmrc must never configure the installer or disclose host secrets.
    await writeFile(join(dir, "workspace/.npmrc"), "registry=https://outside.example\nignore-scripts=false\n");
    workspace = await Workspace.fromFixture(join(dir, "workspace"), 0, join(dir, "copies"));
    requests = []; logs = []; target = "registry.example"; paused = false; approved = new Set();
    charter = { schema: "fleet.charter.v1", goal: "Install and test a dependency", allowedActionClasses: ["package_install", "network_fetch", "run_tests"],
      forbiddenActions: [], externalAllowlist: ["registry.example"], budget: { toolCalls: 100, inferenceTokens: 10000 }, stopConditions: [] };
    getResponse = async url => {
      requests.push(url);
      if (url === "https://registry.example/fleet-fixture") return Response.json({ name: "fleet-fixture", "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: "fleet-fixture", version: "1.0.0", dist: { tarball: `https://${target}/fixture.tgz`,
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } } } });
      return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
    };
    const watcher = new LedgerWatcher({ getTask: async () => ({ id: 1n, operator: `0x${"11".repeat(20)}`, createdAt: 1n,
      expiresAt: 100000n, state: TaskState.Open, charterVersion: 1, charterHash: `0x${"22".repeat(32)}`,
      charterText: JSON.stringify(charter), charter, decisionCount: 0, openEscalations: 0 }),
      isPaused: async () => paused, blockNumber: async () => 1n, timestamp: async () => 2n,
      exceptionVersion: async (_, hash) => approved.has(hash) ? 1 : 0, escalationVersion: async () => 0 }, 1n);
    installer = new DockerPackageInstaller(30000);
    router = new ToolRouter({ workspace, watcher, agentId: 0, budget: { toolCalls: 0 }, log: r => logs.push(r),
      packageInstaller: installer, fetchImpl: (async (url) => getResponse(String(url))) as typeof fetch });
  });

  afterEach(async () => {
    if (previousCanary === undefined) delete process.env.FLEET_INSTALLER_HOST_CANARY;
    else process.env.FLEET_INSTALLER_HOST_CANARY = previousCanary;
    await router?.close();
    if (installer) {
      for (const command of [["ps", "-aq"], ["volume", "ls", "-q"]]) {
        const remaining = await runCommand("docker", [...command, "--filter", `label=fleet-installer-owner=${installer.id}`], { timeoutMs: 10000 });
        expect(remaining.code, remaining.output).toBe(0);
        expect(remaining.output.trim(), "installer left an owned Docker resource").toBe("");
      }
    }
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    await rm(dir, { recursive: true, force: true });
  });

  it("installs and imports a real tarball while scripts, host configuration and writable test mounts stay unavailable", async () => {
    expect(process.env.FLEET_INSTALLER_HOST_CANARY).toBe("host-only-integration-canary");
    const result = await router.call(tool);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(requests).toEqual(["https://registry.example/fleet-fixture", "https://registry.example/fixture.tgz"]);
    expect(logs.filter(log => log.descriptor.class === "network_fetch")).toHaveLength(2);
    const volume = installer.volume!;
    const inspect = await runCommand("docker", ["run", "--rm", "--network", "none", "--read-only",
      "--mount", `type=volume,source=${volume},target=/inspect,readonly`, "node:22-alpine", "node", "-e",
      "if(require('fs').existsSync('/inspect/lifecycle-ran'))process.exit(1)"], { timeoutMs: 10000 });
    expect(inspect.code, inspect.output).toBe(0);
    expect(await router.call({ class: "run_tests", target: "npm test", args: {} })).toMatchObject({ ok: true,
      output: expect.stringContaining('"passed":true') });
    await router.close();
    expect((await runCommand("docker", ["volume", "inspect", volume], { timeoutMs: 10000 })).code).not.toBe(0);
  }, 60000);

  it("holds a tarball on another host, then allows the exact download only after its recorded permission", async () => {
    target = "outside.example";
    const result = await router.call(tool);
    expect(result).toMatchObject({ ok: false, blocked: { reason: "target_not_allowlisted" },
      blockedTool: { class: "network_fetch", target: "outside.example", args: { path: "/fixture.tgz", scheme: "https" } } });
    expect(requests).toEqual(["https://registry.example/fleet-fixture"]);
    expect(installer.volume).toBeUndefined();
    if (result.ok || !("blocked" in result)) throw new Error("missing block");
    approved.add(result.blocked.payloadHash);
    expect(await router.call(tool)).toMatchObject({ ok: true });
    expect(requests).toContain("https://outside.example/fixture.tgz");
  }, 60000);

  it("checks and installs transitive registry dependencies through the same broker", async () => {
    await writeFile(join(dir, "package/package.json"), JSON.stringify({ name: "fleet-child", version: "1.0.0", main: "index.cjs" }));
    execFileSync("tar", ["-czf", join(dir, "child.tgz"), "-C", dir, "package"]);
    const child = await readFile(join(dir, "child.tgz"));
    const old = getResponse;
    getResponse = async url => {
      if (url === "https://registry.example/fleet-child") {
        requests.push(url);
        return Response.json({ name: "fleet-child", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {
          name: "fleet-child", version: "1.0.0", dist: { tarball: "https://registry.example/child.tgz",
            integrity: `sha512-${createHash("sha512").update(child).digest("base64")}` } } } });
      }
      if (url === "https://registry.example/child.tgz") { requests.push(url); return new Response(child); }
      const response = await old(url);
      if (url.endsWith("/fleet-fixture")) {
        const metadata = await response.json();
        metadata.versions["1.0.0"].dependencies = { "fleet-child": "1.0.0" };
        return Response.json(metadata);
      }
      return response;
    };
    const result = await router.call(tool);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(new Set(requests)).toEqual(new Set(["https://registry.example/fleet-fixture", "https://registry.example/fixture.tgz",
      "https://registry.example/fleet-child", "https://registry.example/child.tgz"]));
    expect(logs.filter(log => log.descriptor.class === "network_fetch")).toHaveLength(4);
    await workspace.writeFile("probe.cjs", "require('node:assert/strict').equal(require('fleet-child'),42)");
    expect(await router.call({ class: "run_tests", target: "npm test", args: {} })).toMatchObject({ ok: true,
      output: expect.stringContaining('"passed":true') });
  }, 60000);

  it("rechecks the ledger after metadata, and preserves installed dependencies when a later install fails", async () => {
    expect(await router.call(tool)).toMatchObject({ ok: true });
    const before = installer.volume;
    const old = getResponse;
    requests = [];
    getResponse = async url => { const response = await old(url); paused = true; return response; };
    expect(await router.call(tool)).toMatchObject({ ok: false, blocked: { reason: "paused", draft: null } });
    expect(requests).toEqual(["https://registry.example/fleet-fixture"]);
    expect(installer.volume).toBe(before);
  }, 60000);

  it("refuses redirects without contacting their destination", async () => {
    getResponse = async url => { requests.push(url); return new Response(null, { status: 302, headers: { location: "https://outside.example/private" } }); };
    expect(await router.call(tool)).toMatchObject({ ok: false, error: "package_redirect_refused" });
    expect(requests).toEqual(["https://registry.example/fleet-fixture"]);
    expect(installer.volume).toBeUndefined();
  }, 30000);

  it("cannot fetch a direct URL dependency outside the broker from inside npm", async () => {
    server = createServer((_req, res) => { requests.push("direct bypass"); res.end("unexpected"); });
    await new Promise<void>(resolve => server!.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    expect((await fetch(`http://127.0.0.1:${port}`)).ok).toBe(true); requests = [];
    const old = getResponse;
    getResponse = async url => {
      const response = await old(url);
      if (url.endsWith("/fleet-fixture")) {
        const metadata = await response.json();
        metadata.versions["1.0.0"].dependencies = { bypass: `http://host.docker.internal:${port}/bypass.tgz` };
        return Response.json(metadata);
      }
      return response;
    };
    expect(await router.call(tool)).toMatchObject({ ok: false, error: expect.stringContaining("package_install_failed") });
    expect(requests).not.toContain("direct bypass");
    expect(installer.volume).toBeUndefined();
  }, 60000);

  it("cancels a running install and removes its owned containers and candidate volume", async () => {
    const abort = new AbortController(); let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    getResponse = async () => { started(); return new Response(new ReadableStream({ start() {} })); };
    const result = router.call(tool, abort.signal);
    await dispatched; abort.abort();
    expect(await result).toMatchObject({ ok: false, error: "package_install_aborted" });
    expect(installer.volume).toBeUndefined();
  }, 30000);

  it("terminates an installer at its deadline and removes its Docker resources", async () => {
    await router.close();
    installer = new DockerPackageInstaller(2000);
    await expect(installer.install(tool.target, tool.args.pkg, async (_url, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      throw new Error("unreachable");
    })).rejects.toThrow("package_install_timeout");
    expect(installer.volume).toBeUndefined();
  }, 30000);
});
