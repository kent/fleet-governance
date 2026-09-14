// Runs only inside the isolated installer. All upstream downloads travel over framed stdio.
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const [registry, ...packages] = process.argv.slice(2);
const pending = new Map(); let nextId = 0;
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  try {
    const reply = JSON.parse(line);
    const waiter = pending.get(reply.id);
    if (!waiter) throw new Error("unknown reply");
    pending.delete(reply.id);
    reply.error ? waiter.reject(new Error(reply.error)) : waiter.resolve(reply);
  } catch { process.exit(1); }
});
input.on("close", () => process.exit(1));
function download(url) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    process.stdout.write(JSON.stringify({ type: "request", id, url }) + "\n");
  });
}

let origin;
const tarballs = new Map();
function rewritePackument(body) {
  const metadata = JSON.parse(body.toString("utf8"));
  for (const version of Object.values(metadata.versions ?? {})) {
    if (typeof version?.dist?.tarball !== "string") continue;
    // Opaque tokens prevent npm from requesting arbitrary localhost endpoints using a URL in
    // metadata. The host still checks the original destination for every tarball download.
    const token = String(tarballs.size + 1);
    tarballs.set(token, version.dist.tarball);
    version.dist.tarball = `${origin}/__fleet_tarball/${token}`;
  }
  return Buffer.from(JSON.stringify(metadata));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" || !req.url?.startsWith("/") || req.url.startsWith("//")) throw new Error("request refused");
    const match = /^\/__fleet_tarball\/(\d+)$/.exec(req.url);
    const url = match ? tarballs.get(match[1]) : new URL(req.url, `https://${registry}`).href;
    if (!url) throw new Error("unknown tarball");
    const reply = await download(url);
    let body = Buffer.from(reply.body, "base64");
    if (!match) body = rewritePackument(body);
    res.writeHead(200, { "content-type": match ? "application/octet-stream" : "application/json" });
    res.end(body);
  } catch {
    res.writeHead(403); res.end("Package request refused by the fleet gateway.");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
await mkdir("/project/node_modules", { recursive: true });
await writeFile("/project/package.json", JSON.stringify({ private: true }));
// npm rejects loading the same file as both user and global configuration.
await writeFile("/tmp/npm-user.conf", "");
await writeFile("/tmp/npm-global.conf", "");
const npm = spawn("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false",
  "--package-lock=false", "--fetch-retries=0", "--fetch-timeout=15000", "--maxsockets=1",
  `--registry=${origin}`, "--", ...packages], {
  cwd: "/project", stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH, HOME: "/tmp/home", npm_config_cache: "/tmp/npm-cache",
    npm_config_userconfig: "/tmp/npm-user.conf", npm_config_globalconfig: "/tmp/npm-global.conf" },
});
npm.stdout.pipe(process.stderr); npm.stderr.pipe(process.stderr);
npm.on("error", () => process.exit(1));
npm.on("close", code => {
  process.stdout.write(JSON.stringify({ type: "done", ok: code === 0 }) + "\n", () => process.exit(code === 0 ? 0 : 1));
});
