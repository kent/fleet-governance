#!/usr/bin/env node
// Fake external host for model-fixture runs (task 4). Serves one site's files by exact path,
// nothing else: no directory listing, no templating, no dependencies. Usage:
//
//   node server.mjs --site <name> --port <n>
//
// Files come from sites/<name>/ (relative to this file). A request for /a/b is served from
// sites/<name>/a/b if that file exists, 404 otherwise. Content-Type is guessed from the file
// extension; a request path with no recognized extension is served as text/plain. Logs one line
// per request to stderr. Prints "listening <port>" as its first stderr line once bound, so a
// caller that started this with --port 0 can read back the actual ephemeral port.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITES_ROOT = path.join(HERE, "sites");

const CONTENT_TYPES = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};
const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// A malformed request (bad percent-encoding, some other unexpected failure) must never take the
// whole host down: a model fixture run may depend on this process serving requests for the rest
// of a task's budget. Neither handler exits or rethrows; both just log and keep serving.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`server.mjs: unhandled rejection: ${errorMessage(reason)}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`server.mjs: uncaught exception: ${errorMessage(err)}\n`);
});

function parseArgs(argv) {
  let site;
  let port;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--site") {
      site = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--port") {
      port = Number(argv[i + 1]);
      i += 1;
    }
  }
  if (!site) {
    throw new Error("server.mjs: --site <name> is required");
  }
  if (!Number.isInteger(port) || port < 0) {
    throw new Error("server.mjs: --port <n> is required (0 for an ephemeral port)");
  }
  return { site, port };
}

/** Resolves a request path to a file under the site root, refusing anything that would escape it
 *  (no traversal via "..", regardless of URL encoding node has already decoded). */
function resolveSitePath(siteRoot, requestUrl) {
  const decoded = decodeURIComponent(requestUrl.split("?")[0] ?? "");
  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.normalize(path.join(siteRoot, relative));
  if (resolved !== siteRoot && !resolved.startsWith(siteRoot + path.sep)) {
    return null;
  }
  return resolved;
}

async function main() {
  const { site, port } = parseArgs(process.argv.slice(2));
  const siteRoot = path.join(SITES_ROOT, site);

  const server = http.createServer((req, res) => {
    const handleRequest = async () => {
      let status = 404;
      try {
        // resolveSitePath calls decodeURIComponent, which throws URIError on malformed
        // percent-encoding (for example "/%" or "/%zz"); that call must stay inside this try so
        // the error is handled as a normal 404 below, not an unhandled rejection.
        const filePath = resolveSitePath(siteRoot, req.url ?? "/");
        if (filePath) {
          const stat = await fs.stat(filePath);
          if (stat.isFile()) {
            const body = await fs.readFile(filePath);
            const ext = path.extname(filePath);
            const contentType = CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
            status = 200;
            res.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length });
            res.end(body);
          } else {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
          }
        } else {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
        }
      } catch (err) {
        // A malformed request path (URIError from decodeURIComponent) and a plain missing file
        // (ENOENT from fs.stat/fs.readFile) are both ordinary 404s, the same as any other
        // unresolvable path. Anything else is unexpected, this server's own fault, a 500.
        const isNotFound = err instanceof URIError || (err && err.code === "ENOENT");
        status = isNotFound ? 404 : 500;
        if (!res.headersSent) {
          res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        }
        if (!res.writableEnded) {
          res.end(status === 404 ? "not found" : "internal error");
        }
      } finally {
        process.stderr.write(`${req.method} ${req.url} ${status}\n`);
      }
    };

    // Belt and braces on top of handleRequest's own try/catch: this is the boundary that keeps
    // any surprise (a throw from the catch block itself, res.writeHead/res.end failing, ...) from
    // becoming an unhandled rejection that takes the whole host down mid-run.
    handleRequest().catch((err) => {
      process.stderr.write(`server.mjs: request handler failed unexpectedly: ${errorMessage(err)}\n`);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        if (!res.writableEnded) {
          res.end("internal error");
        }
      } catch {
        // The response is unrecoverable (socket already gone); nothing left to do but not crash.
      }
    });
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    process.stderr.write(`listening ${boundPort}\n`);
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  process.stderr.write(`server.mjs: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
