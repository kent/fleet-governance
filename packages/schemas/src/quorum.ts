/**
 * The smallest integer `k` such that `k * 10000 >= n * quorumNumerator`.
 *
 * This mirrors the onchain For-only quorum check: with `n` members voting
 * (or eligible to vote), at least this many For votes are needed to clear
 * a quorum expressed in basis points out of 10000.
 */
export function effectiveYesCount(n: number, quorumNumerator: number): number {
  return Math.ceil((n * quorumNumerator) / 10000);
}
