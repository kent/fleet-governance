import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCplsJobBody,
  insertVoteRow,
  syncCplsAfterStage,
  triggerCplsJob,
  waitForArchiveObject,
  waitForDaoNode,
} from "./cpls-sync.js";
import type { FetchLike, QueryablePool } from "./cpls-sync.js";

/** A minimal local HTTP server for faking CPLS/fake-gcs/DAO Node in these tests, the way task 8
 *  finding 3 asks for ("a local fake HTTP server the way readside.ts does"). `handler` gets the
 *  parsed request body (if any) and must write the response itself. */
function startFakeServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          server,
          close: () => new Promise((res) => server.close(() => res())),
        });
      } else {
        reject(new Error("could not determine fake server port"));
      }
    });
  });
}

const realFetch: FetchLike = (url, init) => fetch(url, init as never) as unknown as ReturnType<FetchLike>;

let activeServer: { close: () => Promise<void> } | null = null;
afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

describe("buildCplsJobBody", () => {
  it("matches the documented payload shape exactly (docs/compatibility-notes.md Task 6)", () => {
    const body = buildCplsJobBody({ governor: "0xABCDEF0000000000000000000000000000000abcd", chainId: 31337 }) as Record<string, unknown>;
    expect(body).toEqual({
      type: "sync_daonode",
      payload: {
        infra_dao_slug: "fleet",
        logic: "refresh_list",
        sources: ["dao_node"],
        reset: true,
        config: {
          schema: "fleet",
          dao_slug: "FLEET",
          index_tenant_prefix: "fleet",
          features: { oodao: false, snapshot_proposals: false, dao_node_proposals: true },
          deployment: {
            chain_id: 31337,
            gov: { address: "0xabcdef0000000000000000000000000000000abcd" },
            token: { address: "0xabcdef0000000000000000000000000000000abcd" },
          },
        },
      },
    });
  });
});

describe("triggerCplsJob (POST and wait, against a local fake HTTP server)", () => {
  it("posts the job and returns once GET /jobs/<id> reports completed", async () => {
    let pollCount = 0;
    const handle = await startFakeServer((req, res, body) => {
      if (req.method === "POST" && req.url === "/jobs") {
        const parsed = JSON.parse(body);
        expect(parsed.type).toBe("sync_daonode");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ job_id: "job-1" }));
        return;
      }
      if (req.method === "GET" && req.url === "/jobs/job-1") {
        pollCount++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: pollCount < 2 ? "queued" : "completed" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = handle;

    await triggerCplsJob(realFetch, handle.url, { governor: "0xgov", chainId: 31337 }, { pollMs: 5 });
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it("throws when the job reports failed", async () => {
    const handle = await startFakeServer((req, res) => {
      if (req.method === "POST" && req.url === "/jobs") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ job_id: "job-2" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "failed", error: "boom" }));
    });
    activeServer = handle;

    await expect(triggerCplsJob(realFetch, handle.url, { governor: "0xgov", chainId: 31337 }, { pollMs: 5 })).rejects.toThrow(/failed/);
  });

  it("throws when the POST itself fails", async () => {
    const handle = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    activeServer = handle;
    await expect(triggerCplsJob(realFetch, handle.url, { governor: "0xgov", chainId: 31337 })).rejects.toThrow(/500/);
  });

  it("times out if the job never completes", async () => {
    const handle = await startFakeServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ job_id: "job-3" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "queued" }));
    });
    activeServer = handle;
    await expect(
      triggerCplsJob(realFetch, handle.url, { governor: "0xgov", chainId: 31337 }, { timeoutMs: 20, pollMs: 5 }),
    ).rejects.toThrow(/did not reach "completed"/);
  });
});

