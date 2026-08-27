---
title: "Testing with Bun Module Mocks"
---

Bun's `mock.module()` registry is process-wide. `mock.restore()` restores function
mocks and spies, but it does not restore a replaced module. A partial or behavioral
module mock can therefore corrupt files that run later in a plain `bun test`.

## Required pattern

Capture the real namespace with a static import, spread its full export surface,
and register behavioral replacements through the shared scoped helper:

```ts
import { mock } from "bun:test";
import * as realRepositories from "@/utils/db/repositories";
import { createScopedModuleMocker, overrideMembers } from "../../helpers/mockSurface";

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/db/repositories": realRepositories,
});

scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  userRepository: overrideMembers(realRepositories.userRepository, {
    loadByDiscordId: async () => fakeUser,
  }),
}));
```

`createScopedModuleMocker` keeps the controlled behavior active for the declaring
test file, then neutralises the leaked exports after its `afterAll` hook. Use
`overrideMembers` for class instances and classes used through static methods;
object spread does not copy prototype members.

How an export is neutralised depends on its kind, and the difference matters:

- A **function** export becomes a proxy that switches back to the hoisted real
  function once the scope closes.
- An **object** export (a repository singleton, a registry) keeps its genuine
  identity. The overridden members are installed on the real object and restored
  from their pristine descriptors when the scope closes.

Objects are handled that way because `spyOn` cannot instrument a proxy. Bun
installs nothing on one: no throw, no missing export, the spy records zero calls,
and a later file's assertions quietly observe the unspied implementation. This is
the same reason `stubLogMembers` mutates the `log` singleton instead of mocking
`@/utils/misc/logger`.

## Lane classification ignores comments

`scripts/checks/lib/testIsolation.ts` decides which files get a private `bun test`
process by matching the module-mock marker after removing comments. Explaining a module
mock in JSDoc therefore does not hand a file a private process. A file that does not
register a mock shares its lane, so both `bun run test` and a plain `bun test` exercise
the same shared-process path.

For a pure passthrough, a raw factory with only the matching spread is harmless:

```ts
mock.module("@/utils/misc/logger", () => ({ ...realLogger }));
```

Prefer dependency injection or `spyOn(...).mockRestore()` when a test controls only
one function. Do not dynamically import the real module inside the factory, because
that import resolves through Bun's already-mocked registry.

## Validation

Run both test modes and the source guard:

```bash
bun test
bun run test
bun run check-mock-module-surfaces
```

The guard audits curated high-fanout modules under `tests/**/*.test.ts`. It requires
a matching hoisted namespace spread and requires behavioral overrides to use
`createScopedModuleMocker`.
