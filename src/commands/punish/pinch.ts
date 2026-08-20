import { createConditioningInteractionCommand } from "@/utils/conditioning/conditioningInteractionCommand";

export const { configureSubcommand, execute, autocomplete } = createConditioningInteractionCommand("punish", "pinch");