describe("waitForArchiveObject (fake-gcs bucket listing)", () => {
  it("returns once the object appears in the bucket listing", async () => {
    let listed = false;
    const handle = await startFakeServer((req, res) => {
      if (req.url === "/storage/v1/b/fleet-archive-dev/o") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: listed ? [{ name: "data/fleet/votes/42.ndjson.gz" }] : [] }));
        listed = true;
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = handle;

    await waitForArchiveObject(realFetch, { offline: true, bucketName: "fleet-archive-dev", fakeGcsUrl: handle.url }, "42", { pollMs: 5 });
  });

  it("times out when the object never appears", async () => {
    const handle = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [] }));
    });
    activeServer = handle;

    await expect(
      waitForArchiveObject(realFetch, { offline: true, bucketName: "fleet-archive-dev", fakeGcsUrl: handle.url }, "42", { timeoutMs: 20, pollMs: 5 }),
    ).rejects.toThrow(/did not appear/);
  });

  it("uses a HEAD request against the public GCS URL when not offline", async () => {
    const methods: (string | undefined)[] = [];
    const handle = await startFakeServer((req, res) => {
      methods.push(req.method);
      res.writeHead(200);
      res.end();
    });
    activeServer = handle;

    const fetchFn: FetchLike = async (url, init) => {
      expect(url).toBe("https://storage.googleapis.com/fleet-archive-dev/data/fleet/votes/7.ndjson.gz");
      expect(init?.method).toBe("HEAD");
      const res = await fetch(handle.url, init as never);
      return res as unknown as ReturnType<FetchLike> extends Promise<infer R> ? R : never;
    };
    await waitForArchiveObject(fetchFn, { offline: false, bucketName: "fleet-archive-dev" }, "7");
    expect(methods).toEqual(["HEAD"]);
  });

  it("checks the private archive reader without attempting anonymous GCS access", async () => {
    const requests: string[] = [];
    const handle = await startFakeServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200); res.end();
    });
    activeServer = handle;
    await waitForArchiveObject(realFetch, { offline: false, bucketName: "private-bucket", archiveBaseUrl: `${handle.url}/private-bucket/` }, "42");
    expect(requests).toEqual(["HEAD /private-bucket/data/fleet/votes/42.ndjson.gz"]);
  });
});

describe("syncCplsAfterStage", () => {
  it("posts the job then waits for the archive object, in that order", async () => {
    const events: string[] = [];
    const handle = await startFakeServer((req, res) => {
      if (req.method === "POST" && req.url === "/jobs") {
        events.push("post");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ job_id: "job-9" }));
        return;
      }
      if (req.url === "/jobs/job-9") {
        events.push("poll-job");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "completed" }));
        return;
      }
      if (req.url === "/storage/v1/b/bucket/o") {
        events.push("poll-bucket");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [{ name: "data/fleet/votes/1.ndjson.gz" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = handle;

    await syncCplsAfterStage(realFetch, {
      cplsUrl: handle.url,
      identity: { governor: "0xgov", chainId: 31337 },
      archive: { offline: true, bucketName: "bucket", fakeGcsUrl: handle.url },
      proposalId: "1",
      label: "voted",
    });

    expect(events[0]).toBe("post");
    expect(events).toContain("poll-bucket");
    expect(events.indexOf("post")).toBeLessThan(events.indexOf("poll-bucket"));
  });
});

describe("waitForDaoNode", () => {
  it("resolves once the predicate matches the polled JSON body", async () => {
    let calls = 0;
    const handle = await startFakeServer((_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proposal: { id: calls < 2 ? "0" : "42" } }));
    });
    activeServer = handle;

    await waitForDaoNode(realFetch, `${handle.url}/v1/proposal/42`, (body) => (body as { proposal: { id: string } }).proposal.id === "42", {
      pollMs: 5,
    });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("times out when the predicate never matches", async () => {
    const handle = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: false }));
    });
    activeServer = handle;

    await expect(
      waitForDaoNode(realFetch, handle.url, () => false, { timeoutMs: 20, pollMs: 5, description: "test predicate" }),
    ).rejects.toThrow(/test predicate/);
  });
});

describe("insertVoteRow", () => {
  it("inserts with every column mapped and addresses lowercased, ON CONFLICT DO NOTHING", async () => {
    const query = vi.fn(async () => undefined);
    const pool: QueryablePool = { query };
    await insertVoteRow(pool, {
      proposalId: "12345",
      transactionHash: "0xTX",
      blockNumber: 99n,
      chainId: 31337,
      voter: "0xABCDEF0000000000000000000000000000000abcd",
      support: 1,
      weight: 1_000_000_000_000_000_000n,
      reason: "FOR. it's fine",
      contract: "0xGOVERNOR000000000000000000000000000000000",
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO fleet.votes");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(values).toEqual([
      "12345",
      "0xTX",
      "99",
      31337,
      "0xabcdef0000000000000000000000000000000abcd",
      1,
      "1000000000000000000",
      "FOR. it's fine",
      "0xgovernor000000000000000000000000000000000",
    ]);
  });
});
