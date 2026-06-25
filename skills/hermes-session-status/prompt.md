## hermes-session-status

Look up a session. Triggered by `/hermes status <sessionId>` or when
a user asks "what's happening with that PR?" referring to a session id
in scrollback.

Post a compact status: state, PR url (if any), event count, and the
last 5 events (collapsed under "details"). Do not stream — this is a
point-in-time read.

On 404, reply "I don't know that session id" — the user probably
mistyped or is referring to a session from a different deployment.
