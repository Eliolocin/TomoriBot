import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type {
  ProviderPanelCapabilitySection,
  ProviderPanelEntry,
  ProviderPanelModel,
} from "@/types/discord/providerPanel";
import { PERSONAL_PROVIDERS_ROUTE_NAMESPACE, PROVIDERS_ROUTE_NAMESPACE } from "@/utils/discord/providersPanelCatalog";
import {
  buildProvidersPanelPayload,
  PROVIDERS_ENTRIES_PER_SELECTOR_PAGE,
  PROVIDERS_MODELS_PER_SELECTOR_PAGE,
} from "@/utils/discord/ui/providersPanel";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const REALISTIC_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "Provider Action Completed Successfully",
  detail: "The provider configuration was saved and the current model routing state was refreshed.",
  metadata: "trace: provider-op-987654 | actor: 123456789012345678 | elapsed: 48ms",
};

const READ_STATUSES: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
const RECEIPTS: Array<PanelReceipt | undefined> = [undefined, REALISTIC_RECEIPT];
const BACKTICK_RUNS = [3, 4, 5, 6, 8];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const ALL_ACTIONS = new Set<"add-provider" | "add-endpoint" | "model" | "edit" | "activate" | "remove">([
  "add-provider",
  "add-endpoint",
  "model",
  "edit",
  "activate",
  "remove",
]);

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

