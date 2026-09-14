/**
 * Maps a charter-level host name (`examples.internal`) to the loopback origin the Runner actually
 * started that fake host on (`http://127.0.0.1:9797`). Built by `runModelFixture` from a model
 * fixture's `hosts[]`.
 */
export type HostOverrides = Record<string, string>;

function overrideFor(overrides: HostOverrides, hostname: string): string | undefined {
  return overrides[hostname] ?? overrides[hostname.toLowerCase()];
}

/**
 * Wraps a `fetch` so a request to a fake host's charter-level name goes to the loopback server the
 * Runner started for it, and nothing else about the request changes.
 *
 * This is a transport detail applied strictly after policy. The gateway has already described the
 * action and ruled on it against the charter's `externalAllowlist` using the host name the model
 * named (`network_fetch examples.internal`), and `ToolRouter.networkFetch` has already built the
 * URL and pinned `redirect: "manual"`. By the time this wrapper sees the call, the only open
 * question is which socket carries it. So only the scheme, host, and port are rewritten: the path,
 * query, fragment, method, headers, signal, and redirect mode are passed through untouched,
 * because every one of them is either something the gateway reasoned about or something the
 * router chose for safety.
 *
 * A host with no override is left exactly as it was, which is what makes a run against the real
 * `registry.npmjs.org` and a run against a fake `examples.internal` use the same code path.
 */
export function withHostOverrides(inner: typeof fetch, overrides: HostOverrides): typeof fetch {
  const rewrite: typeof fetch = async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      // A `Request` object carries its own headers, body and mode; this wrapper has no business
      // rebuilding one, and `ToolRouter` never passes one. Left alone rather than half-rewritten.
      return inner(input, init);
    }
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      // Not a URL this wrapper can reason about; hand it to the real fetch and let it complain.
      return inner(input, init);
    }
    const override = overrideFor(overrides, url.hostname);
    if (override === undefined) return inner(input, init);

    const target = new URL(override);
    url.protocol = target.protocol;
    url.hostname = target.hostname;
    url.port = target.port;
    return inner(url.toString(), init);
  };
  return rewrite;
}
