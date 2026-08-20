import { createConditioningInteractionCommand } from "@/utils/conditioning/conditioningInteractionCommand";

/** Tickle reward: tickle the bot and trigger a response */
export const { configureSubcommand, execute, autocomplete } = createConditioningInteractionCommand("reward", "tickle");
