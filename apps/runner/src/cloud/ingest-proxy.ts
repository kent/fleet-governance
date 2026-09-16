import { createServer, request as upstreamRequest } from "node:http";

const host = process.env.FLEET_READSIDE_HOST ?? "";
if (!/^10\.42\.0\.\d{1,3}$/.test(host)) throw new Error("Invalid history host");
// This service only transports Goldsky deliveries to the authenticated receiver.
// It has no database credential, model key, signer, or compute mutation authority.
createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/goldsky") { res.writeHead(404).end(); return; }
  if (!/^Bearer [A-Za-z0-9_-]{43,}$/.test(req.headers.authorization ?? "")) { res.writeHead(401).end(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 2_000_000) { res.writeHead(413).end(); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);
    const upstream = upstreamRequest({ host, port: 8010, path: "/goldsky", method: "POST", timeout: 25_000,
      headers: { authorization: req.headers.authorization!, "content-type": "application/json", "content-length": body.length } }, incoming => {
      res.writeHead(incoming.statusCode ?? 502, { "content-type": "application/json", "cache-control": "no-store" });
      incoming.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    upstream.end(body);
  });
}).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
