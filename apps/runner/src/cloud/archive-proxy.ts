import { createServer } from "node:http";
import { get } from "node:https";
import { accessToken } from "./google.js";

const bucket = process.env.FLEET_ARCHIVE_BUCKET ?? "fleet-governance-archive-449245570324";
if (!["fleet-governance-archive-449245570324", "fleet-governance-history-449245570324"].includes(bucket)) throw new Error("Invalid archive bucket");
// Loopback-only ADC reader. The private archive bucket never becomes public.
createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://archive");
  if (!["GET", "HEAD"].includes(request.method ?? "") || !url.pathname.startsWith(`/${bucket}/`)) { response.writeHead(404); response.end(); return; }
  try {
    const object = decodeURIComponent(url.pathname.slice(bucket.length + 2));
    const target = `https://storage.googleapis.com/download/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
    const upstream = get(target, { headers: { Authorization: `Bearer ${await accessToken()}` }, timeout: 10000 }, incoming => {
      // Preserve compressed bytes. node:https does not transparently decompress them.
      response.writeHead(incoming.statusCode ?? 502, { "content-type": "application/octet-stream", "cache-control": "no-store" });
      if (request.method === "HEAD") { incoming.resume(); response.end(); }
      else incoming.pipe(response);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  } catch { response.writeHead(502); response.end(); }
}).listen(8082, "127.0.0.1", () => console.log("Private archive reader ready."));
