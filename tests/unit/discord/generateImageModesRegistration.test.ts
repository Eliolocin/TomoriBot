/**
 * Locks in the `/generate image` consolidation surface. The contextual image flow used to live at
 * `/tool visualize`; after consolidation it must be absent there and exposed through one required,
 * localized mode selector on `/generate image`.
 *
 * Checking the registered payload, rather than only locale keys, catches a subtle failure where the
 * English builder text ships unchanged because commandLoader has no matching option/choice key to
 * attach Japanese localizations to.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationChoice = {
  name: string;
  value: string;
  name_localizations?: Record<string, string> | null;
};

type RegistrationOption = {
  name: string;
  type: number;
  description?: string;
  description_localizations?: Record<string, string> | null;
  required?: boolean;
  choices?: RegistrationChoice[];
  options?: RegistrationOption[];
};

describe("/generate image mode registration", () => {
  it("removes /tool visualize while retaining /generate image", async () => {
    const { executionMap } = await loadCommandData();

    expect(executionMap.get("tool")?.has("visualize")).toBe(false);
    expect(executionMap.get("generate")?.has("image")).toBe(true);
  }, 30000);

  it("registers one required manual/auto mode selector with Japanese localizations", async () => {
    const { registrationData } = await loadCommandData();
    const generate = registrationData.find((command) => command.name === "generate") as
      | { options?: RegistrationOption[] }
      | undefined;
    const image = generate?.options?.find((option) => option.name === "image");
    const mode = image?.options?.find((option) => option.name === "mode");

    expect(image).toBeDefined();
    expect(mode).toBeDefined();
    expect(mode?.type).toBe(ApplicationCommandOptionType.String);
    expect(mode?.required).toBe(true);
    expect(mode?.description).toBe(localizer("en-US", "commands.generate.image.mode_description"));
    expect(mode?.description_localizations?.ja).toBe(localizer("ja", "commands.generate.image.mode_description"));

    const manual = mode?.choices?.find((choice) => choice.value === "manual");
    const auto = mode?.choices?.find((choice) => choice.value === "auto");

    expect(mode?.choices?.map((choice) => choice.value)).toEqual(["manual", "auto"]);
    expect(manual?.name).toBe(localizer("en-US", "commands.generate.image.mode_choice_manual"));
    expect(manual?.name_localizations?.ja).toBe(localizer("ja", "commands.generate.image.mode_choice_manual"));
    expect(auto?.name).toBe(localizer("en-US", "commands.generate.image.mode_choice_auto"));
    expect(auto?.name_localizations?.ja).toBe(localizer("ja", "commands.generate.image.mode_choice_auto"));
  }, 30000);
});
