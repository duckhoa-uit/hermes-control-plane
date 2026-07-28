# ADR-001: Isolate the Vitest 4 Workers-pool migration

Status: Proposed

## Decision

Do not upgrade the canonical test runner in the Flue/publication migration.
Evaluate Vitest 4.1+ with `@cloudflare/vitest-pool-workers` in a separate
migration branch/configuration.

Cloudflare currently recommends the Workers Vitest integration for Worker unit
and binding-level integration tests, while `createTestHarness()` remains the
right tool for exercising a built Worker over HTTP. See the [Workers Vitest
integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and [testing overview](https://developers.cloudflare.com/workers/testing/).

## Why it is separate

The current suite is Vitest 3 + Node and already has a Docker-backed
`createTestHarness()` smoke test. Moving the whole suite at once would mix
three independent changes:

- Vitest 4 runner/config changes;
- workerd/Miniflare binding isolation and `cloudflare:test` APIs;
- Flue-generated Worker imports, Durable Object migrations, and dynamic
  workflow imports.

The pool also has migration constraints: it requires Vitest 4.1+, native V8
coverage is not supported (Istanbul instrumentation is required), and
Cloudflare documents limitations around dynamic imports inside Worker and DO
handlers.

## Spike scope

1. Add a separate `vitest.worker.config.ts` using the pool and the generated
   Worker config.
2. Port only health/MCP authorization, `ControlPlanTaskDurableObject`,
   `ControlPlanAdmissionDurableObject`, and publication lease tests.
3. Compare runtime behavior, per-file isolation, test duration, coverage, and
   CI memory against the Node suite plus `test:worker`.
4. Do not remove the current runner until the Flue workflow tests, approval
   tests, and generated Worker smoke test have equivalent coverage.

## Go/no-go criteria

Go only if the pool catches at least one runtime/binding defect that Node tests
miss, preserves deterministic DO isolation, and does not require weakening
security/publication assertions. Keep both runners if the pool is valuable
for runtime tests but unsuitable for pure Flue/model-contract unit tests.
