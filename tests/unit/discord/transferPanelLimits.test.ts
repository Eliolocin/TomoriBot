import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType } from "discord.js";
import {
  V2_CONFIG_EXCLUSIONS,
  type MemoryBucket,
  personalConfigExportDataSchema,
  workspaceConfigExportDataSchema,
} from "@/types/db/dataExport";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { parseTransferPanelRoute, type TransferPanelRoute } from "@/utils/discord/transferCatalog";
import {
  buildConfigSectionChecklistModal,
  buildConfigTransferPreviewPayload,
  buildMemoryMappingPayload,
  buildMemoryReplaceConfirmationPayload,
  buildMemoryTransferPreviewPayload,
  buildTransferNoticePayload,
  type MemoryTransferDestination,
} from "@/utils/discord/ui/transferPanel";
import { validateComponentsV2MessageLimits, validateRawModalLimits } from "@/utils/discord/ui/componentsV2Limits";
import { ColorCode } from "@/utils/misc/logger";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const SECTION_NAMES = {
  workspace_config: Object.keys(workspaceConfigExportDataSchema.shape),
  personal_config: Object.keys(personalConfigExportDataSchema.shape),
};
const BACKTICK_RUNS = [3, 4, 5, 6, 8];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function visitComponents(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visitComponents(child, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) visitComponents(child, visit);
}

function textDisplays(value: unknown): string[] {
  const contents: string[] = [];
  visitComponents(value, (record) => {
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      contents.push(record.content);
    }
  });
  return contents;
}

function buttonIds(value: unknown): string[] {
  const ids: string[] = [];
  visitComponents(value, (record) => {
    if (record.type === ComponentType.Button && typeof record.customId === "string") ids.push(record.customId);
  });
  return ids;
}

function assertSafePreview(payload: ReturnType<typeof buildConfigTransferPreviewPayload>, label: string): void {
  const result = validateComponentsV2MessageLimits(payload);
  expect(result.valid, `${label}: ${JSON.stringify(result.violations)}`).toBe(true);
  for (const content of textDisplays(payload)) {
    expect(LONE_SURROGATE.test(content), `${label} contains a lone surrogate`).toBe(false);
    expect(content, `${label} leaves an adjacent backtick run`).not.toMatch(/`{2,}/u);
  }
}

function makeMemoryBuckets(count: number, labelPrefix = "Bucket"): MemoryBucket[] {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `bucket-${index}`,
    label: `${labelPrefix} ${index}`,
    memories: [{ content: `Memory ${index}`, tags: [] }],
  }));
}

function makeMemoryDestinations(count: number, labelPrefix = "Persona"): MemoryTransferDestination[] {
  return Array.from({ length: count }, (_unused, index) => ({
    lineageId: index + 100,
    label: `${labelPrefix} ${index}`,
  }));
}

function assertMemoryPayload(payload: unknown, label: string): void {
  const result = validateComponentsV2MessageLimits(payload as ReturnType<typeof buildMemoryMappingPayload>);
  expect(result.valid, `${label}: ${JSON.stringify(result.violations)}`).toBe(true);
  visitComponents(payload, (record) => {
    if (record.type === ComponentType.Button) {
      expect(record.style, `${label} uses Primary`).not.toBe(ButtonStyle.Primary);
      expect(record.style, `${label} uses Success`).not.toBe(ButtonStyle.Success);
    }
    if (record.type === ComponentType.StringSelect) {
      const options = record.options as unknown[] | undefined;
      expect(options?.length ?? 0, `${label} emitted an empty select`).toBeGreaterThan(0);
      expect(options?.length ?? 0, `${label} exceeds the select option limit`).toBeLessThanOrEqual(25);
    }
  });
  for (const content of textDisplays(payload)) {
    expect(LONE_SURROGATE.test(content), `${label} contains a lone surrogate`).toBe(false);
    expect(content, `${label} leaves an adjacent backtick run`).not.toMatch(/`{2,}/u);
  }
}

