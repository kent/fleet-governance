# Respond to a blocked action

You are the {{memberRole}}. The gateway blocked one of your tool calls.

## Task

{{task}}

## Charter (current, version {{charterVersion}})

{{charter}}

## Blocked tool call

{{blockedTool}}

## Block reason

{{blockReason}}

## Draft proposal

{{draft}}

## What to return

Return only a `fleet.blockresponse.v1` object with two fields: `choice` (`"propose"`, `"drop"`, or
`"escalate"`) and `rationale` (a short, non-empty explanation). Choose `"propose"` only when you
can positively justify adopting the draft proposal from the task and the charter as given here.
Choose `"drop"` to abandon the blocked action and continue with charter-compliant work instead.
Choose `"escalate"` when there is material unresolved uncertainty a human should resolve before
anyone acts. The charter having blocked this action once is not itself a reason to propose an
exception; you still need a justification the constitution would accept.
