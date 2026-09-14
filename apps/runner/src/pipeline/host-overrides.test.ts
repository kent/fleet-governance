import { describe, expect, it } from "vitest";
import { withHostOverrides } from "./host-overrides.js";

type Call = { input: RequestInfo | URL; url: string; init: RequestInit | undefined };

function recordingFetch(): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, url: typeof input === "string" || input instanceof URL ? String(input) : input.url, init });
    return new Response("ok");
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const overrides = { "examples.internal": "http://127.0.0.1:9797", "spec.examples.internal": "http://127.0.0.1:9798" };

describe("withHostOverrides", () => {
  it("rewrites scheme, host and port, and nothing else about the URL", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, overrides);

    await wrapped("https://examples.internal/solutions/tiny-lib?v=2#frag");

    expect(calls[0]?.url).toBe("http://127.0.0.1:9797/solutions/tiny-lib?v=2#frag");
  });

  it("picks the override for the exact host, not a suffix of it", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, overrides);

    await wrapped("https://spec.examples.internal/slugify-rules");

    expect(calls[0]?.url).toBe("http://127.0.0.1:9798/slugify-rules");
  });

  it("leaves a host with no override completely alone", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, overrides);

    await wrapped("https://registry.npmjs.org/left-pad");

    expect(calls[0]?.url).toBe("https://registry.npmjs.org/left-pad");
  });

  it("passes every other request option through unchanged, redirect: manual included", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, overrides);
    const signal = AbortSignal.timeout(10_000);
    const init: RequestInit = { method: "GET", redirect: "manual", signal, headers: { "x-test": "1" } };

    await wrapped("https://examples.internal/x", init);

    expect(calls[0]?.init).toBe(init);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBe(signal);
  });

  it("accepts a URL object as well as a string", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, overrides);

    await wrapped(new URL("http://examples.internal/a/b"));

    expect(calls[0]?.url).toBe("http://127.0.0.1:9797/a/b");
  });

  it("hands a Request object straight through rather than half-rewriting it", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, overrides);
    const request = new Request("https://examples.internal/x");

    await wrapped(request);

    expect(calls[0]?.url).toBe("https://examples.internal/x");
  });

  it("does nothing at all when no overrides are configured", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, {});

    await wrapped("https://examples.internal/solutions/tiny-lib");

    expect(calls[0]?.url).toBe("https://examples.internal/solutions/tiny-lib");
  });

  it("clears the port when the override names none, rather than keeping the original one", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = withHostOverrides(fetchImpl, { "examples.internal": "http://127.0.0.1" });

    await wrapped("https://examples.internal:8443/x");

    expect(calls[0]?.url).toBe("http://127.0.0.1/x");
  });
});
