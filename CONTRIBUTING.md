# Contributing

## Stack

- **Runtime:** Cloudflare Worker + Durable Objects (SQLite)
- **Agent framework:** Flue (`@flue/runtime`) with Pi harness
- **Sandbox:** Cloudflare Containers (`@cloudflare/sandbox`)
- **LLM:** z.ai (glm-5.2) via `registerProvider('zai', ...)`
- **Package manager:** Bun (1.3+). Never switch to npm/pnpm/yarn.
- **Language:** TypeScript strict mode
- **Tests:** Vitest (`tests/`). 140+ tests.

## Key conventions

- File names: `kebab-case.ts`. Test files: `<name>.test.ts`.
- Identifiers: `camelCase` for vars/functions, `PascalCase` for types.
- Event types: FlueEvent from DS protocol (no custom HermesEvent).
- State machine states: `snake_case` (11 states).
- Branches: `codex/<description>` for agent sessions, `chore/`, `fix/` otherwise.
- Commits: Conventional Commits.

## Commands

| Need | Command |
|---|---|
| Install | `bun install` |
| Test | `bun run test` |
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` / `bun run lint:fix` |
| Format | `bun run format` / `bun run format:check` |
| Build | `npx flue build --target cloudflare` |
| Deploy | `npx wrangler deploy` |
| Bundle size | `bun run bundle:size` |

## CI gates

- lint (oxlint)
- format:check (biome)
- typecheck (tsc)
- tests (vitest)
- bundle:size (<1 MiB)
- deadcode (knip)

## No legacy

This project uses Flue + Cloudflare Workers. No E2B, no OpenCode, no Bun
Launcher, no VPS, no event-mapper, no SessionDurableObject.

See `docs/FLUE-MIGRATION-SPEC.md` for migration history.
