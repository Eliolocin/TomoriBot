import { beforeAll, describe, expect, it } from "bun:test";
import {
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type StringSelectMenuComponentData,
  type TextDisplayComponentData,
} from "discord.js";
import type { SavedProviderConfigRow } from "@/types/db/schema";
import { CONFIG_NAI_PRESET_NEXT_VALUE, computeNaiPresetFingerprint } from "@/utils/discord/configPanelCatalog";
import { buildConfigModelsBody, type ConfigParametersView } from "@/utils/discord/ui/configModelsPanel";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

type AnyComponent = ComponentInContainerData | ButtonComponentData | StringSelectMenuComponentData;

function flattenComponents(components: ComponentInContainerData[]): AnyComponent[] {
  const flattened: AnyComponent[] = [];
  for (const component of components) {
    flattened.push(component);
    if ("components" in component && Array.isArray(component.components)) {
      for (const child of component.components) {
        flattened.push(child);
      }
    }
  }
  return flattened;
}

function makeConfig(provider: string): SavedProviderConfigRow {
  return {
    saved_config_id: 1,
    server_id: 100,
    provider,
    api_key: null,
    key_version: 1,
    llm_id: null,
    diffusion_model_id: null,
    embedding_model_id: null,
    nai_diffusion_model_id: null,
    video_model_id: null,
    vision_llm_id: null,
    nai_preset_name: null,
    llm_temperature: 0.7,
    llm_min_p: 0.05,
    llm_top_p: 0.95,
    llm_top_k: 40,
    llm_frequency_penalty: 0.1,
    llm_presence_penalty: 0.2,
    llm_max_output_tokens: 4096,
    llm_disabled_params: [],
    llm_logit_biases: [],
    thinking_level: "auto",
    fallback_model_refs: [],
  };
}

function makeParametersView(textProviders: string[]): ConfigParametersView {
  const selectedProvider = textProviders[0] ?? null;
  return {
    textProviders,
    selectedProvider,
    selectedConfig: selectedProvider ? makeConfig(selectedProvider) : null,
    stopStrings: [],
    speakerPatternEnabled: false,
    logitBiasEntries: [],
    logitBiasPageStart: 0,
  };
}

function makeNaiPreset(name: string, target: "kayra" | "erato" = "kayra") {
  return {
    nai_preset_id: 1,
    preset_name: name,
    model_target: target,
    is_default: false,
    preset_desc: `English description for ${name}`,
    ja_preset_desc: `Japanese description for ${name}`,
    parameters: {},
  };
}