function assertSafePayload(payload: ReturnType<typeof buildProvidersPanelPayload>, label: string): void {
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

function model(id: number, codeName = `provider-model-${id}`, custom = true): ProviderPanelModel {
  return {
    id,
    codeName,
    isWorkspaceActive: id === 1,
    isWorkspaceFallback: id === 2,
    isProviderFallback: id === 3,
    isCustomRegistration: custom,
    textSettings: {
      numCtx: 8192,
      hasTools: true,
      seesImages: true,
      supportsStructOutput: false,
      strictRoleAlternation: false,
      supportsPrefixCompletion: true,
    },
  };
}

function section(
  capability: ProviderPanelCapabilitySection["capability"],
  models: ProviderPanelModel[],
): ProviderPanelCapabilitySection {
  return { capability, availability: "available", models };
}

function providerEntry(
  id: string,
  displayName = `Provider ${id}`,
  models: ProviderPanelModel[] = [model(1)],
): ProviderPanelEntry {
  return {
    id,
    kind: "provider",
    provider: `provider-${id.replace(/[^a-z0-9_-]/gu, "x")}`.slice(0, 40),
    displayName,
    savedAt: null,
    rotationKeyCount: 2,
    capabilities: [
      section("text", models),
      section("image", []),
      section("embedding", []),
      section("video", []),
      section("speech", []),
      { capability: "transcription", availability: "unavailable", models: [] },
    ],
  };
}

function endpointEntry(
  id: number,
  displayName = `Endpoint ${id}`,
  models: ProviderPanelModel[] = [model(1)],
): ProviderPanelEntry {
  return {
    id: `endpoint:${id}`,
    kind: "endpoint",
    displayName,
    savedAt: null,
    connectionIds: [id],
    isPreset: false,
    connectionDetails: [
      { connectionId: id, endpointUrl: `https://endpoint-${id}.example.invalid/v1`, apiStyle: "openai-compatible" },
    ],
    capabilities: [
      section("text", models),
      section("speech", [model(100 + id, `speech-${id}`)]),
      section("transcription", [model(200 + id, `transcription-${id}`)]),
      { capability: "image", availability: "unavailable", models: [] },
      { capability: "video", availability: "unavailable", models: [] },
      { capability: "embedding", availability: "unavailable", models: [] },
    ],
  };
}

function entryValues(value: unknown): string[] {
  const values: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record.type === ComponentType.StringSelect && Array.isArray(record.options)) {
      for (const option of record.options) {
        if (!option || typeof option !== "object") continue;
        const optionRecord = option as Record<string, unknown>;
        if (typeof optionRecord.value === "string" && !optionRecord.value.startsWith("action:")) {
          values.push(optionRecord.value);
        }
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return values;
}

describe("Providers panel Components V2 limits", () => {
  it("covers every page kind, read status, route namespace, receipt, and entry collection size", () => {
    const sizes = [
      0,
      1,
      PROVIDERS_ENTRIES_PER_SELECTOR_PAGE - 1,
      PROVIDERS_ENTRIES_PER_SELECTOR_PAGE,
      PROVIDERS_ENTRIES_PER_SELECTOR_PAGE + 1,
      PROVIDERS_ENTRIES_PER_SELECTOR_PAGE * 3,
    ];
    const pages: Array<Parameters<typeof buildProvidersPanelPayload>[0]["page"]> = [
      { kind: "entry", entryId: "provider-1" },
      { kind: "add-provider" },
      { kind: "remove", entryId: "provider-1" },
    ];
    for (const locale of RUNTIME_LOCALES) {
      for (const routeNamespace of [PROVIDERS_ROUTE_NAMESPACE, PERSONAL_PROVIDERS_ROUTE_NAMESPACE] as const) {
        for (const receipt of RECEIPTS) {
          for (const readStatus of READ_STATUSES) {
            for (const size of sizes) {
              const entries = Array.from({ length: size }, (_, index) => providerEntry(`provider-${index + 1}`));
              for (const page of pages) {
                assertSafePayload(
                  buildProvidersPanelPayload({
                    locale,
                    entries,
                    initialEntryId: entries[0]?.id ?? null,
                    readStatus,
                    page,
                    rangeIndex: 1,
                    receipt,
                    enabledActions: ALL_ACTIONS,
                    routeNamespace,
                    footerCommand: { root: "model", subcommand: "text" },
                  }),
                  `${locale}/${routeNamespace}/${readStatus}/size-${size}/${page.kind}`,
                );
              }
            }
          }
        }
      }
    }
  });

  it("sweeps the custom-model selector at its page-size boundaries", () => {
    const sizes = [
      0,
      1,
      PROVIDERS_MODELS_PER_SELECTOR_PAGE - 1,
      PROVIDERS_MODELS_PER_SELECTOR_PAGE,
      PROVIDERS_MODELS_PER_SELECTOR_PAGE + 1,
      PROVIDERS_MODELS_PER_SELECTOR_PAGE * 3,
    ];
    for (const size of sizes) {
      const models = Array.from({ length: size }, (_, index) => model(index + 1));
      for (const readStatus of READ_STATUSES) {
        assertSafePayload(
          buildProvidersPanelPayload({
            locale: "en-US",
            entries: [providerEntry("provider-1", "Model-heavy provider", models)],
            initialEntryId: "provider-1",
            readStatus,
            page: { kind: "entry", entryId: "provider-1", modelRangeIndex: 2 },
            enabledActions: ALL_ACTIONS,
            routeNamespace: PROVIDERS_ROUTE_NAMESPACE,
          }),
          `models-${size}/${readStatus}`,
        );
      }
    }
  });

  it("bounds provider and model names across stored, oversized, fenced, and astral shapes", () => {
    const shapes = [
      "N".repeat(200),
      "O".repeat(20_000),
      ...BACKTICK_RUNS.map((length) => `name ${"`".repeat(length)} model`),
      "🌟".repeat(20_000),
    ];
    for (const [index, value] of shapes.entries()) {
      const entry = providerEntry("provider-shaped", value, [model(1, value)]);
      assertSafePayload(
        buildProvidersPanelPayload({
          locale: "en-US",
          entries: [entry],
          initialEntryId: entry.id,
          readStatus: "fresh",
          page: { kind: "remove", entryId: entry.id },
          receipt: REALISTIC_RECEIPT,
          enabledActions: ALL_ACTIONS,
          routeNamespace: PROVIDERS_ROUTE_NAMESPACE,
        }),
        `provider shape ${index}`,
      );
      assertSafePayload(
        buildProvidersPanelPayload({
          locale: "en-US",
          entries: [entry],
          initialEntryId: entry.id,
          readStatus: "fresh",
          page: { kind: "entry", entryId: entry.id },
          enabledActions: ALL_ACTIONS,
          routeNamespace: PROVIDERS_ROUTE_NAMESPACE,
        }),
        `model shape ${index}`,
      );
    }

    // Explicitly test a full page at PROVIDERS_ENTRIES_PER_SELECTOR_PAGE with every entry carrying oversized content
    const fullPageEntries = Array.from({ length: PROVIDERS_ENTRIES_PER_SELECTOR_PAGE }, (_, i) => ({
      id: `custom:provider-full-${i + 1}`,
      kind: "custom" as const,
      displayName: "P".repeat(20_000),
      savedAt: null,
      rotationKeyCount: 2,
      capabilities: [
        {
          capability: "text" as const,
          availability: "available" as const,
          models: [
            {
              id: i + 1,
              codeName: "M".repeat(20_000),
              displayName: "D".repeat(20_000),
              isWorkspaceActive: true,
              isWorkspaceFallback: false,
              isProviderFallback: false,
              isCustomRegistration: true,
            },
          ],
        },
      ],
    }));

    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of RECEIPTS) {
        for (const page of [
          { kind: "entry" as const, entryId: fullPageEntries[0]?.id },
          { kind: "remove" as const, entryId: fullPageEntries[0]?.id },
        ]) {
          assertSafePayload(
            buildProvidersPanelPayload({
              locale,
              entries: fullPageEntries,
              initialEntryId: fullPageEntries[0]?.id ?? null,
              readStatus: "fresh",
              page,
              receipt,
              enabledActions: ALL_ACTIONS,
              routeNamespace: PROVIDERS_ROUTE_NAMESPACE,
            }),
            `full-page-oversized/${locale}/${page.kind}/receipt=${Boolean(receipt)}`,
          );
        }
      }
    }
  });

  it("covers every provider entry exactly once across selector ranges", () => {
    const total = PROVIDERS_ENTRIES_PER_SELECTOR_PAGE + 1;
    const entries = Array.from({ length: total }, (_, index) => providerEntry(`provider-${index + 1}`));
    const seen: string[] = [];
    const rangeCount = Math.ceil(total / PROVIDERS_ENTRIES_PER_SELECTOR_PAGE);
    for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
      const payload = buildProvidersPanelPayload({
        locale: "en-US",
        entries,
        initialEntryId: null,
        readStatus: "fresh",
        page: { kind: "entry", entryId: entries[0]?.id },
        rangeIndex,
        enabledActions: ALL_ACTIONS,
        routeNamespace: PROVIDERS_ROUTE_NAMESPACE,
      });
      seen.push(...entryValues(payload).filter((value) => value.startsWith("provider-")));
    }
    expect(seen.sort()).toEqual(entries.map((entry) => entry.id).sort());
  });

  it("keeps endpoint activation and Brave entry paths valid", () => {
    const entries: ProviderPanelEntry[] = [
      endpointEntry(1),
      { id: "brave", kind: "brave", displayName: "Brave Search", savedAt: null },
    ];
    for (const page of [
      { kind: "entry", entryId: "endpoint:1" } as const,
      { kind: "entry", entryId: "brave" } as const,
      { kind: "remove", entryId: "endpoint:1" } as const,
    ]) {
      assertSafePayload(
        buildProvidersPanelPayload({
          locale: "en-US",
          entries,
          initialEntryId: "endpoint:1",
          readStatus: "fresh",
          page,
          enabledActions: ALL_ACTIONS,
          routeNamespace: PROVIDERS_ROUTE_NAMESPACE,
        }),
        `endpoint/brave/${page.kind}/${page.entryId}`,
      );
    }
  });
});
