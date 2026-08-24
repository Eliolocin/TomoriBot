import { describe, expect, it, spyOn } from "bun:test";
import { createScopedModuleMocker } from "../../helpers/mockSurface";

describe("createScopedModuleMocker", () => {
  it("keeps scoped object exports spyable", () => {
    const realService = {
      load: () => "real",
    };
    const mockedService = {
      load: () => "mocked",
    };
    let factory: (() => object) | undefined;

    const registrar = {
      module(_specifier: string, registeredFactory: () => object) {
        factory = registeredFactory;
      },
    };
    const scopedMock = createScopedModuleMocker(registrar, {
      "@/example/service": { service: realService },
    });

    scopedMock.module("@/example/service", () => ({ service: mockedService }));
    const scopedModule = factory?.() as { service: typeof realService } | undefined;

    expect(scopedModule?.service).toBe(realService);
    const loadSpy = spyOn(realService, "load");
    try {
      expect(scopedModule?.service.load()).toBe("mocked");
      expect(loadSpy).toHaveBeenCalledTimes(1);
    } finally {
      loadSpy.mockRestore();
    }
  });
});
