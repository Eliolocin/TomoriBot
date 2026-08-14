import { OpenAICompatibleToolAdapter } from "@/providers/openaiCompatible/openaiCompatibleToolAdapter";
import { type ToolStateForContext, getAvailableToolsWithMCP } from "@/tools/toolRegistry";
import { log } from "@/utils/misc/logger";
import { shouldInjectVerbatimToolCallingNudge } from "@/utils/tools/verbatimToolCalling";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import type { AssembledServerConfig, TomoriState } from "@/types/db/schema";

/**
 * Header text placed above the serialized tool schemas. Kept terse because the
 * accompanying verbatim nudge (injected near the dialogue tail) already carries
 * the full calling-format instructions; this block only supplies the schemas.
 */
const VERBATIM_TOOL_DEFINITIONS_HEADER =
  'The following tools are available to you in verbatim tool-calling mode. These are the only callable tools, shown with their exact JSON parameter schemas. To use one, output a single verbatim tool call as described in your tool-calling instructions, for example: `tool_name({"arg":"value"})`.';

/**
 * Builds the OpenAI-compatible tool-schema JSON for the active state, mirroring
 * how `CustomProvider.getTools` assembles `config.tools` at request time.
 *
 * Mirrors the recipe used by `/tool prompt snapshot` (`fetchProviderTools`):
 *   1. Assemble the minimal {@link ToolStateForContext} from the live persona state.
 *   2. Ask the registry which built-in tools + MCP functions pass feature-flag gates.
 *   3. Route both through the OpenAI-compatible adapter to get full native schemas
 *      (built-in + global MCP + guild MCP), exactly matching what the model is sent.
 *
 * @param tomoriState - Active persona/server state used for tool availability gating.
 * @returns Provider-native tool JSON array, or an empty array when none apply.
 */
async function buildVerbatimToolDefinitionsJson(tomoriState: TomoriState): Promise<Array<Record<string, unknown>>> {
  // Build the minimal availability state (mirrors every <Provider>.getTools block).
  const provider = tomoriState.llm.llm_provider;
  const toolStateForContext: ToolStateForContext = {
    server_id: tomoriState.server_id.toString(),
    activePersonaHasElevenlabsVoice: Boolean(
      tomoriState.speech_voice_sample_id ||
        tomoriState.speech_voice_design_prompt?.trim() ||
        tomoriState.speech_voice_id?.trim(),
    ),
    activePersonaVoiceDesignPrompt: tomoriState.speech_voice_design_prompt?.trim() || null,
    activePersonaVoiceName: tomoriState.speech_voice_name,
    llm: {
      llm_codename: tomoriState.llm.llm_codename,
      has_tools: tomoriState.llm.has_tools,
      sees_images: tomoriState.llm.sees_images,
      sees_videos: tomoriState.llm.sees_videos,
      sees_youtube: tomoriState.llm.sees_youtube,
      supports_structoutput: tomoriState.llm.supports_structoutput,
    },
    diffusion_model_id: tomoriState.config.diffusion_model_id,
    nai_diffusion_model_id: tomoriState.config.nai_diffusion_model_id,
    video_model_id: tomoriState.config.video_model_id,
    config: {
      sticker_usage_enabled: tomoriState.config.sticker_usage_enabled,
      web_search_enabled: tomoriState.config.web_search_enabled,
      self_teaching_enabled: tomoriState.config.self_teaching_enabled,
      manage_message_enabled: tomoriState.config.manage_message_enabled,
      imagegen_enabled: tomoriState.config.imagegen_enabled,
      videogen_enabled: tomoriState.config.videogen_enabled,
      voice_message_enabled: tomoriState.config.voice_message_enabled,
      user_blocking_enabled: tomoriState.config.user_blocking_enabled,
      user_info_updates_enabled: tomoriState.config.user_info_updates_enabled,
      thread_creation_enabled: tomoriState.config.thread_creation_enabled,
    },
  };

  // Feature-flag-gated built-in tools + allowed MCP function names.
  const { builtInTools, mcpFunctionNames } = await getAvailableToolsWithMCP(provider, toolStateForContext);

  // Serialize to full native schemas (built-in + global/guild MCP) via the
  //    OpenAI-compatible adapter: the same shape that lands in `config.tools`.
  const adapter = new OpenAICompatibleToolAdapter(provider);
  return adapter.getAllToolsInProviderFormat(builtInTools, tomoriState.server_id, mcpFunctionNames);
}

/**
 *
 * Only emitted when the verbatim tool-calling workaround is enabled and the
 * active model is tool-capable (gated identically to the verbatim nudge so the
 * schema dump and the behavioral nudge are always switched on together). When
 * enabled, the resolved tool set is serialized to JSON and embedded in-band so
 * endpoints that ignore the native `tools` field still expose the schemas to
 * the model.
 *
 * @param params.tomoriConfig - Assembled server config (verbatim toggle source).
 * @param params.tomoriState - Active persona/server state, or null when unavailable.
 * @returns A structured context item, or null when the workaround is off / no tools apply.
 */
export async function buildVerbatimToolDefinitionsContextItem(params: {
  tomoriConfig: AssembledServerConfig;
  tomoriState: TomoriState | null | undefined;
}): Promise<StructuredContextItem | null> {
  try {
    const { tomoriConfig, tomoriState } = params;
    if (!shouldInjectVerbatimToolCallingNudge(tomoriConfig, tomoriState) || !tomoriState) {
      return null;
    }

    const tools = await buildVerbatimToolDefinitionsJson(tomoriState);
    if (tools.length === 0) {
      return null;
    }

    const toolsJson = JSON.stringify(tools, null, 2);
    const text = `${VERBATIM_TOOL_DEFINITIONS_HEADER}\n\nAvailable tools (JSON):\n\`\`\`json\n${toolsJson}\n\`\`\``;

    return {
      role: "user",
      parts: [{ type: "text", text }],
      metadataTag: ContextItemTag.KNOWLEDGE_VERBATIM_TOOL_DEFINITIONS,
    };
  } catch (error) {
    log.warn("Failed to add verbatim tool definitions context", error);
    return null;
  }
}
