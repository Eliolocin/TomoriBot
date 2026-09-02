import { describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { UserSavedProviderConfigRow } from "@/types/db/schema";
import { buildParameters1Modal, buildParameters2Modal } from "@/utils/discord/ui/personalConfigModals";
import {
  buildProviderParameterBlock,
  type ProviderParameterBlockCopy,
  type ProviderParameterBlockInput,
} from "@/utils/discord/ui/personalConfigParameterControls";
import { initializeLocalizer } from "@/utils/text/localizer";

await initializeLocalizer();

const copy: ProviderParameterBlockCopy = {
  providerLabel: "Provider",
  providerSelectPlaceholder: "Select provider...",
  samplingLabel: "Sampling",
  temperatureLabel: "Temperature",
  minPLabel: "Min P",
  topPLabel: "Top P",
  topKLabel: "Top K",
  generationLabel: "Generation",
  frequencyLabel: "Frequency",
  presenceLabel: "Presence",
  maxOutputLabel: "Max output",
  thinkingLabel: "Thinking",
  editSamplingLabel: "Edit Sampling",
  editGenerationLabel: "Edit Generation",
};

const values: ProviderParameterBlockInput["values"] = {
  providerDisplayName: "OpenRouter",
  temperature: "0.7",
  minP: "0.05",
  topP: "0.95",
  topK: "0",
  frequency: "0",
  presence: "0",
  maxOutput: "4096",
  thinking: "auto",
};

const routes = {
  providerSelect: "provider-select",
  editSampling: "sampling-open",
  editGeneration: "generation-open",
};

function buildBlock(providerOptions: ProviderParameterBlockInput["providerOptions"], writesDisabled = false) {
  return buildProviderParameterBlock({ copy, values, routes, providerOptions, writesDisabled });
}

describe("personal provider parameter controls", () => {
  it("groups summaries, adapts provider chrome, and disables writes without hiding values", () => {
    expect(buildBlock([])).toEqual([]);

    const several = buildBlock([
      { value: "openrouter", label: "OpenRouter", default: true },
      { value: "novelai", label: "NovelAI", default: false },
    ]);
    expect(several.map((component) => component.type)).toEqual([
      ComponentType.ActionRow,
      ComponentType.TextDisplay,
      ComponentType.ActionRow,
    ]);

    const severalSelect = several[0] as { components: Array<{ type: number; customId?: string; options?: unknown[] }> };
    expect(severalSelect.components[0]).toMatchObject({
      type: ComponentType.StringSelect,
      customId: "provider-select",
    });
    expect(severalSelect.components[0].options).toEqual([
      { value: "openrouter", label: "OpenRouter", default: true },
      { value: "novelai", label: "NovelAI", default: false },
    ]);

    const summary = several[1] as { content: string };
    expect(summary.content.split("\n")).toEqual([
      "> Sampling: Temperature `0.7` · Min P `0.05`",
      "> Top P `0.95` · Top K `0`",
      "> Generation: Frequency `0` · Presence `0`",
      "> Max output `4096` · Thinking `auto`",
    ]);

    const one = buildBlock([{ value: "openrouter", label: "OpenRouter", default: true }]);
    expect(one.map((component) => component.type)).toEqual([
      ComponentType.TextDisplay,
      ComponentType.TextDisplay,
      ComponentType.ActionRow,
    ]);
    expect((one[0] as { content: string }).content).toBe("> Provider: `OpenRouter`");
    expect(one.some((component) => JSON.stringify(component).includes("provider-select"))).toBe(false);

    const disabled = buildBlock(
      [
        { value: "openrouter", label: "OpenRouter", default: true },
        { value: "novelai", label: "NovelAI", default: false },
      ],
      true,
    );
    const disabledJson = JSON.stringify(disabled);
    expect(disabledJson).toContain("Max output `4096`");
    expect((disabled[0] as { components: Array<{ disabled?: boolean }> }).components[0].disabled).toBe(true);
    expect(
      (disabled[2] as { components: Array<{ disabled?: boolean }> }).components.map((component) => component.disabled),
    ).toEqual([true, true]);
  });

  /**
   * The sampler columns are Postgres `real`, so `Math.fround` is what the driver hands back after a
   * round trip: a typed 0.6 returns as 0.6000000238418579. Discord rejects the whole modal with
   * 50035 when any prefilled value exceeds its own `max_length`, so the prefill is measured against
   * the limit the same payload declares rather than against a constant repeated here.
   */
  it("keeps prefilled sampler values inside each field's own max_length after a float4 round trip", () => {
    const roundTripped = {
      provider: "deepseek",
      llm_temperature: Math.fround(0.6),
      llm_min_p: Math.fround(0.05),
      llm_top_p: Math.fround(0.95),
      llm_top_k: 40,
      llm_frequency_penalty: Math.fround(0.2),
      llm_presence_penalty: Math.fround(0.7),
      llm_max_output_tokens: 131072,
      thinking_level: "auto",
    } as unknown as UserSavedProviderConfigRow;

    const overflows = [
      buildParameters1Modal("en-US", "nonce123456", "deepseek", roundTripped),
      buildParameters2Modal("en-US", "nonce123456", "deepseek", roundTripped),
    ].flatMap((modal) =>
      modal.components
        .map((wrapper) => wrapper.component)
        .filter((component) => typeof component?.value === "string" && typeof component?.max_length === "number")
        .filter((component) => (component?.value as string).length > (component?.max_length as number))
        .map((component) => `${component?.custom_id}=${component?.value}`),
    );

    expect(overflows).toEqual([]);
  });

  it("emits four semantic modal fields with the required raw component types", () => {
    const currentConfig = {
      provider: "openrouter",
      llm_temperature: 0.7,
      llm_min_p: 0.05,
      llm_top_p: 0.95,
      llm_top_k: 0,
      llm_frequency_penalty: 0,
      llm_presence_penalty: 0,
      llm_max_output_tokens: 4096,
      thinking_level: "auto",
    } as unknown as UserSavedProviderConfigRow;

    const sampling = buildParameters1Modal("en-US", "nonce123456", "openrouter", currentConfig);
    expect(sampling.title).toBe("Edit Sampling");
    expect(sampling.components).toHaveLength(4);
    expect(sampling.components.every((component) => component.type === 18)).toBe(true);
    expect(sampling.components.map((component) => component.component?.type)).toEqual([4, 4, 4, 4]);
    expect(sampling.components.map((component) => component.component?.custom_id)).toEqual([
      "temperature_nonce123456",
      "min_p_nonce123456",
      "top_p_nonce123456",
      "top_k_nonce123456",
    ]);

    const generation = buildParameters2Modal("en-US", "nonce123456", "openrouter", currentConfig);
    expect(generation.title).toBe("Edit Generation");
    expect(generation.components).toHaveLength(4);
    expect(generation.components.every((component) => component.type === 18)).toBe(true);
    expect(generation.components.map((component) => component.component?.type)).toEqual([4, 4, 4, 21]);
    expect(generation.components.map((component) => component.component?.custom_id)).toEqual([
      "frequency_penalty_nonce123456",
      "presence_penalty_nonce123456",
      "max_output_tokens_nonce123456",
      "thinking_level_nonce123456",
    ]);
  });
});
