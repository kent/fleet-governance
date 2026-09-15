import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const children = [spawn(process.execPath, [path.join(root, "apps/runner/node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3100"], { cwd: path.join(root, "apps/runner"), stdio: "inherit" })];
if (process.env.FLEET_WORKER_ENABLED === "1") {
  for (const script of ["archive-proxy", "worker"]) children.push(spawn(process.execPath, [`apps/runner/dist/cloud/${script}.js`], { cwd: root, stdio: "inherit" }));
}
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
};
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
for (const child of children) { child.on("error", () => stop(1)); child.on("exit", code => stop(code ?? 1)); }
