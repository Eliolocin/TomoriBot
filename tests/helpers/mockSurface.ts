import { afterAll, spyOn } from "bun:test";
import { log } from "@/utils/misc/logger";

/**
 * Helper for writing leak-safe `mock.module` factories.
 *
 * Bun's `mock.module()` is process-global for the whole test run and is NOT
 * undone by `mock.restore()`. A factory that returns only the exports one file
 * cares about therefore corrupts every test file loaded later in a monolithic
 * `bun test`: missing named exports fail ESM link-time validation (reported
 * against the innocent victim file), and simplified stubs silently replace real
 * behavior that other files assert on.
 *
 * The fix is to always spread a hoisted `import * as real` namespace and
 * override only what the file controls. Object spread alone is not enough when
 * an export is a CLASS INSTANCE or a class used for its statics, because those
 * members live on the prototype and are not own enumerable properties, so a
 * spread would silently reproduce the same partial-mock bug one level down.
 * {@link overrideMembers} covers those cases.
 */

type LogSurface = typeof log;

/**
 * Member names are checked against the real surface, but signatures are not: existing stubs narrow
 * parameters the real members declare as optional or `unknown`, which strict contravariance would
 * reject for no safety gain in a test double.
 */
type LogMemberStubs = { [K in keyof LogSurface]?: (...args: never[]) => unknown };

/**
 * Replaces members of the live `log` singleton for the calling file, restoring them in `afterAll`.
 *
 * Use this instead of a module mock over `@/utils/misc/logger`, which
 * `scripts/checks/checkMockModuleSurface.ts` rejects. `log` is a process-wide singleton whose
 * members production resolves at call time, so a module mock leaves the module record replaced for
 * the rest of the run. A LATER file's `spyOn(log, ...)` then installs nothing at all: no throw, no
 * missing export, the spy records zero calls, and the assertions quietly observe the real
 * implementation instead. Mutating the singleton avoids that entirely and is order-independent.
 */
export function stubLogMembers(overrides: LogMemberStubs): void {
  const spies = Object.entries(overrides).map(([member, implementation]) =>
    spyOn(log, member as keyof LogSurface).mockImplementation(implementation as never),
  );

  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
  });
}

interface ModuleMockRegistrar {
  module(specifier: string, factory: () => object): void;
}

interface MockScope {
  isActive(): boolean;
  /** Registers an undo run in the declaring file's `afterAll`, before the scope closes. */
  onClose(restore: () => void): void;
}

/**
 * Registers module mocks whose controlled behavior is active only for the test
 * file that declared them.
 *
 * Bun keeps the mocked exports in its process-wide registry after the file
 * finishes, so each export is neutralised in this file's `afterAll` hook rather
 * than unregistered. A function export becomes a proxy that switches back to the
 * hoisted-real function; an object export keeps its genuine identity and has the
 * overridden members restored on it ({@link scopeObjectExport} explains why the
 * two differ). Either way the file's behavioral stubs survive while the leaked
 * module stays harmless to files that run later in the same `bun test` process.
 *
 * Every registered module must have a matching hoisted namespace in
 * `realModules`. Factories should still spread that namespace so newly-added
 * exports remain present and the source-level guard can verify the pattern.
 *
 * @param registrar - Bun's `mock` function, which exposes `mock.module`
 * @param realModules - Hoisted real namespaces keyed by mocked specifier
 * @returns A registrar with the same `module(specifier, factory)` shape
 */
export function createScopedModuleMocker(
  registrar: ModuleMockRegistrar,
  realModules: Readonly<Record<string, object>>,
): ModuleMockRegistrar {
  let active = true;
  const restores: Array<() => void> = [];
  const scope: MockScope = {
    isActive: () => active,
    onClose: (restore) => restores.push(restore),
  };

  afterAll(() => {
    active = false;
    // Reverse order so nested overrides of the same member unwind correctly.
    for (const restore of restores.reverse()) restore();
    restores.length = 0;
  });

  return {
    module(specifier, factory) {
      const realModule = realModules[specifier];
      if (!realModule) {
        throw new Error(`Missing hoisted real module for scoped mock: ${specifier}`);
      }

      registrar.module(specifier, () => scopeModuleExports(scope, realModule, factory()));
    },
  };
}

function scopeModuleExports(scope: MockScope, realModule: object, mockedModule: object): object {
  const realExports = realModule as Record<string, unknown>;
  const mockedExports = mockedModule as Record<string, unknown>;
  const scopedExports: Record<string, unknown> = { ...realExports };

  for (const [name, mockedValue] of Object.entries(mockedExports)) {
    const realValue = realExports[name];
    scopedExports[name] = realValue === mockedValue ? realValue : scopeExportValue(scope, name, realValue, mockedValue);
  }

  return scopedExports;
}