function assertTransferCustomIds(payload: unknown, locale: string, nonce: string): void {
  visitComponents(payload, (record) => {
    const customId = record.customId;
    if (typeof customId !== "string" || customId.startsWith("pagination-indicator-")) return;
    const parsed = parseInteractionRoute(customId);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const route = parseTransferPanelRoute(parsed);
    expect(route, `Unrecognized transfer custom ID: ${customId}`).not.toBeNull();
    if (!route) return;
    expect(route.locale).toBe(locale);
    expect(route.nonce).toBe(nonce);
    if (route.action === "memory-bucket-select" || route.action === "memory-bucket-page") {
      expect(route.bucketPage).toBeGreaterThanOrEqual(0);
    }
    if (route.action === "memory-map" || route.action === "memory-map-page") {
      expect(route.bucketIndex).toBeGreaterThanOrEqual(0);
      expect(route.destPage).toBeGreaterThanOrEqual(0);
    }
  });
}

function parsedTransferRoutes(payload: unknown): TransferPanelRoute[] {
  const routes: TransferPanelRoute[] = [];
  visitComponents(payload, (record) => {
    const customId = record.customId;
    if (typeof customId !== "string" || customId.startsWith("pagination-indicator-")) return;
    const parsed = parseInteractionRoute(customId);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const route = parseTransferPanelRoute(parsed);
    expect(route).not.toBeNull();
    if (route) routes.push(route);
  });
  return routes;
}

