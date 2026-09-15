import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEMO_DEFAULT_GOAL } from "../lib/demo-config.js";
import { ACTIVE, RUN_ID, controlDeps, queueDemo, runPath, type DemoRun } from "./control.js";
import { BUCKET, googleRequest, readObject } from "./google.js";
import { readComputeAllocation, readComputeState, readComputeEvidence } from "./compute-store.js";

import { queueSimulation, readSimulationRequest, readSimulationWork, simulationPath } from "./simulation.js";

const root = process.cwd();
const users = new Set(["accounts.google.com:operator2@example.com", "accounts.google.com:fleet-provisioner@fleet-governance.iam.gserviceaccount.com"]);
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > 100_000) throw new Error("Request is too large."); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://control");
    if (url.pathname === "/healthz") { json(response, 200, { ok: true }); return; }
    if (!users.has(String(request.headers["x-goog-authenticated-user-email"]))) { json(response, 403, { error: "Sign in through Google IAP with an authorised account." }); return; }
    if (request.method === "POST" && request.headers.origin !== `https://${request.headers.host}`) { json(response, 403, { error: "Request origin did not match this application." }); return; }
    if (url.pathname === "/api/compute-policy" && request.method === "GET") {
      const allocation = await readComputeAllocation();
      const state = allocation ? await readComputeState(allocation.allocationId) : null;
      const [vm, evidence] = await Promise.all([
        googleRequest("compute", "compute/v1/projects/fleet-governance/zones/us-central1-a/instances/fleet-research").then(async r => await r.json() as { id: string; status: string; machineType: string }),
        readComputeEvidence(),
      ]);
      const simulation = await readSimulationRequest();
      const simulationStatus = simulation ? await readObject(simulationPath(simulation.runId)) : null;
      const simulationWork = simulation ? await readSimulationWork(simulation.runId) : null;
      json(response, 200, { simulation, simulationStatus, simulationWork, allocation, state: state?.value ?? null, vm: { id: vm.id, status: vm.status, machineType: vm.machineType.split("/").pop() }, evidence, observedAt: new Date().toISOString() }); return;
    }
    if (url.pathname === "/api/simulations" && request.method === "POST") {
      json(response, 202, await queueSimulation(String(request.headers["idempotency-key"] ?? ""))); return;
    }
    if (url.pathname === "/api/worker/start" && request.method === "POST") {
      await controlDeps().start();
      json(response, 202, { message: "Worker is starting or already running. Open Agora in a moment." }); return;
    }
    if (url.pathname === "/api/experiments" && request.method === "POST") {
      const id = String(request.headers["idempotency-key"] ?? "");
      json(response, 202, await queueDemo(await body(request), id)); return;
    }
    if (url.pathname === "/api/experiments" && request.method === "GET") {
      const listing = await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o?prefix=demo%2Fruns%2F&matchGlob=**%2Frequest.json&maxResults=1000`)).json() as { items?: { name: string }[] };
      const requests = await Promise.all((listing.items ?? []).map(item => readObject<DemoRun>(item.name)));
      json(response, 200, { runs: requests.filter(item => item !== null).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt)).slice(0, 50), active: await readObject(ACTIVE) }); return;
    }
    const match = /^\/api\/experiments\/(run-[0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === "GET" && match && RUN_ID.test(match[1]!)) {
      const id = match[1]!;
      const [run, status] = await Promise.all([readObject(runPath(id, "request.json")), readObject(runPath(id, "status.json"))]);
      json(response, run ? 200 : 404, { run, status }); return;
    }
    const evidence = /^\/api\/experiments\/(run-[0-9a-f-]+)\/evidence$/.exec(url.pathname);
    if (request.method === "GET" && evidence && RUN_ID.test(evidence[1]!)) {
      const value = await readObject(runPath(evidence[1]!, "evidence.json"));
      response.setHeader("content-disposition", `attachment; filename="${evidence[1]}-evidence.json"`);
      json(response, value ? 200 : 404, value ?? { error: "Evidence is saved when this run finishes." }); return;
    }
    if (url.pathname === "/api/experiment-defaults") {
      json(response, 200, { agentCount: 5, maxAgents: 25, goal: DEMO_DEFAULT_GOAL, constitution: readFileSync(path.join(root, "experiments/constitutions/fleet-v1.md"), "utf8") }); return;
    }
    if (url.pathname === "/constitution") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
      response.end(readFileSync(path.join(root, "experiments/constitutions/fleet-v1.md"))); return;
    }
    if (url.pathname === "/experiments" || /^\/experiments\/run-[0-9a-f-]+$/.test(url.pathname)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" });
      response.end(readFileSync(path.join(root, "apps/runner/public/experiment.html"))); return;
    }
    if (url.pathname === "/compute") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" });
      response.end(readFileSync(path.join(root, "apps/runner/public/compute.html"))); return;
    }
    if (["/experiment.js", "/experiment.css", "/compute.js", "/compute.css"].includes(url.pathname)) {
      response.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css", "x-content-type-options": "nosniff" });
      response.end(readFileSync(path.join(root, "apps/runner/public", url.pathname.slice(1)))); return;
    }
    if (url.pathname === "/") { response.writeHead(302, { location: "/experiments" }); response.end(); return; }
    // Agora stays a real Agora application. Only fixed internal destinations are proxied.
    const upstream = process.env.FLEET_AGORA_HOST;
    if (!upstream || !/^10\.42\.0\.[0-9]{1,3}$/.test(upstream)) { json(response, 503, { error: "Agora is not ready yet. The experiment launcher is available at /experiments." }); return; }
    const headers = { ...request.headers, host: request.headers.host, "x-forwarded-proto": "https" };
    delete headers.authorization;
    const proxy = httpRequest({ hostname: upstream, port: 3000, path: request.url, method: request.method, headers, timeout: 20_000 }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    proxy.on("timeout", () => proxy.destroy());
    proxy.on("error", () => { if (!response.headersSent) json(response, 503, { error: "Agora is starting or the worker is stopped. Open /experiments for progress." }); else response.end(); });
    request.pipe(proxy);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    json(response, 400, { error: /https?:|alch_|sk-|Bearer/.test(message) ? "Request failed. Check the private worker logs." : message });
  }
}).listen(Number(process.env.PORT ?? "8080"), "0.0.0.0", () => console.log("Fleet experiment control ready."));
