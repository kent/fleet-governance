import { createServer } from "node:http";
import { safeFailure } from "./simulation-diagnostics.js";

/** A scheduled reconciler: Cloud Scheduler POSTs /reconcile with its own invoker identity.
 * One pass at a time; an overlapping trigger gets 409 and the next minute tries again.
 * Failures return 503 with a fixed message, never a raw error, because RPC and cloud
 * errors can carry private endpoints. The log keeps the error's type and status, and its
 * message only when it is one of our own plain sentences with no URL or path in it. */
export function serveReconcile(name: string, reconcile: () => Promise<unknown>, failure: string) {
  let running = false;
  createServer(async (request, response) => {
    const reply = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(data));
    };
    if (request.url === "/healthz" && request.method === "GET") { reply(200, { ok: true }); return; }
    if (request.url !== "/reconcile" || request.method !== "POST") { reply(404, { error: "Unknown operation." }); return; }
    if (running) { reply(409, { error: "Reconciliation is already in progress." }); return; }
    running = true;
    try {
      const result = await reconcile();
      console.log(JSON.stringify({ event: `${name}_reconciled`, result }));
      reply(200, result);
    } catch (error) {
      const message = error instanceof Error && /^[A-Za-z0-9 .,'()-]{1,200}$/.test(error.message) ? error.message : undefined;
      console.error(JSON.stringify({ event: `${name}_failed`, summary: failure, ...(message ? { message } : {}), failure: safeFailure(error) }));
      reply(503, { error: failure });
    } finally { running = false; }
  }).listen(Number(process.env.PORT ?? "8080"), "0.0.0.0", () => console.log(`Fleet ${name} ready.`));
}
