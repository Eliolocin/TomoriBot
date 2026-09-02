import type { RadioGroupOption } from "@/types/discord/modal";
import { localizer } from "@/utils/text/localizer";

export const HUMANIZER_MIN = 0;
export const HUMANIZER_MAX = 3;
export const HUMANIZER_DEFAULT = 1;
export const HUMANIZER_INHERIT_VALUE = "inherit";

export function createHumanizerOptions(
  locale: string,
  selectedValue: string,
  includeInherit: boolean,
): RadioGroupOption[] {
  const options: RadioGroupOption[] = [
    {
      label: localizer(locale, "commands.config.humanizer.choice_none"),
      value: "0",
      description: localizer(locale, "commands.config.humanizer.desc_none"),
    },
    {
      label: localizer(locale, "commands.config.humanizer.choice_light"),
      value: "1",
      description: localizer(locale, "commands.config.humanizer.desc_light"),
    },
    {
      label: localizer(locale, "commands.config.humanizer.choice_medium"),
      value: "2",
      description: localizer(locale, "commands.config.humanizer.desc_medium"),
    },
    {
      label: localizer(locale, "commands.config.humanizer.choice_heavy"),
      value: "3",
      description: localizer(locale, "commands.config.humanizer.desc_heavy"),
    },
  ];

  if (includeInherit) {
    options.unshift({
      label: localizer(locale, "commands.config.humanizer.choice_inherit"),
      value: HUMANIZER_INHERIT_VALUE,
      description: localizer(locale, "commands.config.humanizer.desc_inherit"),
    });
  }

  return options.map((option) => ({ ...option, default: option.value === selectedValue }));
}

export function getHumanizerLabel(locale: string, value: number | null): string {
  const key =
    value === null
      ? "commands.config.humanizer.choice_inherit"
      : value === 0
        ? "commands.config.humanizer.choice_none"
        : value === 1
          ? "commands.config.humanizer.choice_light"
          : value === 2
            ? "commands.config.humanizer.choice_medium"
            : "commands.config.humanizer.choice_heavy";
  return localizer(locale, key);
}
