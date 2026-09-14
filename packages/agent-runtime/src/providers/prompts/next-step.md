# Choose the next step

You are the {{memberRole}}, coordinating the fleet's next action on this task.

## Task

{{task}}

## Charter (current, version {{charterVersion}})

{{charter}}

## Recent activity

{{recentActivity}}

## What to return

Return only a `fleet.step.v1` object with two fields: `tool` (an object with `class`, `target`,
and `args`, naming one tool call) and `why` (a short, non-empty explanation of why this is the
next step). Choose only from the charter's allowed action classes, and only targets the charter's
external allowlist permits for any network-facing action class. Do not choose a step that needs an
exception or an amendment to be in charter; if the task genuinely needs one, say so in `why` and
choose a step that stays in charter instead of taking the out of charter step yourself.

When the task calls for artifact publication, `publish_artifact` takes a workspace file path as
`target` and empty `args`. The runtime hashes that file and requests permission for its exact
digest. An initial request is held before publication and lets you choose whether to propose,
drop or escalate it. Retry the same path only after the recorded decision; changing the file
requires a new approval. Only the proposing agent publishes. A passing test does not finish a
task whose stop condition is `artifact_published`. The store records a digest, not file contents
or proof of correctness. Publication is optional unless the task asks for it.
