# hermes-code-task — examples

## 1. Happy path

```
User: @hermes in acme/backend, add a rate-limit middleware to /v1/login (10/min per IP)
Hermes resolves: repo=acme/backend (allow-listed), task as quoted
Hermes calls: POST /sessions { taskDescription, repoUrl, actor: {…} }
Hermes posts: "On it — thread will update."
... stream events ...
Hermes posts: "✅ PR: https://github.com/acme/backend/pull/132 (1 file, 287 tokens)"
```

## 2. User has not authenticated

```
User: @hermes in acme/backend, …
Hermes calls: POST /sessions
Hermes receives: 412 { error: "user not authenticated", auth_url: "https://hermes.workers.dev/auth/github/start?return_to=slack://…" }
Hermes DMs: "Please grant GitHub access first: <auth_url>. I'll wait."
```

## 3. Queue full

```
User: @hermes in acme/web, …
Hermes calls: POST /sessions
Hermes receives: 429 { error: "Too many concurrent sessions", active: 10, limit: 10 }
Hermes posts: "Queue's full at the moment (10/10). Try again in a minute."
```

## 4. Repo not on allow-list

```
User: @hermes in some-random-org/lib, fix the off-by-one
Hermes does NOT call POST /sessions.
Hermes posts: "I don't have access to some-random-org/lib. Add it to your allow-list first?"
```

## 5. Mid-thread follow-up

```
User: @hermes can you also add a metrics counter on the same endpoint?
Hermes detects: same thread_ts, active session in `review_ready`.
Hermes calls: POST /sessions/<id>/prompt with the new task text + actor block.
... stream events for turn 2 ...
Hermes posts: "✅ Updated PR: https://github.com/acme/backend/pull/132 (2 files, +132/-0)"
```
