import { getCachedActivePreset } from "@/utils/cache/stPresetCache";
import { personaRepository } from "@/utils/db/repositories";
import { MessageIdMap } from "@/utils/text/messageIdMap";
import { reassembleWithPreset } from "@/utils/text/presetContextBuilder";
import { createToolPromptMacroResolver, resolvePromptCapabilityValues } from "@/utils/tools/toolPromptMacros";
import { buildContextNative } from "./nativeBuilder";
import { resolveRandomChoiceMacrosInBuildOutput } from "./templates";
import type { BuildContextParams, BuildContextResult } from "./types";

/**
 * Builds model context, applying SillyTavern preset reassembly when one is active.
 */
export async function buildContext(params: BuildContextParams): Promise<BuildContextResult> {
  const messageIdMap = params.messageIdMap ?? new MessageIdMap();
  const paramsWithMap = { ...params, messageIdMap };

  if (!paramsWithMap.isUserImpersonation) {
    const tomoriStateForPreset = params.snapshot?.tomoriState ?? (await personaRepository.loadState(params.guildId));
    const serverId = tomoriStateForPreset?.server_id;
    if (serverId) {
      const presetData = await getCachedActivePreset(serverId);
      if (presetData) {
        const nativeOutput = await buildContextNative({
          ...paramsWithMap,
          suppressDefaultSystemPrompt: !params.tomoriConfig.system_prompt?.trim(),
        });

        const lastUserMessage =
          params.simplifiedMessageHistory.filter((message) => message.authorType === "user").at(-1)?.content ?? "";
        const presetToolPromptMacroResolver = createToolPromptMacroResolver({
          provider: tomoriStateForPreset?.llm?.llm_provider,
          capabilities: resolvePromptCapabilityValues(params.tomoriConfig),
          deliberateToolAllowedNames: params.deliberateToolAllowedNames,
          stateForContext:
            tomoriStateForPreset?.server_id && tomoriStateForPreset.llm
              ? {
                  server_id: tomoriStateForPreset.server_id.toString(),
                  activePersonaHasElevenlabsVoice: false,
                  llm: tomoriStateForPreset.llm,
                  diffusion_model_id: tomoriStateForPreset.config.diffusion_model_id,
                  nai_diffusion_model_id: tomoriStateForPreset.config.nai_diffusion_model_id,
                  video_model_id: tomoriStateForPreset.config.video_model_id,
                  config: {
                    sticker_usage_enabled: params.tomoriConfig.sticker_usage_enabled,
                    web_search_enabled: params.tomoriConfig.web_search_enabled,
                    self_teaching_enabled: params.tomoriConfig.self_teaching_enabled,
                    manage_message_enabled: params.tomoriConfig.manage_message_enabled,
                    imagegen_enabled: params.tomoriConfig.imagegen_enabled,
                    videogen_enabled: params.tomoriConfig.videogen_enabled,
                    voice_message_enabled: params.tomoriConfig.voice_message_enabled,
                    user_blocking_enabled: params.tomoriConfig.user_blocking_enabled,
                    user_info_updates_enabled: params.tomoriConfig.user_info_updates_enabled,
                    thread_creation_enabled: params.tomoriConfig.thread_creation_enabled,
                  },
                }
              : undefined,
        });

        const presetResult = await reassembleWithPreset(
          nativeOutput,
          presetData,
          {
            triggererName: params.triggererName,
            tomoriNickname: params.tomoriNickname,
            tomoriAttributes: params.tomoriAttributes,
            personaPrompt: params.personaPrompt,
            sampleDialoguesIn: tomoriStateForPreset?.sample_dialogues_in ?? [],
            sampleDialoguesOut: tomoriStateForPreset?.sample_dialogues_out ?? [],
            lastUserMessage,
          },
          {
            client: params.client,
            guildId: params.guildId,
            triggererName: params.triggererName,
            triggererFormattedName: params.triggererFormattedName,
            triggererAddressTerm: params.triggererAddressTerm,
            botName: params.tomoriNickname,
            personalMemoriesEnabled: params.tomoriConfig.personal_memories_enabled ?? true,
            toolPromptMacroResolver: presetToolPromptMacroResolver,
          },
        );
        return { ...resolveRandomChoiceMacrosInBuildOutput(presetResult), messageIdMap };
      }
    }
  }

  const nativeResult = await buildContextNative(paramsWithMap);
  return { ...resolveRandomChoiceMacrosInBuildOutput(nativeResult), messageIdMap };
}
