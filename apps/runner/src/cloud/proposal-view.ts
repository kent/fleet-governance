/** Next can stream HTTP 200 before a proposal lookup throws. Do not pass that
 * broken document through as a successful proposal page. */
export function failedProposalDocument(status: number, html: string): boolean {
  return status >= 400 || /:E\{\\?"digest\\?":/.test(html);
}

export async function readProposalDocument(upstream: string, pathname: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!/^10\.42\.0\.\d{1,3}$/.test(upstream) || !/^\/proposals\/[0-9]{1,78}\/?$/.test(pathname)) throw new Error("Invalid proposal destination.");
  try {
    // A normal HTML document avoids forwarding credentials or Next navigation
    // headers. This read never wakes the worker or changes governance state.
    const response = await fetcher(`http://${upstream}:3000${pathname}`, {
      headers: { accept: "text/html" }, redirect: "error", signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();
    return response.headers.get("content-type")?.includes("text/html") && !failedProposalDocument(response.status, html) ? html : null;
  } catch { return null; }
}