function scopeExportValue(scope: MockScope, name: string, realValue: unknown, mockedValue: unknown): unknown {
  if (typeof realValue === "function" && typeof mockedValue === "function") {
    return new Proxy(realValue, {
      apply(target, thisArg, args) {
        return Reflect.apply(scope.isActive() ? mockedValue : target, thisArg, args);
      },
      construct(target, args, newTarget) {
        return Reflect.construct(scope.isActive() ? mockedValue : target, args, newTarget);
      },
      get(target, property, receiver) {
        const source = scope.isActive() ? mockedValue : target;
        return Reflect.get(source, property, source === target ? receiver : source);
      },
    });
  }

  if (isObject(realValue) && isObject(mockedValue)) {
    return scopeObjectExport(scope, realValue, mockedValue);
  }

  throw new Error(
    `Scoped module mock export "${name}" must override a function or object; ` +
      `received ${typeof realValue} -> ${typeof mockedValue}`,
  );
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Pristine descriptors captured the first time a member is overridden, so a
 * second scope overriding the same member still restores the genuine one rather
 * than a previous file's stub.
 */
const pristineMembers = new WeakMap<object, Map<PropertyKey, PropertyDescriptor | undefined>>();

/**
 * Installs a factory's overrides directly onto the genuine export and returns
 * that same object, undoing them when the declaring file's scope closes.
 *
 * A Proxy stand-in cannot be used for object exports. Bun's `spyOn` installs
 * nothing at all on a Proxy: no throw, no missing export, the spy records zero
 * calls, and a later file's assertions quietly observe the unspied
 * implementation. Keeping the export identity genuine is what lets that spy
 * land, which is the same reason `stubLogMembers` mutates the `log` singleton.
 */
function scopeObjectExport(scope: MockScope, realValue: object, mockedValue: object): object {
  const pristine = pristineMembers.get(realValue) ?? new Map<PropertyKey, PropertyDescriptor | undefined>();
  pristineMembers.set(realValue, pristine);

  for (const key of Reflect.ownKeys(mockedValue)) {
    const override = Reflect.getOwnPropertyDescriptor(mockedValue, key);
    if (!override) continue;

    if (!pristine.has(key)) pristine.set(key, Reflect.getOwnPropertyDescriptor(realValue, key));
    const original = pristine.get(key);

    // A frozen or sealed export cannot be overridden; leaving it real is safer
    // than throwing from inside a `mock.module` factory, which runs at link time.
    if (!Reflect.defineProperty(realValue, key, { ...override, configurable: true })) continue;

    scope.onClose(() => {
      if (original) Reflect.defineProperty(realValue, key, original);
      else Reflect.deleteProperty(realValue, key);
    });
  }

  return realValue;
}

/**
 * Overrides selected members of an object, class instance, or class without
 * discarding the rest of its surface.
 *
 * Strategy is chosen at runtime because a hoisted `import * as real` capture is
 * only guaranteed real relative to files linked BEFORE the capturing file: in a
 * monolithic run an earlier test file may already have replaced a class with a
 * plain object. Branching on the received value keeps this helper correct in
 * both situations instead of throwing `Class extends value ... is not a
 * constructor`.
 *
 * @param real - Genuine member captured from a hoisted `import * as real`
 * @param overrides - Members this test file needs to control
 * @returns A stand-in that answers `overrides` first and delegates everything else
 *
 * @example
 * ```ts
 * import * as realRepositories from "@/utils/db/repositories";
 *
 * mock.module("@/utils/db/repositories", () => ({
 *   ...realRepositories,
 *   userRepository: overrideMembers(realRepositories.userRepository, {
 *     loadByDiscordId: async () => fakeUser,
 *   }),
 * }));
 * ```
 */
export function overrideMembers<TReal extends object, TOverrides extends object>(
  real: TReal,
  overrides: TOverrides,
): TReal & TOverrides {
  // Subclassing a class inherits the constructor plus every non-enumerable
  // static, which a spread would drop; `Object.assign` then shadows only the
  // listed statics.
  if (typeof real === "function") {
    class Overridden extends (real as unknown as new (...args: never[]) => unknown) {}
    return Object.assign(Overridden, overrides) as unknown as TReal & TOverrides;
  }

  // For a class instance, plain object, or namespace, putting the real value on
  // the prototype chain keeps unlisted members resolvable; the overrides land as
  // own properties that shadow it.
  return Object.assign(Object.create(real) as TReal, overrides) as TReal & TOverrides;
}
