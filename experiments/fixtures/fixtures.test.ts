import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ModelFixtureV1, parseFixtureFile } from "../../packages/schemas/src/index.js";

// `experiments/` is not a workspace package (task 4 controller notes), so the schema is imported
// by relative path rather than through the `@fleet/schemas` package specifier: that keeps this
// directory out of pnpm-lock.yaml and every workspace package.json entirely.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const SCRIPTED_DIR = path.join(REPO_ROOT, "experiments/fixtures/scripted");
const MODEL_DIR = path.join(REPO_ROOT, "experiments/fixtures/model");
const HOSTS_SITES_DIR = path.join(REPO_ROOT, "experiments/fixtures/hosts/examples-internal/sites");
const TINY_LIB_DIR = path.join(REPO_ROOT, "experiments/fixtures/repos/tiny-lib");
const TINY_LIB_SOLUTION = path.join(
  REPO_ROOT,
  "experiments/fixtures/hosts/examples-internal/sites/solutions/solutions/tiny-lib",
);
const HOST_SERVER_DIR = path.join(REPO_ROOT, "experiments/fixtures/hosts/examples-internal");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function jsonFilesIn(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

const scriptedFiles = jsonFilesIn(SCRIPTED_DIR);
const modelFiles = jsonFilesIn(MODEL_DIR);

describe("scripted fixtures (fleet.fixture.v1)", () => {
  it("finds the eight scripted fixtures", () => {
    expect(scriptedFiles.length).toBe(8);
  });

  for (const file of scriptedFiles) {
    it(`${file} parses via parseFixtureFile`, () => {
      const parsed = parseFixtureFile(readJson(path.join(SCRIPTED_DIR, file)));
      expect(parsed.schema).toBe("fleet.fixture.v1");
    });
  }
});

describe("model fixtures (fleet.fixture.model.v1)", () => {
  it("finds the five model fixtures", () => {
    expect(modelFiles.length).toBe(5);
  });

  for (const file of modelFiles) {
    it(`${file} parses via parseFixtureFile`, () => {
      const parsed = parseFixtureFile(readJson(path.join(MODEL_DIR, file)));
      expect(parsed.schema).toBe("fleet.fixture.model.v1");
      expect(parsed.agentsScripted).toBe(false);
      expect(parsed.trigger).toBeNull();
    });
  }
});

describe("model fixtures reference real files", () => {
  for (const file of modelFiles) {
    const fixture = ModelFixtureV1.parse(readJson(path.join(MODEL_DIR, file)));

    it(`${file}: charter "${fixture.charter}" exists`, () => {
      expect(fs.existsSync(path.join(REPO_ROOT, fixture.charter))).toBe(true);
    });

    it(`${file}: repoFixture "${fixture.repoFixture}" exists`, () => {
      expect(fs.existsSync(path.join(REPO_ROOT, fixture.repoFixture))).toBe(true);
    });

    if (fixture.repoOverlay) {
      it(`${file}: repoOverlay "${fixture.repoOverlay}" exists`, () => {
        expect(fs.existsSync(path.join(REPO_ROOT, fixture.repoOverlay as string))).toBe(true);
      });
    }

    for (const host of fixture.hosts) {
      it(`${file}: host site "${host.site}" (for ${host.name}) exists`, () => {
        expect(fs.existsSync(path.join(HOSTS_SITES_DIR, host.site))).toBe(true);
      });
    }
  }
});

/** Recursively copies a directory (there is no dependency on a `cp -R` binary or fs.cp's newer
 *  recursive flag semantics, so this is spelled out plainly). */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

describe("tiny-lib repository fixture", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails node --test before the solution is applied, passes after", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-lib-"));
    tempDirs.push(tmp);
    copyDir(TINY_LIB_DIR, tmp);

    // Deviation from the brief's `"node --test test/"` package.json script: a bare directory
    // passed as a positional CLI argument is not glob-expanded by Node's test runner (verified
    // against both this machine's node and the node:22-alpine image Task 1's `run_tests` handler
    // actually runs; `node --test test/` crashes with MODULE_NOT_FOUND unconditionally, before
    // and after any fix to src/index.js). `node --test` with no path argument, run with `cwd` set
    // to the package root, uses Node's own default discovery of `test/` and works correctly; the
    // fixture's package.json is written that way, and this test spawns node the same way. See
    // the task 4 report for detail.
    const before = spawnSync(process.execPath, ["--test"], { cwd: tmp, encoding: "utf8" });
    expect(before.status).not.toBe(0);

    fs.copyFileSync(TINY_LIB_SOLUTION, path.join(tmp, "src", "index.js"));

    const after = spawnSync(process.execPath, ["--test"], { cwd: tmp, encoding: "utf8" });
    expect(after.status).toBe(0);
  });
});

type HostHandle = { child: ReturnType<typeof spawn>; port: number };

/** Starts `server.mjs` with the given CLI args and resolves once its first stderr line reports
 *  the bound port (`listening <port>`), shared by every test in the "examples-internal fake
 *  host" describe block below. */
async function startHost(args: string[]): Promise<HostHandle> {
  const child = spawn(process.execPath, ["server.mjs", ...args], {
    cwd: HOST_SERVER_DIR,
    stdio: ["ignore", "ignore", "pipe"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const firstLine = buffer.slice(0, newlineIndex);
      child.stderr?.off("data", onData);
      const match = /^listening (\d+)$/.exec(firstLine);
      if (match && match[1]) {
        resolve(Number(match[1]));
      } else {
        reject(new Error(`examples-internal host: unexpected first stderr line: ${firstLine}`));
      }
    };
    child.stderr?.on("data", onData);
    child.once("error", reject);
  });

  return { child, port };
}

async function stopHost(handle: HostHandle): Promise<void> {
  handle.child.kill("SIGTERM");
  await new Promise((resolve) => handle.child.once("exit", resolve));
}

describe("examples-internal fake host", () => {
  it("serves /solutions/tiny-lib with 200 and /nope with 404", async () => {
    const host = await startHost(["--site", "solutions", "--port", "0"]);
    try {
      const ok = await fetch(`http://127.0.0.1:${host.port}/solutions/tiny-lib`);
      expect(ok.status).toBe(200);

      const missing = await fetch(`http://127.0.0.1:${host.port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await stopHost(host);
    }
  });

  // Fix round 1: resolveSitePath's decodeURIComponent threw URIError on malformed
  // percent-encoding outside any try/catch, so a single bad request (curl reproduced it with
  // "/%") killed the whole host process with an unhandled rejection. The fix moves the decode
  // inside the request handler's try block, answers 404 for a decode failure the same as any
  // other unresolvable path, and adds process-level unhandledRejection/uncaughtException guards
  // as a last resort. This test asserts both the 404s and that the process is still alive and
  // serving normally afterward, not just that the two malformed requests happen not to crash it.
  it("survives malformed percent-encoding instead of crashing", async () => {
    const host = await startHost(["--site", "solutions", "--port", "0"]);
    try {
      const bad1 = await fetch(`http://127.0.0.1:${host.port}/%`);
      expect(bad1.status).toBe(404);

      const bad2 = await fetch(`http://127.0.0.1:${host.port}/%zz`);
      expect(bad2.status).toBe(404);

      expect(host.child.exitCode).toBeNull();

      const ok = await fetch(`http://127.0.0.1:${host.port}/solutions/tiny-lib`);
      expect(ok.status).toBe(200);
    } finally {
      await stopHost(host);
    }
  });
});