describe("transfer panel Components V2 limits", () => {
  it("covers every runtime locale, ownership, and detected-section count", () => {
    for (const locale of RUNTIME_LOCALES) {
      for (const kind of ["workspace_config", "personal_config"] as const) {
        const permittedSections = SECTION_NAMES[kind];
        for (let count = 1; count <= permittedSections.length; count++) {
          const detectedSections = permittedSections.slice(0, count);
          const payload = buildConfigTransferPreviewPayload({
            locale,
            kind,
            detectedSections,
            droppedFields: [],
            nonce: `nonce-${locale}-${kind}-${count}`,
          });
          assertSafePreview(payload, `${locale}/${kind}/count-${count}`);

          const ids = buttonIds(payload);
          expect(ids).toHaveLength(2);
          const parsedActions = ids.map((customId) => {
            const parsed = parseInteractionRoute(customId);
            expect(parsed).not.toBeNull();
            if (!parsed) throw new Error("Transfer button route did not parse");
            return parseTransferPanelRoute(parsed);
          });
          expect(parsedActions).toContainEqual({
            action: "config-continue",
            locale,
            nonce: `nonce-${locale}-${kind}-${count}`,
          });
          expect(parsedActions).toContainEqual({
            action: "cancel",
            locale,
            nonce: `nonce-${locale}-${kind}-${count}`,
          });
        }
      }
    }
  });

  it("bounds varied dropped-field content and validates the checklist control", () => {
    for (const kind of ["workspace_config", "personal_config"] as const) {
      for (const droppedField of [
        ...BACKTICK_RUNS.map((length) => `field-${"`".repeat(length)}-value`),
        `field-${"🌟".repeat(500)}`,
        "field-\uD800-value",
      ]) {
        const payload = buildConfigTransferPreviewPayload({
          locale: "en-US",
          kind,
          detectedSections: SECTION_NAMES[kind],
          droppedFields: [droppedField],
          nonce: `nonce-shape-${kind}`,
        });
        assertSafePreview(payload, `${kind}/${droppedField.length}`);
      }

      const exclusionPayload = buildConfigTransferPreviewPayload({
        locale: "en-US",
        kind,
        detectedSections: SECTION_NAMES[kind],
        droppedFields: Object.keys(V2_CONFIG_EXCLUSIONS),
        nonce: `nonce-exclusions-${kind}`,
      });
      const exclusionText = textDisplays(exclusionPayload).join("\n");
      for (const [field, exclusion] of Object.entries(V2_CONFIG_EXCLUSIONS)) {
        expect(exclusionText).toContain(field);
        expect(exclusionText).toContain(exclusion.reason);
      }

      for (const locale of RUNTIME_LOCALES) {
        for (let count = 1; count <= SECTION_NAMES[kind].length; count++) {
          const detectedSections = SECTION_NAMES[kind].slice(0, count);
          const modal = buildConfigSectionChecklistModal({
            locale,
            kind,
            detectedSections,
            nonce: `nonce-modal-${locale}-${kind}-${count}`,
          });
          const result = validateRawModalLimits(modal);
          expect(result.valid, `${locale}/${kind}/modal-${count}: ${JSON.stringify(result.violations)}`).toBe(true);
          expect(modal.components).toHaveLength(1);
          expect(modal.components[0]?.type).toBe(18);

          const control = modal.components[0]?.component;
          expect(control?.type).toBe(22);
          expect(control?.min_values).toBe(0);
          expect(control?.max_values).toBe(control?.options?.length);
          expect(control?.required).toBe(false);
          expect(control?.options?.length).toBe(count);
          expect(control?.options?.length).toBeLessThanOrEqual(10);
          expect(modal.components.length).toBeLessThanOrEqual(5);

          const allowed = new Set(SECTION_NAMES[kind]);
          for (const option of control?.options ?? []) {
            expect(allowed.has(option.value)).toBe(true);
            expect(option.default).toBe(true);
          }
        }
      }
    }
  });

  it("renders both config previews as one compact block of quoted rows", () => {
    // Exact shape per kind: a bold lead line, then each heading immediately followed by its own quote rows. A blank
    // line between a heading and its rows reads as a separate panel, and the marker applies per line. Both kinds
    // share one builder, so each gets its own pinned block rather than one standing in for the other.
    const expectedBlocks: Record<keyof typeof SECTION_NAMES, string[]> = {
      workspace_config: [
        "### Review Configuration Import",
        "**Detected data is ready to import as a workspace configuration.**",
        "Detected sections",
        "> • Chat",
        "> • Triggers",
        "> • Capabilities",
        "> • Memory",
        "> • Media",
        "> • Speech",
        "> • Access",
        "Excluded or nonportable data",
        "> No excluded data was found.",
      ],
      personal_config: [
        "### Review Configuration Import",
        "**Detected data is ready to import as a personal configuration.**",
        "Detected sections",
        "> • Profile",
        "> • Privacy",
        "> • Appearance",
        "> • Response Modes",
        "Excluded or nonportable data",
        "> No excluded data was found.",
      ],
    };

    for (const kind of ["workspace_config", "personal_config"] as const) {
      const payload = buildConfigTransferPreviewPayload({
        locale: "en-US",
        kind,
        detectedSections: SECTION_NAMES[kind],
        droppedFields: [],
        nonce: `nonce-format-${kind}`,
      });
      const [content] = textDisplays(payload);
      if (content === undefined) throw new Error(`Preview payload for ${kind} carries no TextDisplay`);

      expect({ kind, content }).toEqual({ kind, content: expectedBlocks[kind].join("\n") });
      expect({ kind, blankLines: content.split("\n").filter((line) => line.length === 0).length }).toEqual({
        kind,
        blankLines: 0,
      });

      const droppedContent = textDisplays(
        buildConfigTransferPreviewPayload({
          locale: "en-US",
          kind,
          detectedSections: SECTION_NAMES[kind],
          droppedFields: ["nai_preset_name", "nai_char_ref_url"],
          nonce: `nonce-format-dropped-${kind}`,
        }),
      )[0];
      if (droppedContent === undefined) throw new Error(`Preview payload for ${kind} carries no TextDisplay`);
      const droppedLines = droppedContent.split("\n");
      for (const field of ["nai_preset_name", "nai_char_ref_url"] as const) {
        expect({
          kind,
          field,
          quoted: droppedLines.includes(`> ${field}: ${V2_CONFIG_EXCLUSIONS[field].reason}`),
        }).toEqual({ kind, field, quoted: true });
      }
    }
  });

  it("renders a terminal notice as a panel with no leftover controls", () => {
    const cancelled = buildTransferNoticePayload({
      locale: "en-US",
      titleKey: "commands.transfer.cancelled_title",
      descriptionKey: "commands.transfer.cancelled_description",
      color: ColorCode.INFO,
    });

    expect(validateComponentsV2MessageLimits(cancelled).valid).toBe(true);
    expect(textDisplays(cancelled).join("\n")).toBe(
      [
        `### ${localizer("en-US", "commands.transfer.cancelled_title")}`,
        localizer("en-US", "commands.transfer.cancelled_description"),
      ].join("\n"),
    );
    // The point of replacing the panel is that no stale button survives it.
    expect(buttonIds(cancelled)).toEqual([]);

    const success = buildTransferNoticePayload({
      locale: "en-US",
      titleKey: "commands.transfer.config_import_success_title",
      descriptionKey: "commands.transfer.config_import_success_description",
      descriptionVars: { sections: "Triggers", fields: 4 },
      color: ColorCode.SUCCESS,
    });
    const successText = textDisplays(success).join("\n");
    expect(successText).toContain("Sections applied: Triggers");
    expect(successText).toContain("Configuration fields updated: 4");
    expect(buttonIds(success)).toEqual([]);
  });

  it("uses the intended button styles and section values", () => {
    const payload = buildConfigTransferPreviewPayload({
      locale: "en-US",
      kind: "workspace_config",
      detectedSections: SECTION_NAMES.workspace_config,
      droppedFields: [],
      nonce: "nonce-style",
    });
    const row = (payload.components[0] as { components?: unknown[] }).components?.find(
      (component) => (component as { type?: number }).type === ComponentType.ActionRow,
    ) as { components?: Array<{ style?: ButtonStyle }> } | undefined;
    const styles = row?.components?.map((button) => button.style);
    expect(styles).not.toContain(ButtonStyle.Primary);
    expect(styles).not.toContain(ButtonStyle.Success);
    expect(styles).toEqual([ButtonStyle.Secondary, ButtonStyle.Secondary]);
  });

  it("rejects an empty presented section list", () => {
    for (const kind of ["workspace_config", "personal_config"] as const) {
      expect(() =>
        buildConfigSectionChecklistModal({
          locale: "en-US",
          kind,
          detectedSections: [],
          nonce: `nonce-empty-${kind}`,
        }),
      ).toThrow("without importable sections");
    }
  });

  it("covers memory preview and mapping pages across locales, strategies, and boundary counts", () => {
    const counts = [24, 25, 26];
    for (const locale of RUNTIME_LOCALES) {
      for (const kind of ["workspace_memories", "personal_memories"] as const) {
        const preview = buildMemoryTransferPreviewPayload({
          locale,
          kind,
          buckets: makeMemoryBuckets(26),
          nonce: `mem-prev-${locale === "en-US" ? "e" : "j"}-${kind === "workspace_memories" ? "w" : "p"}`,
        });
        assertMemoryPayload(preview, `${locale}/${kind}/preview`);
        assertTransferCustomIds(
          preview,
          locale,
          `mem-prev-${locale === "en-US" ? "e" : "j"}-${kind === "workspace_memories" ? "w" : "p"}`,
        );

        for (const strategy of ["merge", "replace"] as const) {
          for (const bucketCount of counts) {
            for (const destinationCount of counts) {
              const buckets = makeMemoryBuckets(bucketCount);
              const destinations = makeMemoryDestinations(destinationCount);
              const mapping = Object.fromEntries(
                buckets.map((bucket, index) => [bucket.name, destinations[index]?.lineageId ?? "skip"]),
              );
              const nonce = `mem-${locale === "en-US" ? "e" : "j"}-${strategy[0]}-${bucketCount}-${destinationCount}`;
              const bucketPageCount = Math.ceil(bucketCount / 25);
              const destinationPageCount = Math.ceil(destinationCount / 24);
              for (let bucketPage = 0; bucketPage < bucketPageCount; bucketPage++) {
                for (let destPage = 0; destPage < destinationPageCount; destPage++) {
                  const selectedBucketIndex = bucketPage * 25;
                  const payload = buildMemoryMappingPayload({
                    locale,
                    nonce,
                    buckets,
                    destinations,
                    mapping,
                    selectedBucketIndex,
                    bucketPage,
                    destPage,
                    strategy,
                  });
                  const label = `${locale}/${strategy}/${bucketCount}/${destinationCount}/${bucketPage}/${destPage}`;
                  assertMemoryPayload(payload, label);
                  assertTransferCustomIds(payload, locale, nonce);
                }
              }
            }
          }
        }
      }
    }
  });

  it("uses destructive styles only for Replace and sanitizes varied user text", () => {
    const buckets = [3, 4, 5, 6, 8].map((runLength, index) => ({
      name: `special-bucket-${index}`,
      label: `Source ${"`".repeat(runLength)} 🌟 \uD800 ${index}`,
      memories: [{ content: "memory", tags: [] }],
    }));
    const destinations = [3, 4, 5, 6, 8].map((runLength, index) => ({
      lineageId: index + 200,
      label: `Persona ${"`".repeat(runLength)} 🌟 \uD800 ${index}`,
    }));
    const mapping = Object.fromEntries(
      buckets.map((bucket, index) => {
        const destination = destinations[index];
        if (!destination) throw new Error("Special text fixture requires a matching destination");
        return [bucket.name, index % 2 === 0 ? destination.lineageId : "skip"];
      }),
    );

    for (const strategy of ["merge", "replace"] as const) {
      const payload = buildMemoryMappingPayload({
        locale: "en-US",
        nonce: `nonce-shape-${strategy}`,
        buckets,
        destinations,
        mapping,
        selectedBucketIndex: 0,
        bucketPage: 0,
        destPage: 0,
        strategy,
      });
      assertMemoryPayload(payload, `shape/${strategy}`);
      const buttons: Array<{ style?: ButtonStyle }> = [];
      const labels: string[] = [];
      visitComponents(payload, (record) => {
        if (record.type === ComponentType.Button) buttons.push(record as { style?: ButtonStyle });
        if (record.type === ComponentType.StringSelect && Array.isArray(record.options)) {
          for (const option of record.options as Array<{ label?: string }>) {
            if (option.label) labels.push(option.label);
          }
        }
      });
      expect(buttons.map((button) => button.style)).toContain(
        strategy === "replace" ? ButtonStyle.Danger : ButtonStyle.Secondary,
      );
      expect(buttons.map((button) => button.style)).not.toContain(ButtonStyle.Primary);
      expect(buttons.map((button) => button.style)).not.toContain(ButtonStyle.Success);
      for (const label of labels) {
        expect(LONE_SURROGATE.test(label)).toBe(false);
        expect(label).not.toMatch(/`{2,}/u);
      }

      const preview = buildMemoryTransferPreviewPayload({
        locale: "en-US",
        kind: "workspace_memories",
        buckets,
        nonce: `nonce-shape-preview-${strategy}`,
      });
      assertMemoryPayload(preview, `shape/preview/${strategy}`);
      const previewStyles: unknown[] = [];
      visitComponents(preview, (record) => {
        if (record.type === ComponentType.Button) previewStyles.push(record.style);
      });
      expect(previewStyles).toContain(ButtonStyle.Danger);

      const confirmation = buildMemoryReplaceConfirmationPayload({
        locale: "en-US",
        nonce: `nonce-shape-confirm-${strategy}`,
        buckets,
        destinations,
        mapping,
      });
      assertMemoryPayload(confirmation, `shape/confirmation/${strategy}`);
      const confirmationStyles: unknown[] = [];
      visitComponents(confirmation, (record) => {
        if (record.type === ComponentType.Button) confirmationStyles.push(record.style);
      });
      expect(confirmationStyles).toEqual([ButtonStyle.Danger, ButtonStyle.Secondary]);
    }
  });

  it("throws instead of emitting a zero-option memory select", () => {
    const destinations = makeMemoryDestinations(1);
    const buckets = makeMemoryBuckets(1);
    expect(() =>
      buildMemoryMappingPayload({
        locale: "en-US",
        nonce: "nonce-empty-buckets",
        buckets: [],
        destinations,
        mapping: {},
        selectedBucketIndex: 0,
        bucketPage: 0,
        destPage: 0,
        strategy: "merge",
      }),
    ).toThrow("without buckets");
    expect(() =>
      buildMemoryMappingPayload({
        locale: "en-US",
        nonce: "nonce-empty-destinations",
        buckets,
        destinations: [],
        mapping: {},
        selectedBucketIndex: 0,
        bucketPage: 0,
        destPage: 0,
        strategy: "merge",
      }),
    ).toThrow("without destinations");
  });

  it("renders complete memory mapping text, skip markers, and boundary route fields", () => {
    const buckets = makeMemoryBuckets(26);
    const destinations = makeMemoryDestinations(26);
    const mapping = Object.fromEntries(
      buckets.map((bucket, index) => {
        const destination = destinations[index];
        if (!destination) throw new Error("Boundary fixture requires a matching destination");
        return [bucket.name, index === 25 ? "skip" : destination.lineageId];
      }),
    );
    const nonce = "mem-route-fields";
    const payload = buildMemoryMappingPayload({
      locale: "en-US",
      nonce,
      buckets,
      destinations,
      mapping,
      selectedBucketIndex: 25,
      bucketPage: 1,
      destPage: 1,
      strategy: "replace",
    });
    const routes = parsedTransferRoutes(payload);
    expect(routes).toContainEqual({
      action: "memory-bucket-select",
      locale: "en-US",
      nonce,
      bucketPage: 1,
    });
    expect(routes).toContainEqual({
      action: "memory-map",
      locale: "en-US",
      nonce,
      bucketIndex: 25,
      destPage: 1,
    });
    expect(routes).toContainEqual({
      action: "memory-bucket-page",
      locale: "en-US",
      nonce,
      bucketPage: 0,
    });
    expect(routes).toContainEqual({
      action: "memory-bucket-page",
      locale: "en-US",
      nonce,
      bucketPage: 1,
    });
    expect(routes).toContainEqual({
      action: "memory-map-page",
      locale: "en-US",
      nonce,
      bucketIndex: 25,
      destPage: 0,
    });
    expect(routes).toContainEqual({
      action: "memory-map-page",
      locale: "en-US",
      nonce,
      bucketIndex: 25,
      destPage: 1,
    });
    const mappingText = textDisplays(payload).join("\n");
    expect(mappingText).toContain("Bucket 0 -> Persona 0");
    expect(mappingText).toContain("Bucket 25 -> (skipped)");
    expect(mappingText).toContain("Strategy: Replace");

    const preview = buildMemoryTransferPreviewPayload({
      locale: "en-US",
      kind: "workspace_memories",
      buckets: buckets.slice(0, 2),
      nonce: "mem-preview-fields",
    });
    const previewText = textDisplays(preview).join("\n");
    expect(previewText).toContain("Bucket 0");
    expect(previewText).toContain("Bucket 1");
    expect(previewText).toContain("Documents and personas are excluded.");

    const confirmation = buildMemoryReplaceConfirmationPayload({
      locale: "en-US",
      nonce: "mem-confirm-fields",
      buckets: buckets.slice(0, 2),
      destinations,
      mapping: { "bucket-0": 100, "bucket-1": "skip" },
    });
    const confirmationText = textDisplays(confirmation).join("\n");
    expect(confirmationText).toContain("Persona 0");
    expect(confirmationText).toContain("Bucket 1");
    expect(confirmationText).toContain("will not be imported");
  });
});
