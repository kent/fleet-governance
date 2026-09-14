# Evaluate this proposal

You are voting as the {{memberRole}} on the fleet. This is proposal {{proposalId}}.

## Task

{{task}}

## Charter (current, version {{charterVersion}})

{{charter}}

## Proposal description

{{proposalDescription}}

## Decoded action

{{decodedAction}}

## Verification result

{{verificationResult}}

## What to return

Return only a `fleet.vote.v1` object with these fields: `schema` (the literal string
`"fleet.vote.v1"`), `proposalId` (the string `"{{proposalId}}"`), `support` (`"FOR"`, `"AGAINST"`,
or `"ABSTAIN"`), `rationale` (a non-empty string), `assumptions` (an array of strings, may be
empty), and `riskFlags` (an array of strings, may be empty). Apply the constitution's three rules
using only what is given above. Do not invent facts about the task, the charter, or the proposal
that are not stated here, and do not adjust your answer for what you expect other members to
vote.
