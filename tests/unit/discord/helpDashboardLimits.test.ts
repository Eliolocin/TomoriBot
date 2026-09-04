import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";
import { HELP_CATEGORIES } from "@/utils/discord/helpCatalog";
import { buildHelpDashboardPayload } from "@/utils/discord/ui/helpDashboard";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function textDisplays(value: unknown): string[] {
  const contents: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      contents.push(record.content);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return contents;
}

function assertSafePayload(payload: ReturnType<typeof buildHelpDashboardPayload>, label: string): void {
  const result = validateComponentsV2MessageLimits(payload);
  expect(result.valid, `${label} violations: ${JSON.stringify(result.violations)}`).toBe(true);
  for (const content of textDisplays(payload)) {
    expect(LONE_SURROGATE.test(content), `${label} contains a lone surrogate`).toBe(false);
    const fenceStart = content.indexOf("```markdown\n");
    if (fenceStart === -1) continue;
    const bodyStart = fenceStart + "```markdown\n".length;
    const closingFence = content.lastIndexOf("\n```");
    if (closingFence <= bodyStart) continue;
    expect(content.slice(bodyStart, closingFence), `${label} has an adjacent backtick in a fence`).not.toMatch(/``/u);
  }
}

describe("Help dashboard Components V2 limits", () => {
  it("sweeps every runtime locale, catalog category, page, and variant", () => {
    for (const locale of RUNTIME_LOCALES) {
      for (const category of HELP_CATEGORIES) {
        for (const page of category.pages) {
          const variants = [undefined, ...(page.variants ?? []).map((variant) => variant.id)];
          for (const variantId of variants) {
            const payload = buildHelpDashboardPayload(locale, category.id, page.id, variantId);
            assertSafePayload(payload, `${locale}/${category.id}/${page.id}/${variantId ?? "default"}`);
            expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
            const container = payload.components[0];
            expect(container?.type).toBe(ComponentType.Container);
            const serialized = JSON.stringify(payload);
            expect(serialized).not.toContain("commands.help.");
            expect(serialized).toContain(`help:v2:category:${locale}:${category.id}`);
            expect(serialized).toContain(`help:v2:page:${locale}:${category.id}`);
            if (page.variants) {
              expect(serialized).toContain(`help:v2:variant:${locale}:${category.id}:${page.id}`);
            }
          }
        }
      }
    }
  });

  it("renders the catalog's varied text shapes without a receipt axis", () => {
    const observed = new Set<string>();
    for (const locale of RUNTIME_LOCALES) {
      for (const category of HELP_CATEGORIES) {
        for (const page of category.pages) {
          const payload = buildHelpDashboardPayload(locale, category.id, page.id);
          for (const content of textDisplays(payload)) {
            if (content.includes("`")) observed.add("backticks");
            if ([...content].some((character) => (character.codePointAt(0) ?? 0) > 0xffff)) observed.add("astral");
            if (content.length >= 64) observed.add("stored-length");
          }
        }
      }
    }
    expect(observed.has("stored-length")).toBe(true);
    expect(observed.has("backticks")).toBe(true);
    // Help is catalog-driven and its four-argument builder has no receipt input to sweep.
  });
});
