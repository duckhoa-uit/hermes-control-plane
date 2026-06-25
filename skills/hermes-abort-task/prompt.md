## hermes-abort-task

Cancel a running session. Triggered by clicking the abort button on a
session card, or by an explicit user request ("cancel that", "stop
hermes").

The launcher will:
1. Kill the E2B sandbox.
2. Transition the DO session to `aborted` (terminal).
3. Stream a `session.aborted` event with `reason: "user_aborted"`.

Only the original requester (or an admin) can abort. Authorization is
enforced launcher-side; do not trust client claims.

On 404, the session is already terminal — reply "already done" rather
than erroring.
