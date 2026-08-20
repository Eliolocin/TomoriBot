import type { SlashCommandSubcommandBuilder } from "discord.js";
import { createConditioningInteractionCommand } from "@/utils/conditioning/conditioningInteractionCommand";
import { localizer } from "@/utils/text/localizer";
import { CONDITIONING_REASON_MAX_LENGTH } from "@/utils/conditioning/conditioning";

const { execute, autocomplete } = createConditioningInteractionCommand("reward", "feed", {
  getExtraContext: (interaction) => {
    const food = interaction.options.getString("food")?.trim();
    return {
      food_text: food ? ` \`${food}\`` : "",
      action_text: food ?? "",
    };
  },
});

export function configureSubcommand(subcommand: SlashCommandSubcommandBuilder) {
  return subcommand
    .setName("feed")
    .setDescription(localizer("en-US", "commands.reward.feed.description"))
    .addStringOption((option) =>
      option
        .setName("food")
        .setDescription(localizer("en-US", "commands.reward.feed.food_description"))
        .setMaxLength(CONDITIONING_REASON_MAX_LENGTH)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("persona")
        .setDescription(localizer("en-US", "commands.reward.feed.persona_description"))
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription(localizer("en-US", "commands.reward.feed.reason_description"))
        .setMaxLength(CONDITIONING_REASON_MAX_LENGTH)
        .setRequired(false),
    );
}

export { execute, autocomplete };
