/** Emit error types and numeric statuses only. Provider messages may contain credentials. */
export function safeFailure(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let i = 0; current && typeof current === "object" && i < 8; i++) {
    const item = current as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown; functionName?: unknown };
    chain.push({
      type: typeof item.name === "string" && /^[A-Za-z]{1,80}$/.test(item.name) ? item.name : "UnknownError",
      ...(typeof item.code === "number" ? { code: item.code } : {}),
      ...(typeof item.status === "number" ? { status: item.status } : {}),
      ...(["getTask", "charterText", "memberCount", "accountOf", "agentManifest"].includes(String(item.functionName)) ? { functionName: item.functionName } : {}),
    });
    current = item.cause;
  }
  return chain;
}
