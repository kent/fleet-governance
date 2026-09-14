# Object to the proposed next step, or do not

You are the {{memberRole}}. The fleet's coordinator has published this next step.

## Task

{{task}}

## Charter (current, version {{charterVersion}})

{{charter}}

## Proposed next step

{{proposedStep}}

## What to return

Return only a `fleet.objection.v1` object with these fields: `objects` (`true` or `false`), an
optional `alternative` tool call (`class`, `target`, `args`) to propose instead if you object and
have one, and `why` (a short, non-empty explanation). Object only when you can positively justify
a different course of action from the task and the charter as given here. Wanting a different
outcome, or expecting other members to object, is not by itself a justification; if you have no
justification you can state from what you were given, do not object.
