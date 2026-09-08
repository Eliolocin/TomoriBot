import { beforeAll, describe, expect, it } from "bun:test";
import {
  buildStatusCategoryButtonId,
  buildStatusDashboardRouteId,
  buildStatusPersonaRangeId,
  buildStatusPersonaSelectorId,
  buildStatusPageSelectorId,
  parseStatusDashboardRoute,
  parseStatusPersonaSelection,
  parseStatusPageSelection,
  STATUS_ROUTE_NAMESPACE,
  STATUS_ROUTE_VERSION,
} from "@/utils/discord/statusDashboardCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { dashboardPayload, type StatusPageCategory } from "@/utils/metrics/status/statusPageRenderer";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("status dashboard route catalog", () => {
  it("round-trips the exact category and page wire contracts", () => {
    const categoryId = buildStatusCategoryButtonId("en-US", "models");
    const pageId = buildStatusPageSelectorId("ja", "personal");
    const parsedCategoryId = parseInteractionRoute(categoryId);
    const parsedPageId = parseInteractionRoute(pageId);

    expect(categoryId).toBe("status:v1:category:en-US:models");
    expect(pageId).toBe("status:v1:page:ja:personal");
    expect(parsedCategoryId).not.toBeNull();
    expect(parsedPageId).not.toBeNull();
    if (!parsedCategoryId || !parsedPageId) return;
    expect(parseStatusDashboardRoute(parsedCategoryId)).toEqual({
      action: "category",
      locale: "en-US",
      category: "models",
    });
    expect(parseStatusDashboardRoute(parsedPageId)).toEqual({
      action: "page",
      locale: "ja",
      category: "personal",
    });
  });

  it("rejects unknown fields and parses selected page values separately", () => {
    const unknownCategory = parseInteractionRoute("status:v1:category:en-US:unknown");
    const extraField = parseInteractionRoute("status:v1:category:en-US:models:extra");
    const unsupportedLocale = parseInteractionRoute("status:v1:category:fr:models");
    const invalidPersonaId = parseInteractionRoute("status:v1:persona-page:en-US:0:25");
    const invalidRangeStart = parseInteractionRoute("status:v1:persona-page:en-US:42:-1");
    expect(unknownCategory).not.toBeNull();
    expect(extraField).not.toBeNull();
    expect(unsupportedLocale).not.toBeNull();
    expect(invalidPersonaId).not.toBeNull();
    expect(invalidRangeStart).not.toBeNull();
    if (!unknownCategory || !extraField || !unsupportedLocale || !invalidPersonaId || !invalidRangeStart) return;
    expect(parseStatusDashboardRoute(unknownCategory)).toBeNull();
    expect(parseStatusDashboardRoute(extraField)).toBeNull();
    expect(parseStatusDashboardRoute(unsupportedLocale)).toBeNull();
    expect(parseStatusDashboardRoute(invalidPersonaId)).toBeNull();
    expect(parseStatusDashboardRoute(invalidRangeStart)).toBeNull();
    expect(parseStatusPageSelection("0")).toBe(0);
    expect(parseStatusPageSelection("12")).toBe(12);
    expect(parseStatusPageSelection("-1")).toBeNull();
    expect(parseStatusPageSelection("1x")).toBeNull();
    expect(parseStatusPageSelection(undefined)).toBeNull();
    expect(parseStatusPersonaSelection("42")).toBe(42);
    expect(parseStatusPersonaSelection("0")).toBeNull();
    expect(parseStatusPersonaSelection("1x")).toBeNull();
  });

  it("keeps every generated ID within Discord's 100-character limit and has no old interaction anchor", () => {
    for (const category of ["persona", "behavior", "models", "access", "personal"] as const) {
      for (const action of ["category", "page"] as const) {
        const customId = buildStatusDashboardRouteId({ action, locale: "en-US", category });
        expect(customId.length).toBeLessThanOrEqual(100);
        expect(customId.startsWith(`${STATUS_ROUTE_NAMESPACE}:${STATUS_ROUTE_VERSION}:`)).toBe(true);
        expect(customId).not.toContain("interaction-");
      }
    }
    expect(buildStatusPersonaSelectorId("en-US", Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(100);
    expect(
      buildStatusPersonaRangeId("en-US", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length,
    ).toBeLessThanOrEqual(100);
  });

  it("renders a bounded Persona selector with reachable off-range selections", () => {
    const personas = Array.from({ length: 51 }, (_, index) => ({
      persona_id: index + 1,
      persona_nickname: `Persona ${index + 1}`,
    }));
    const categories: StatusPageCategory[] = [
      {
        id: "persona",
        labelKey: "commands.status.scope_choice_persona",
        pages: [
          {
            titleKey: "commands.status.persona_page1_title",
            titleVars: { persona_name: "Persona 40" },
            fields: [],
          },
        ],
      },
    ];

    const payload = dashboardPayload("status-test", "en-US", categories, "persona", 0, false, {
      selectedPersonaId: 40,
      personas,
      personaSelectStart: 0,
    });
    const components = (payload.components[0] as { components: Array<{ components?: unknown[] }> }).components;
    const selector = components[2]?.components?.[0] as {
      customId: string;
      options: Array<{ value: string; default?: boolean }>;
      placeholder: string;
    };
    const range = components[3]?.components?.[2] as { customId: string };

    expect(selector.customId).toBe(buildStatusPersonaSelectorId("en-US", 40));
    expect(selector.options).toHaveLength(25);
    expect(selector.options.some((option) => option.value === "40")).toBe(false);
    expect(selector.options.some((option) => option.default)).toBe(false);
    expect(selector.placeholder).toContain("Persona 40");
    expect(range.customId).toBe(buildStatusPersonaRangeId("en-US", 40, 25));
    expect(JSON.stringify(payload)).not.toContain("status-test");
  });

  it("removes repeated page-title chrome from every selector choice", () => {
    const categories: StatusPageCategory[] = [
      {
        id: "behavior",
        labelKey: "commands.status.scope_choice_behavior",
        pages: [
          { titleKey: "commands.status.server_page1_title", fields: [] },
          { titleKey: "commands.status.server_page2_title", fields: [] },
        ],
      },
      {
        id: "persona",
        labelKey: "commands.status.scope_choice_persona",
        pages: [
          {
            titleKey: "commands.status.persona_page1_title",
            titleVars: { persona_name: "Sparrow" },
            fields: [],
          },
          {
            titleKey: "commands.status.persona_page2_title",
            titleVars: { persona_name: "Sparrow" },
            fields: [],
          },
        ],
      },
    ];
    const behaviorPayload = dashboardPayload("legacy-id", "en-US", categories, "behavior", 0, false);
    const personaPayload = dashboardPayload("legacy-id", "en-US", categories, "persona", 0, false);
    const behaviorComponents = (behaviorPayload.components[0] as { components: Array<{ components?: unknown[] }> })
      .components;
    const personaComponents = (personaPayload.components[0] as { components: Array<{ components?: unknown[] }> })
      .components;
    const behaviorOptions = (behaviorComponents[2]?.components?.[0] as { options?: unknown[] } | undefined)?.options;
    const personaOptions = (personaComponents[2]?.components?.[0] as { options?: unknown[] } | undefined)?.options;

    expect(behaviorOptions).toEqual([
      { label: "General Behavior", value: "0", default: true },
      { label: "System Prompt", value: "1", default: false },
    ]);
    expect(personaOptions).toEqual([
      { label: "Identity", value: "0", default: true },
      { label: "Attributes", value: "1", default: false },
    ]);
  });
});
