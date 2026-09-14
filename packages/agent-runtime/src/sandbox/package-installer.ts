import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runCommand } from "./docker.js";
import type { PackageFetch } from "./package-broker.js";

export type PackageInstaller = {
  volume: string | undefined;
  install(registry: string, pkg: string, fetchPackage: PackageFetch, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
};

const isolation = ["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--pids-limit", "128", "--memory", "512m", "--cpus", "1"];
const image = "node:22-alpine";

async function checked(args: string[]): Promise<void> {
  const result = await runCommand("docker", args, { timeoutMs: 10_000 });
  if (result.code !== 0 || result.timedOut) throw new Error(`package_container_setup_failed: ${result.output}`);
}

async function removeContainer(name: string): Promise<void> {
  const result = await runCommand("docker", ["rm", "--force", name], { timeoutMs: 10_000 });
  if (result.timedOut || (result.code !== 0 && !/no such container/i.test(result.output))) {
    throw new Error(`package_container_cleanup_failed: ${name}`);
  }
}

/** Packages never touch the host workspace. Every successful install creates a replacement
 * volume; failed or canceled installs leave the previous dependencies intact. */
export class DockerPackageInstaller implements PackageInstaller {
  readonly id = randomUUID();
  volume: string | undefined;
  private registry: string | undefined;
  private readonly packages = new Set<string>();
  private busy = false;
  constructor(private readonly timeoutMs = 120_000) {}

  async install(registry: string, pkg: string, fetchPackage: PackageFetch, signal?: AbortSignal): Promise<string> {
    if (this.busy) throw new Error("package_installer_busy");
    if (this.registry && this.registry !== registry) throw new Error("package_registry_change_requires_new_workspace");
    signal?.throwIfAborted();
    this.busy = true;
    const suffix = randomUUID(); const name = `fleet-installer-${suffix}`; const volume = `fleet-deps-${suffix}`;
    const init = `${name}-init`;
    const script = fileURLToPath(new URL("./installer-client.mjs", import.meta.url));
    let retained = false; let created = false;
    try {
      if (/[\r\n,"]/.test(script)) throw new Error("package_installer_invalid_script_path");
      const ownership = ["--label", `fleet-installer-owner=${this.id}`];
      await checked(["volume", "create", "--label", "fleet-governance=dependencies", ...ownership, volume]);
      created = true;
      // Only this fixed ownership operation uses uid 0; it runs no package or workspace code.
      try {
        await checked(["run", "--name", init, "--pull", "never", ...ownership, ...isolation, "--cap-add", "CHOWN",
          "--mount", `type=volume,source=${volume},target=/deps`, image, "chown", "65534:65534", "/deps"]);
      } finally { await removeContainer(init); }
      const requested = [...new Set([...this.packages, pkg])];
      // Explicit removal owns cleanup. Combining --rm with CLI cancellation races Docker's
      // automatic removal and can leave a still-referenced candidate volume behind.
      const args = ["run", "--name", name, "--pull", "never", "--interactive", ...ownership, ...isolation,
        "--user", "65534:65534", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
        "--mount", `type=bind,source=${script},target=/installer.mjs,readonly`,
        "--mount", `type=volume,source=${volume},target=/project`,
        image, "node", "/installer.mjs", registry, ...requested];
      const output = await runInstaller(args, fetchPackage, this.timeoutMs, signal);
      await removeContainer(name);
      if (this.volume) await checked(["volume", "rm", this.volume]);
      this.volume = volume; this.registry = registry; this.packages.add(pkg); retained = true;
      return JSON.stringify({ installed: requested, scripts: "disabled", network: "gateway only", output });
    } finally {
      try { await removeContainer(name); }
      finally {
        try { if (!retained && created) await checked(["volume", "rm", volume]); }
        finally { this.busy = false; }
      }
    }
  }

  async close(): Promise<void> {
    if (this.busy) throw new Error("package_installer_still_running");
    if (this.volume) { await checked(["volume", "rm", this.volume]); this.volume = undefined; }
  }
}

/** Treat the container's protocol as untrusted: bounded messages, one request at a time, no
 * delegated HTTP headers or methods, and no execution authority in any message. */
function runInstaller(args: string[], fetchPackage: PackageFetch, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let failure: unknown; let output = ""; let buffer = ""; let inFlight = false; let done = false;
    let requests = 0; let bytes = 0; const ids = new Set<number>();
    const fail = (error: unknown): void => {
      if (failure) return;
      failure = error; controller.abort(); child.kill("SIGKILL");
    };
    const abort = (): void => fail(new Error("package_install_aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => fail(new Error("package_install_timeout")), timeoutMs);
    child.stderr.on("data", chunk => { if (output.length < 65536) output += chunk.toString().slice(0, 65536 - output.length); });
    const receive = async (line: string): Promise<void> => {
      try {
        const message = JSON.parse(line);
        if (message.type === "done" && typeof message.ok === "boolean" && !inFlight) { done = message.ok; return; }
        if (message.type !== "request" || !Number.isSafeInteger(message.id) || message.id < 1 || ids.has(message.id)
          || typeof message.url !== "string" || inFlight || done || ++requests > 256) throw new Error("package_protocol_refused");
        ids.add(message.id); inFlight = true;
        const response = await fetchPackage(message.url, controller.signal);
        bytes += response.body.length;
        if (bytes > 64 * 1024 * 1024) throw new Error("package_install_download_budget");
        controller.signal.throwIfAborted();
        const reply = JSON.stringify({ id: message.id, body: Buffer.from(response.body).toString("base64"), contentType: response.contentType });
        inFlight = false;
        child.stdin.write(reply + "\n", error => { if (error) fail(error); });
      } catch (error) { fail(error); }
    };
    child.stdout.on("data", chunk => {
      if (failure) return;
      buffer += chunk.toString();
      if (buffer.length > 16384) { fail(new Error("package_protocol_message_too_large")); return; }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        void receive(line);
      }
    });
    child.stdin.on("error", error => fail(error));
    child.on("error", error => fail(error));
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort();
      if (failure) reject(failure);
      else if (code !== 0 || !done || inFlight || buffer) reject(new Error(`package_install_failed: ${output}`));
      else resolve(output);
    });
  });
}
