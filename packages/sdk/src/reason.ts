import type { VoteV1 } from "@fleet/schemas";

/** Thrown by `renderVoteReason` when the rendered reason would exceed 1,024 bytes. The SDK never
 *  truncates a vote reason; a rationale that does not fit must be shortened by the caller. */
export class ReasonTooLongError extends Error {
  constructor(actualBytes: number) {
    super(`vote reason is ${actualBytes} bytes, over the 1024 byte limit`);
    this.name = "ReasonTooLongError";
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Renders a `fleet.vote.v1` object into the onchain reason text, spec 8.3:
 * `<SUPPORT>. <rationale> [flags: a, b; confidence: 0.78]`. The bracket is omitted entirely when
 * there are no risk flags and no confidence self-report; `flags:` and `confidence:` inside the
 * bracket are each included only when present. Throws `ReasonTooLongError` (never truncates) if
 * the UTF-8 encoded result exceeds 1,024 bytes.
 */
export function renderVoteReason(v: VoteV1): string {
  const bracketParts: string[] = [];
  if (v.riskFlags.length > 0) {
    bracketParts.push(`flags: ${v.riskFlags.join(", ")}`);
  }
  if (v.confidenceBps !== undefined) {
    bracketParts.push(`confidence: ${(v.confidenceBps / 10000).toFixed(2)}`);
  }
  const bracket = bracketParts.length > 0 ? ` [${bracketParts.join("; ")}]` : "";
  const rendered = `${v.support}. ${v.rationale}${bracket}`;

  const bytes = byteLength(rendered);
  if (bytes > 1024) {
    throw new ReasonTooLongError(bytes);
  }
  return rendered;
}

export interface ParsedVoteReason {
  support: "FOR" | "AGAINST" | "ABSTAIN" | null;
  rationale: string;
  flags: string[];
  confidence: number | null;
}

const SUPPORT_PREFIX = /^(FOR|AGAINST|ABSTAIN)\. /;
const TRAILING_BRACKET = / \[([^\]]*)\]$/;

/** Inverse of `renderVoteReason`, tolerant of onchain reasons that do not follow the structured
 *  format at all (a bare `castVote` reason, or free text): `support` is `null` when the leading
 *  `FOR./AGAINST./ABSTAIN. ` prefix is absent, and `flags`/`confidence` stay empty/`null` when the
 *  trailing bracket is absent. */
export function parseVoteReason(reason: string): ParsedVoteReason {
  const supportMatch = SUPPORT_PREFIX.exec(reason);
  const support = supportMatch ? (supportMatch[1] as "FOR" | "AGAINST" | "ABSTAIN") : null;
  const afterSupport = supportMatch ? reason.slice(supportMatch[0].length) : reason;

  let rationale = afterSupport;
  let flags: string[] = [];
  let confidence: number | null = null;

  const bracketMatch = TRAILING_BRACKET.exec(afterSupport);
  if (bracketMatch) {
    const inner = bracketMatch[1] ?? "";
    rationale = afterSupport.slice(0, afterSupport.length - bracketMatch[0].length);

    const flagsMatch = /flags:\s*([^;]*)/.exec(inner);
    if (flagsMatch) {
      flags = (flagsMatch[1] ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
    }
    const confidenceMatch = /confidence:\s*([0-9.]+)/.exec(inner);
    if (confidenceMatch) {
      confidence = Number(confidenceMatch[1]);
    }
  }

  return { support, rationale, flags, confidence };
}
