import { Host } from "@fleet/schemas";
import { describeAction, evaluateAction } from "@fleet/gateway";
import type { GatewayLogRecord, GatewayVerdict, LedgerWatcher } from "@fleet/gateway";
import type { ToolCall } from "./tools.js";

export type PackageDownload = { body: Uint8Array; contentType: string };
export type PackageFetch = (url: string, signal: AbortSignal) => Promise<PackageDownload>;

/** The outer installation stops, but governance reviews the exact download that was denied. */
export class PackageRequestBlocked extends Error {
  constructor(readonly tool: ToolCall, readonly blocked: GatewayVerdict & { verdict: "BLOCK" }) {
    super(`package download blocked: ${blocked.reason}`);
  }
}

/** Only credential-free HTTPS GETs. Neither a registry response nor the installer can supply
 * request headers, methods, a proxy tunnel, credentials or a host command to this broker. */
export function packageRequestTool(raw: string): ToolCall {
  if (raw.length > 8192) throw new Error("package_request_url_too_long");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error("package_request_requires_plain_https");
  }
  Host.parse(url.hostname);
  return { class: "network_fetch", target: url.hostname, args: { path: url.pathname + url.search, scheme: "https" } };
}

export function packageFetch(opts: {
  watcher: LedgerWatcher; agentId: number; usage: { toolCalls: number };
  log: (record: GatewayLogRecord) => void; fetchImpl: typeof fetch;
}): PackageFetch {
  return async (raw, signal) => {
    signal.throwIfAborted();
    const tool = packageRequestTool(raw);
    const descriptor = describeAction(tool);
    // Called serially by the installer protocol, immediately before each upstream request.
    const snapshot = await opts.watcher.snapshot();
    const verdict = await evaluateAction(snapshot, descriptor, opts.usage);
    opts.usage.toolCalls++;
    opts.log({ ts: new Date().toISOString(), taskId: snapshot.taskId.toString(), agentId: opts.agentId,
      blockNumber: snapshot.blockNumber.toString(), charterVersion: snapshot.charterVersion, descriptor,
      payloadHash: verdict.payloadHash, verdict: verdict.verdict,
      ...(verdict.verdict === "BLOCK" ? { reason: verdict.reason } : { basis: verdict.basis }) });
    if (verdict.verdict === "BLOCK") throw new PackageRequestBlocked(tool, verdict);
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const response = await opts.fetchImpl(raw, { method: "GET", redirect: "manual", credentials: "omit",
      headers: { accept: "application/vnd.npm.install-v1+json, application/json, */*" },
      signal: requestSignal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("package_redirect_refused");
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`package_download_http_${response.status}`); }
    const max = 16 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > max) {
      await response.body?.cancel(); throw new Error("package_download_too_large");
    }
    const chunks: Uint8Array[] = []; let total = 0;
    if (!response.body) throw new Error("package_download_empty");
    const reader = response.body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => {}); };
    requestSignal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const { value, done } = await reader.read();
        requestSignal.throwIfAborted();
        if (done) break;
        total += value.byteLength;
        if (total > max) throw new Error("package_download_too_large");
        chunks.push(value);
      }
    } finally {
      requestSignal.removeEventListener("abort", cancel);
      await reader.cancel();
    }
    return { body: Buffer.concat(chunks), contentType: (response.headers.get("content-type") ?? "application/octet-stream").slice(0, 256) };
  };
}
