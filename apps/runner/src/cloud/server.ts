import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { experimentDefaults } from "./experiment-settings.js";
import { experimentRecord, experimentIndex } from "./experiment-records.js";
import { RUN_ID, controlDeps, runPath } from "./control.js";
import { readObject } from "./google.js";
import { readComputeObject } from "./compute-store.js";
import { checkMcpConnection } from "./mcp-connection.js";
import { issueOperatorToken, listOperatorTokens, revokeOperatorToken } from "./operator-tokens.js";
import { createExperimentDraft, runExperimentDraft } from "./experiment-drafts.js";
import { operatorIdentity } from "./operators.js";


import { siteAccess, authorisedRequest, publicProxyPath, publicSnapshot } from "./site-access.js";
import { readProposalDocument } from "./proposal-view.js";
import { simulationHistory, simulationProposal, cachedSimulationSnapshot } from "./simulation-view.js";

const root = process.cwd();
const access = siteAccess(process.env.FLEET_SITE_ACCESS);
const operatorUrl = process.env.FLEET_OPERATOR_URL ?? "";
if (!/^https:\/\/fleet-governance-control-[a-z0-9.-]+\.run\.app$/.test(operatorUrl)) throw new Error("Invalid operator service URL.");
function page(name: string) {
  return readFileSync(path.join(root, "apps/runner/public", name), "utf8")
    .replace("{{ACCESS}}", access).replace("{{OPERATOR_URL}}", operatorUrl);
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(access === "public" ? publicSnapshot(body) : body));
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
    if (!authorisedRequest(access, request.method ?? "", request.headers)) {
      json(response, 403, { error: "Starting or changing a run requires the operator controls.", operatorUrl }); return;
    }
    if (request.method === "HEAD") request.method = "GET";
    if (url.pathname === "/api/mcp-tokens" && access === "operator") {
      const operator = operatorIdentity(request.headers)!;
      if (request.method === "GET") { json(response, 200, { tokens: await listOperatorTokens(operator) }); return; }
      if (request.method === "POST") { json(response, 201, await issueOperatorToken(operator, await body(request))); return; }
    }
    if (url.pathname === "/api/mcp-check" && access === "operator" && request.method === "POST") {
      json(response, 200, await checkMcpConnection(operatorIdentity(request.headers)!, await body(request))); return;
    }
    const tokenMatch = /^\/api\/mcp-tokens\/([a-f0-9]{64})$/.exec(url.pathname);
    if (tokenMatch && access === "operator" && request.method === "DELETE") {
      await revokeOperatorToken(operatorIdentity(request.headers)!, tokenMatch[1]!);
      json(response, 200, { revoked: true }); return;
    }
    if (url.pathname === "/mcp-access" && access === "operator" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'", "referrer-policy": "no-referrer" });
      response.end(page("mcp-access.html")); return;
    }

    if (url.pathname === "/api/simulation-runs" && request.method === "GET") { json(response, 200, { runs: await simulationHistory() }); return; }
    const simulationProposalMatch = /^\/api\/simulation-proposals\/([0-9]{1,78})$/.exec(url.pathname);
    if (simulationProposalMatch && request.method === "GET") {
      const context = await simulationProposal(simulationProposalMatch[1]!);
      json(response, context ? 200 : 404, context ?? { error: "No run context recorded for this proposal." }); return;
    }
    if (url.pathname === "/api/compute-policy" && request.method === "GET") {
      const runId = url.searchParams.get("runId");
      if (runId && !/^run-[0-9a-f-]{36}$/.test(runId)) { json(response, 400, { error: "Invalid run identity." }); return; }
      json(response, 200, await cachedSimulationSnapshot(url.searchParams.get("runId") ?? undefined)); return;
    }
    if (url.pathname === "/api/simulations" && request.method === "POST") {
      const id = String(request.headers["idempotency-key"] ?? "");
      await createExperimentDraft(id, experimentDefaults(), operatorIdentity(request.headers)!);
      json(response, 202, await runExperimentDraft(id, operatorIdentity(request.headers)!)); return;
    }
    if (url.pathname === "/api/worker/start" && request.method === "POST") {
      await controlDeps().start();
      json(response, 202, { message: "Worker is starting or already running. Open Agora in a moment." }); return;
    }
    if (url.pathname === "/api/experiments" && request.method === "POST") {
      const id = String(request.headers["idempotency-key"] ?? "");
      await createExperimentDraft(id, await body(request), operatorIdentity(request.headers)!);
      json(response, 202, await runExperimentDraft(id, operatorIdentity(request.headers)!)); return;
    }
    if (url.pathname === "/api/experiments" && request.method === "GET") {
      const experiments = await experimentIndex();
      json(response, 200, { experiments, runs: experiments }); return;
    }

    const match = /^\/api\/experiments\/(run-[0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === "GET" && match && RUN_ID.test(match[1]!)) {
      const id = match[1]!;
      const record = await experimentRecord(id);
      json(response, record ? 200 : 404, record ?? { error: "Experiment not found." }); return;
    }

    const evidence = /^\/api\/experiments\/(run-[0-9a-f-]+)\/evidence$/.exec(url.pathname);
    if (request.method === "GET" && evidence && RUN_ID.test(evidence[1]!)) {
      const record = await experimentRecord(evidence[1]!);
      const value = record?.experiment.kind === "governed"
        ? { ...record, snapshot: await cachedSimulationSnapshot(evidence[1]), verification: await readComputeObject(`simulations/${evidence[1]}/verified.json`) }
        : await readObject(runPath(evidence[1]!, "evidence.json"));
      response.setHeader("content-disposition", `attachment; filename="${evidence[1]}-evidence.json"`);
      json(response, value ? 200 : 404, value ?? { error: "Evidence is saved when this run finishes." }); return;
    }
    if (url.pathname === "/api/experiment-defaults") {
      json(response, 200, { ...experimentDefaults(), maxAgents: 5, minAgents: 3, electorate: 5, quorumVotes: 3, constitutionText: readFileSync(path.join(root, "experiments/constitutions/fleet-v1.md"), "utf8") }); return;
    }
    if (url.pathname === "/constitution") {
      const constitution = readFileSync(path.join(root, "experiments/constitutions/fleet-v1.md"), "utf8")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const page = readFileSync(path.join(root, "apps/runner/public/constitution.html"), "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'self'" });
      response.end(page.replace("{{CONSTITUTION}}", () => constitution)); return;
    }
    if (["/experiments", "/experiments/new"].includes(url.pathname) || /^\/experiments\/run-[0-9a-f-]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[2];
      const record = id && RUN_ID.test(id) ? await experimentRecord(id) : null;
      if (id && id !== "new" && !record) { json(response, 404, { error: "Experiment not found." }); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" });
      response.end(page(record ? record.experiment.kind === "governed" ? "compute.html" : "experiment.html" : "experiments.html")); return;
    }
    if (url.pathname === "/compute") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" });
      response.end(page("compute.html")); return;
    }
    const brandAssets: Record<string, string> = {
      "/agora-theme.css": "text/css", "/agora/logo.svg": "image/svg+xml",
      "/agora/family-regular.woff2": "font/woff2", "/agora/family-medium.woff2": "font/woff2",
    };
    if (brandAssets[url.pathname] && request.method === "GET") {
      response.writeHead(200, { "content-type": brandAssets[url.pathname], "x-content-type-options": "nosniff", "cache-control": "public, max-age=3600" });
      response.end(readFileSync(path.join(root, "apps/runner/public", url.pathname.slice(1)))); return;
    }
    if (["/mcp-access.js", "/experiments.js", "/experiments.css", "/experiment.js", "/experiment.css", "/compute.js", "/compute.css", "/proposal-status.js"].includes(url.pathname)) {
      response.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css", "x-content-type-options": "nosniff" });
      response.end(readFileSync(path.join(root, "apps/runner/public", url.pathname.slice(1)))); return;
    }
    if (url.pathname === "/") { response.writeHead(302, { location: "/experiments" }); response.end(); return; }
    if (access === "public" && !publicProxyPath(url.pathname)) { json(response, 404, { error: "Page not found." }); return; }
    // Agora stays a real Agora application. Only fixed internal destinations are proxied.
    const upstream = process.env.FLEET_AGORA_HOST;
    if (!upstream || !/^10\.42\.0\.[0-9]{1,3}$/.test(upstream)) { json(response, 503, { error: "Agora is not ready yet. The experiment launcher is available at /experiments." }); return; }
    if (/^\/proposals\/[0-9]{1,78}\/?$/.test(url.pathname) && request.method === "GET" && !request.headers.rsc) {
      const html = await readProposalDocument(upstream, url.pathname);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
        ...(!html ? { "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" } : {}) });
      response.end(html ?? page("proposal-status.html")); return;
    }
    const headers = { ...request.headers, host: request.headers.host, "x-forwarded-proto": "https" };
    // Do not forward credentials or user-supplied proxy/routing authority to Agora.
    for (const key of Object.keys(headers)) {
      if (/^(authorization|cookie|x-goog-|x-forwarded-|x-middleware-|next-action)/i.test(key)) delete headers[key as keyof typeof headers];
    }
    headers["x-forwarded-proto"] = "https";
    const proxy = httpRequest({ hostname: upstream, port: 3000, path: request.url, method: request.method, headers, timeout: 20_000 }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    proxy.on("timeout", () => proxy.destroy());
    proxy.on("error", () => { if (!response.headersSent) json(response, 503, { error: "The independent governance service is temporarily unavailable. The agent shutdown state is shown at /compute." }); else response.end(); });
    request.pipe(proxy);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    json(response, 400, { error: access === "public" || /https?:|alch_|sk-|Bearer/.test(message) ? "Request failed. Check the private worker logs." : message });
  }
}).listen(Number(process.env.PORT ?? "8080"), "0.0.0.0", () => console.log("Fleet experiment control ready."));
