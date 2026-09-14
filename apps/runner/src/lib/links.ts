/**
 * Deep link helpers for the live run view and report, spec 12.3 ("linking to Agora Next") and
 * task 6 controller notes ("the deep link `<agoraNextBaseUrl>/proposals/<proposalId>` ... from the
 * experiment config's `display.agoraNextBaseUrl`; hide the link when unset").
 */

/** Joins `baseUrl` and `/proposals/<proposalId>`, tolerant of a trailing slash on `baseUrl`.
 *  Returns `null` when `baseUrl` is absent or empty, so callers can hide the link entirely rather
 *  than render one that 404s. */
export function agoraProposalUrl(baseUrl: string | undefined | null, proposalId: string): string | null {
  if (!baseUrl) return null;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  return `${trimmed}/proposals/${proposalId}`;
}
