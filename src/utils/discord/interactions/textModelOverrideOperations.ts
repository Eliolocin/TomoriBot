import { llmOverrideRepo } from "@/utils/db/repositories";

export type TextModelOverrideInput =
  | {
      scope: "persona";
      personaId: number;
      llmId: number | null;
      serverDiscId?: string;
    }
  | {
      scope: "channel";
      serverId: number;
      channelId: string;
      llmId: number | null;
      serverDiscId?: string;
    };

export async function setTextModelOverride(input: TextModelOverrideInput): Promise<boolean> {
  if (input.scope === "persona") {
    return llmOverrideRepo.setPersonaLlmOverride(input.personaId, input.llmId, {
      serverDiscId: input.serverDiscId,
    });
  }

  return input.llmId === null
    ? llmOverrideRepo.deleteChannelLlmOverride(input.serverId, input.channelId, {
        serverDiscId: input.serverDiscId,
      })
    : llmOverrideRepo.setChannelLlmOverride(input.serverId, input.channelId, input.llmId, {
        serverDiscId: input.serverDiscId,
      });
}