describe("configModelsPanel parameters block", () => {
  beforeAll(async () => initializeLocalizer());

  it("renders a provider select menu, summary values, and edit buttons when multiple providers exist", () => {
    const components = buildConfigModelsBody({
      locale: "en-US",
      page: "parameters",
      readStatus: "fresh",
      parametersView: makeParametersView(["openrouter", "anthropic"]),
    });
    const flat = flattenComponents(components);

    const selectRow = components.find(
      (component): component is ActionRowData<StringSelectMenuComponentData> =>
        component.type === ComponentType.ActionRow &&
        component.components.length === 1 &&
        component.components[0].type === ComponentType.StringSelect,
    );
    expect(selectRow).toBeDefined();
    expect(selectRow?.components[0].options.length).toBe(2);

    const summaryDisplay = flat.find(
      (component): component is TextDisplayComponentData =>
        component.type === ComponentType.TextDisplay &&
        component.content.includes("Sampling:") &&
        component.content.includes("`0.7`") &&
        component.content.includes("Generation:") &&
        component.content.includes("`0.1`"),
    );
    expect(summaryDisplay).toBeDefined();

    const editorButtonRow = components.find(
      (component): component is ActionRowData<ButtonComponentData> =>
        component.type === ComponentType.ActionRow &&
        component.components.length === 2 &&
        component.components.some(
          (btn) => typeof btn.customId === "string" && btn.customId.includes("sampling-open"),
        ) &&
        component.components.some(
          (btn) => typeof btn.customId === "string" && btn.customId.includes("generation-open"),
        ),
    );
    expect(editorButtonRow).toBeDefined();

    const samplingButton = flat.find(
      (component): component is ButtonComponentData =>
        component.type === ComponentType.Button &&
        typeof component.customId === "string" &&
        component.customId.includes("sampling-open"),
    );
    const generationButton = flat.find(
      (component): component is ButtonComponentData =>
        component.type === ComponentType.Button &&
        typeof component.customId === "string" &&
        component.customId.includes("generation-open"),
    );
    expect(samplingButton).toBeDefined();
    expect(generationButton).toBeDefined();
  });

  it("renders a static provider line without a select menu and keeps edit buttons when exactly one provider exists", () => {
    const provider = "openrouter";
    const components = buildConfigModelsBody({
      locale: "en-US",
      page: "parameters",
      readStatus: "fresh",
      parametersView: makeParametersView([provider]),
    });
    const flat = flattenComponents(components);

    const displayName = getProviderDisplayName(provider);
    const staticProviderDisplay = flat.find(
      (component): component is TextDisplayComponentData =>
        component.type === ComponentType.TextDisplay &&
        component.content.startsWith("> ") &&
        component.content.includes(`\`${displayName}\``),
    );
    expect(staticProviderDisplay).toBeDefined();

    const stringSelects = flat.filter((component) => component.type === ComponentType.StringSelect);
    expect(stringSelects).toHaveLength(0);

    const samplingButton = flat.find(
      (component): component is ButtonComponentData =>
        component.type === ComponentType.Button &&
        typeof component.customId === "string" &&
        component.customId.includes("sampling-open"),
    );
    const generationButton = flat.find(
      (component): component is ButtonComponentData =>
        component.type === ComponentType.Button &&
        typeof component.customId === "string" &&
        component.customId.includes("generation-open"),
    );
    expect(samplingButton).toBeDefined();
    expect(generationButton).toBeDefined();
  });

  it("renders the no-providers message and omits edit buttons when zero providers exist", () => {
    const components = buildConfigModelsBody({
      locale: "en-US",
      page: "parameters",
      readStatus: "fresh",
      parametersView: makeParametersView([]),
    });
    const flat = flattenComponents(components);

    const samplingButton = flat.find(
      (component): component is ButtonComponentData =>
        component.type === ComponentType.Button &&
        typeof component.customId === "string" &&
        component.customId.includes("sampling-open"),
    );
    const generationButton = flat.find(
      (component): component is ButtonComponentData =>
        component.type === ComponentType.Button &&
        typeof component.customId === "string" &&
        component.customId.includes("generation-open"),
    );
    expect(samplingButton).toBeUndefined();
    expect(generationButton).toBeUndefined();

    const noProvidersMessage = localizer("en-US", "commands.config.panel.parameters_no_providers");
    const noProvidersDisplay = flat.find(
      (component): component is TextDisplayComponentData =>
        component.type === ComponentType.TextDisplay && component.content === noProvidersMessage,
    );
    expect(noProvidersDisplay).toBeDefined();
  });

  it("renders the compatible NovelAI preset block with the active preset and bounded navigation", () => {
    const presets = Array.from({ length: 27 }, (_entry, index) => makeNaiPreset(`preset-${index + 1}`));
    const components = buildConfigModelsBody({
      locale: "en-US",
      page: "parameters",
      readStatus: "fresh",
      parametersView: {
        ...makeParametersView(["novelai"]),
        naiPresetView: {
          target: "kayra",
          compatibility: "eligible",
          presets,
          activePresetName: "preset-24",
          fingerprint: computeNaiPresetFingerprint(
            "kayra",
            presets.map((preset) => preset.preset_name),
          ),
          pageStart: 0,
        },
      },
    });
    const flat = flattenComponents(components);
    const presetText = flat.find(
      (component): component is TextDisplayComponentData =>
        component.type === ComponentType.TextDisplay && component.content.includes("preset-24"),
    );
    expect(presetText).toBeDefined();

    const presetSelect = flat.find(
      (component): component is StringSelectMenuComponentData =>
        component.type === ComponentType.StringSelect && component.options.some((option) => option.value === "0"),
    );
    expect(presetSelect).toBeDefined();
    expect(presetSelect?.options).toHaveLength(25);
    expect(presetSelect?.options.some((option) => option.value === CONFIG_NAI_PRESET_NEXT_VALUE)).toBe(true);
  });

  it("keeps the preset block visible but disabled with the compatibility explanation", () => {
    const components = buildConfigModelsBody({
      locale: "en-US",
      page: "parameters",
      readStatus: "fresh",
      parametersView: {
        ...makeParametersView(["google"]),
        naiPresetView: {
          target: null,
          compatibility: "not-novelai",
          presets: [],
          activePresetName: null,
          fingerprint: null,
          pageStart: 0,
        },
      },
    });
    const flat = flattenComponents(components);
    expect(
      flat.some(
        (component) =>
          component.type === ComponentType.TextDisplay &&
          component.content.includes(localizer("en-US", "commands.config.panel.nai_preset.not_novelai_description")),
      ),
    ).toBe(true);
    const disabledSelect = flat.find(
      (component): component is StringSelectMenuComponentData => component.type === ComponentType.StringSelect,
    );
    expect(disabledSelect?.disabled).toBe(true);
  });
});
