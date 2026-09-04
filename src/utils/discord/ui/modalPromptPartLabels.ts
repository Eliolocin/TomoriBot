import { localizer } from "@/utils/text/localizer";
import { safeSelectOptionText } from "@/utils/discord/ui/interactionCore";

const MODAL_LABEL_MAX_LENGTH = 45;
const MODAL_DESCRIPTION_MAX_LENGTH = 99;

/**
 * Label for one field of a prompt that Discord's 4,000-character text input forces us to split.
 * @param nameKey - Locale key naming the whole prompt, not the part.
 * @param index - Zero-based field position; the rendered label counts from one.
 */
export function promptPartLabel(locale: string, nameKey: string, index: number, total: number): string {
  return safeSelectOptionText(
    localizer(locale, "commands.config.panel.prompt_part_label", {
      name: localizer(locale, nameKey),
      index: index + 1,
      total,
    }),
    MODAL_LABEL_MAX_LENGTH,
  );
}

/**
 * Description for one split-prompt field: the first states why the split exists, the rest name the
 * part they continue so a reader does not treat them as separate prompts.
 */
export function promptPartDescription(locale: string, index: number): string {
  return safeSelectOptionText(
    index === 0
      ? localizer(locale, "commands.config.panel.prompt_part_first_description")
      : localizer(locale, "commands.config.panel.prompt_part_continued_description", { previous: index }),
    MODAL_DESCRIPTION_MAX_LENGTH,
  );
}
