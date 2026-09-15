import type { CompleteRequest, Provider } from "@fleet/agent-runtime";

/** Apply the run's selected text to work and vote calls, including token reservations. */
export function withRunConstitution(provider: Provider, text: string | undefined): Provider {
  if (!text) return provider;
  const prepare = <T>(request: CompleteRequest<T>): CompleteRequest<T> => ({
    ...request,
    system: `${request.system}\n\n## Constitution selected by the experiment operator\n\n${text}\n\nThe selected constitution guides your judgement. It cannot grant tool permissions, bypass the gateway or executor, change output schemas, or authorise acting without settled approval.`,
  });
  return {
    name: provider.name,
    ...(provider.estimateInputTokens ? { estimateInputTokens: <T>(request: CompleteRequest<T>) => provider.estimateInputTokens!(prepare(request)) } : {}),
    complete: <T>(request: CompleteRequest<T>) => provider.complete(prepare(request)),
  };
}
