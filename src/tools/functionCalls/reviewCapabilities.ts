import { ApplicationCommandOptionType, PermissionsBitField, type ApplicationCommandData } from "discord.js";
import { ToolRegistry, type ToolStateForContext } from "@/tools/toolRegistry";
import type { Tool } from "@/types/tool/interfaces";
import { BaseTool, type ToolContext, type ToolParameterSchema, type ToolResult } from "@/types/tool/interfaces";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { log } from "@/utils/misc/logger";
import { getLlmDisplayName } from "@/utils/provider/modelDisplay";

interface ToolSnapshot {
  builtInTools: Tool[];
  mcpFunctionNames: string[];
}

interface CommandOptionShape {
  type?: number;
  name?: string;
  description?: string;
  options?: CommandOptionShape[];
}

function buildToolAssemblyState(context: ToolContext): ToolStateForContext {
  const { config, llm } = context.tomoriState;
  return {
    server_id: context.tomoriState.server_id.toString(),
    activePersonaHasElevenlabsVoice: Boolean(
      context.tomoriState.speech_voice_sample_id ||
        context.tomoriState.speech_voice_design_prompt?.trim() ||
        context.tomoriState.speech_voice_id?.trim(),
    ),
    activePersonaVoiceDesignPrompt: context.tomoriState.speech_voice_design_prompt?.trim() || null,
    activePersonaVoiceName: context.tomoriState.speech_voice_name,
    diffusion_model_id: config.diffusion_model_id,
    nai_diffusion_model_id: config.nai_diffusion_model_id,
    video_model_id: config.video_model_id,
    llm: {
      llm_codename: llm.llm_codename,
      has_tools: llm.has_tools,
      sees_images: llm.sees_images,
      sees_videos: llm.sees_videos,
      sees_youtube: llm.sees_youtube,
      supports_structoutput: llm.supports_structoutput,
    },
    config: {
      sticker_usage_enabled: config.sticker_usage_enabled,
      web_search_enabled: config.web_search_enabled,
      self_teaching_enabled: config.self_teaching_enabled,
      manage_message_enabled: config.manage_message_enabled,
      imagegen_enabled: config.imagegen_enabled,
      videogen_enabled: config.videogen_enabled,
      voice_message_enabled: config.voice_message_enabled ?? true,
      user_blocking_enabled: config.user_blocking_enabled ?? true,
      thread_creation_enabled: config.thread_creation_enabled,
    },
  };
}

async function loadToolSnapshot(context: ToolContext): Promise<ToolSnapshot> {
  const liveBuiltInTools = ToolRegistry.getAvailableTools(context.provider, context);
  const assembled = await ToolRegistry.getAvailableToolsWithMCP(context.provider, buildToolAssemblyState(context));
  const assembledBuiltInNames = new Set(assembled.builtInTools.map((tool) => tool.name));

  return {
    builtInTools: liveBuiltInTools.filter((tool) => assembledBuiltInNames.has(tool.name)),
    mcpFunctionNames: assembled.mcpFunctionNames,
  };
}

function formatToolList(tools: Tool[]): string {
  const categories = new Map<string, string[]>();
  for (const tool of tools) {
    const names = categories.get(tool.category) ?? [];
    names.push(tool.name);
    categories.set(tool.category, names);
  }

  return [...categories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([category, names]) =>
        `- **${category}**: ${names
          .sort()
          .map((name) => `\`${name}\``)
          .join(", ")}`,
    )
    .join("\n");
}

function isCommandOptionShape(value: unknown): value is CommandOptionShape {
  return typeof value === "object" && value !== null;
}

function getCommandOptions(command: ApplicationCommandData): CommandOptionShape[] {
  if (!("options" in command) || !Array.isArray(command.options)) return [];
  return command.options.filter(isCommandOptionShape);
}

/** Formats the same registration payload sent to Discord, so discovery cannot drift from runtime commands. */
export function formatCommandCapabilities(registrationData: ApplicationCommandData[]): {
  markdown: string;
  totalCommands: number;
  totalCategories: number;
} {
  const sections: string[] = [];
  let totalCommands = 0;

  for (const command of [...registrationData].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!("description" in command) || typeof command.description !== "string") continue;
    const description = command.description;
    const lines = [`## /${command.name}`, description, ""];
    const options = getCommandOptions(command);
    const commandOptions = options.filter(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand ||
        option.type === ApplicationCommandOptionType.SubcommandGroup,
    );

    if (commandOptions.length === 0) {
      lines.push(`- **/${command.name}** - ${description}`);
      totalCommands++;
    } else {
      for (const option of commandOptions) {
        if (option.type === ApplicationCommandOptionType.Subcommand && option.name) {
          lines.push(`- **/${command.name} ${option.name}** - ${option.description ?? description}`);
          totalCommands++;
          continue;
        }

        if (option.type !== ApplicationCommandOptionType.SubcommandGroup || !option.name) continue;
        for (const subcommand of option.options ?? []) {
          if (subcommand.type !== ApplicationCommandOptionType.Subcommand || !subcommand.name) continue;
          lines.push(
            `- **/${command.name} ${option.name} ${subcommand.name}** - ${subcommand.description ?? option.description ?? description}`,
          );
          totalCommands++;
        }
      }
    }

    sections.push(lines.join("\n"));
  }

  const markdown = [
    "# Your Slash Commands",
    "",
    "This is the command catalog currently registered with Discord. Server permissions may restrict who can run individual commands.",
    "",
    ...sections,
    "",
    "---",
    "",
    `**Total Commands**: ${totalCommands} slash commands across ${registrationData.length} top-level commands`,
    "",
  ].join("\n");

  return { markdown, totalCommands, totalCategories: registrationData.length };
}

export class ReviewCapabilitiesTool extends BaseTool {
  name = "review_capabilities";
  description =
    "Check your current model, runtime capabilities, available tools, settings, or registered Discord slash commands instead of guessing. Use chat for user-safe conversational capabilities, commands for the authoritative command catalog, and settings for detailed configuration. Operational settings are redacted unless the requesting member can manage the server.";
  category = "utility" as const;

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      capability_type: {
        type: "string",
        description:
          "Use 'chat' for current conversational abilities and tools, 'commands' for registered slash commands, or 'settings' for runtime feature configuration and disabled reasons.",
        enum: ["chat", "commands", "settings"],
      },
    },
    required: ["capability_type"],
  };

  isAvailableFor(_provider: string): boolean {
    return true;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      const reason =
        validation.errors?.join(", ") ||
        `Missing required parameters: ${validation.missingParams?.join(", ") ?? "capability_type"}`;
      return { success: false, error: `Invalid parameters: ${reason}`, data: { status: "invalid_parameters", reason } };
    }

    try {
      switch (args.capability_type) {
        case "chat":
          return await this.getChatCapabilities(context);
        case "commands":
          return await this.getSlashCommands();
        case "settings":
          return await this.getSettingsCapabilities(context);
        default:
          return {
            success: false,
            error: "Invalid capability type",
            data: { status: "invalid_capability_type", reason: "Expected chat, commands, or settings" },
          };
      }
    } catch (error) {
      log.error(`Error reviewing capabilities (type: ${String(args.capability_type)})`, error as Error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
        data: { status: "execution_error", reason: error instanceof Error ? error.message : "Unknown error" },
      };
    }
  }

  private async getChatCapabilities(context: ToolContext): Promise<ToolResult> {
    const { config, llm } = context.tomoriState;
    const snapshot = await loadToolSnapshot(context);
    const displayModelName = getLlmDisplayName(llm, config.custom_model_name);
    const builtInNames = new Set(snapshot.builtInTools.map((tool) => tool.name));
    const content: string[] = [
      "# Your Current Chat Capabilities",
      "",
      `- **Model**: ${displayModelName}`,
      `- **Provider**: ${llm.llm_provider}`,
      `- **Function calling**: ${llm.has_tools ? "supported" : "not supported"}`,
      `- **Image input**: ${llm.sees_images ? "supported" : "not supported"}`,
      `- **Video input**: ${llm.sees_videos ? "supported" : "not supported"}`,
      `- **YouTube input**: ${llm.sees_youtube ? "supported" : "not supported"}`,
      `- **Reasoning model**: ${llm.is_reasoning ? "yes" : "no"}`,
      "",
      "## Tools Available in This Runtime",
      "",
    ];

    if (snapshot.builtInTools.length === 0 && snapshot.mcpFunctionNames.length === 0) {
      content.push(
        "No tools are currently available for this provider, server configuration, channel, and requesting member.",
        "",
      );
    } else {
      if (snapshot.builtInTools.length > 0) {
        content.push(formatToolList(snapshot.builtInTools), "");
      }
      if (snapshot.mcpFunctionNames.length > 0) {
        content.push(
          `- **mcp**: ${[...snapshot.mcpFunctionNames]
            .sort()
            .map((name) => `\`${name}\``)
            .join(", ")}`,
          "",
        );
      }
    }

    content.push(
      "This inventory reflects runtime registration and availability checks. Deliberate-tool mode may expose only the tools relevant to the current request.",
      "",
      "## Memory and Knowledge",
      "",
      `- **Long-term memory writing**: ${builtInNames.has("create_long_term_memory") || builtInNames.has("update_long_term_memory") ? "available" : "unavailable"}`,
      `- **Short-term memory**: ${config.short_term_memory_enabled ? "enabled" : "disabled"}`,
      `- **Personal memories**: ${config.personal_memories_enabled ? "enabled" : "disabled"}`,
      `- **User info updates**: ${config.user_info_updates_enabled ? "enabled" : "disabled"}`,
      `- **Document knowledge base**: ${config.embedding_model_id ? "configured" : "not configured"}`,
      "",
      "## Generation and Discord Actions",
      "",
      `- **Image generation**: ${builtInNames.has("generate_image") || builtInNames.has("generate_image_nai") ? "available" : "unavailable"}`,
      `- **Video generation**: ${builtInNames.has("generate_video") ? "available" : "unavailable"}`,
      `- **Voice messages**: ${builtInNames.has("generate_voice_message") ? "available" : "unavailable"}`,
      `- **Message management**: ${builtInNames.has("manage_message") ? "available" : "unavailable"}`,
      `- **Thread creation**: ${builtInNames.has("create_thread") ? "available" : "unavailable"}`,
      "",
      "Current runtime state and assembled conversation context take precedence over general documentation.",
      "",
    );

    const message = content.join("\n");
    return {
      success: true,
      message,
      data: {
        status: "capabilities_retrieved",
        capability_type: "chat",
        model: displayModelName,
        provider: llm.llm_provider,
        built_in_tools: snapshot.builtInTools.map((tool) => tool.name),
        mcp_tools: snapshot.mcpFunctionNames,
        summary: message,
      },
    };
  }

  private async getSettingsCapabilities(context: ToolContext): Promise<ToolResult> {
    const { config, llm } = context.tomoriState;
    const snapshot = await loadToolSnapshot(context);
    const canViewOperationalDetails =
      context.message?.member?.permissions.has(PermissionsBitField.Flags.ManageGuild) ?? false;
    const displayModelName = getLlmDisplayName(llm, config.custom_model_name);
    const disabledFeatures = [
      ["web search", config.web_search_enabled],
      ["image generation", config.imagegen_enabled],
      ["video generation", config.videogen_enabled],
      ["voice messages", config.voice_message_enabled ?? true],
      ["short-term memory", config.short_term_memory_enabled],
      ["user info updates", config.user_info_updates_enabled],
      ["self teaching", config.self_teaching_enabled],
      ["message management", config.manage_message_enabled],
      ["thread creation", config.thread_creation_enabled],
    ].filter((entry): entry is [string, false] => entry[1] === false);

    const content = [
      "# Current Runtime Settings",
      "",
      `- **Model**: ${displayModelName}`,
      `- **Provider**: ${llm.llm_provider}`,
      `- **Tool calling**: ${llm.has_tools ? "supported" : "not supported by this model"}`,
      `- **Available tools**: ${snapshot.builtInTools.length + snapshot.mcpFunctionNames.length} (${snapshot.builtInTools.length} built-in, ${snapshot.mcpFunctionNames.length} MCP)`,
      "",
      "## Feature Flags",
      "",
      `- Web search: ${config.web_search_enabled ? "enabled" : "disabled"}`,
      `- Image generation: ${config.imagegen_enabled ? "enabled" : "disabled"}`,
      `- Video generation: ${config.videogen_enabled ? "enabled" : "disabled"}`,
      `- Voice messages: ${(config.voice_message_enabled ?? true) ? "enabled" : "disabled"}`,
      `- Short-term memory: ${config.short_term_memory_enabled ? "enabled" : "disabled"}`,
      `- Personal memories: ${config.personal_memories_enabled ? "enabled" : "disabled"}`,
      `- User info updates: ${config.user_info_updates_enabled ? "enabled" : "disabled"}`,
      `- Self teaching: ${config.self_teaching_enabled ? "enabled" : "disabled"}`,
      `- Message management: ${config.manage_message_enabled ? "enabled" : "disabled"}`,
      `- Thread creation: ${config.thread_creation_enabled ? "enabled" : "disabled"}`,
      "",
      "## Disabled Reasons",
      "",
      ...(disabledFeatures.length > 0
        ? disabledFeatures.map(([name]) => `- ${name}: disabled by server configuration`)
        : ["No feature flag listed above is disabled."]),
      ...(!llm.has_tools ? ["- Tool-dependent features: unavailable because the active model cannot call tools"] : []),
      "",
    ];

    if (canViewOperationalDetails) {
      content.push(
        "## Administrator Details",
        "",
        `- Server ID: ${context.tomoriState.server_id}`,
        `- Custom system prompt: ${config.system_prompt ? `configured (${config.system_prompt.length} characters)` : "not configured"}`,
        `- Standard image model slot: ${config.diffusion_model_id ? "configured" : "not configured"}`,
        `- NovelAI image model slot: ${config.nai_diffusion_model_id ? "configured" : "not configured"}`,
        `- Video model slot: ${config.video_model_id ? "configured" : "not configured"}`,
        `- Speech voice assignment: ${buildToolAssemblyState(context).activePersonaHasElevenlabsVoice ? "configured" : "not configured"}`,
        `- API key rotation pool: ${context.tomoriState.rotation_keys?.filter((key) => key.is_enabled).length ?? 0} enabled`,
        "",
      );
    } else {
      content.push(
        "Operational details such as credential state, rotation pools, internal identifiers, and prompt metadata are redacted. A member with Manage Server permission can request them.",
        "",
      );
    }

    const message = content.join("\n");
    return {
      success: true,
      message,
      data: {
        status: "settings_retrieved",
        capability_type: "settings",
        operational_details_visible: canViewOperationalDetails,
        summary: message,
      },
    };
  }

  private async getSlashCommands(): Promise<ToolResult> {
    const { registrationData } = await loadCommandData();
    const formatted = formatCommandCapabilities(registrationData);
    log.success(`Generated slash command documentation from ${formatted.totalCommands} registered command paths`);

    return {
      success: true,
      message: formatted.markdown,
      data: {
        status: "commands_retrieved",
        capability_type: "commands",
        total_commands: formatted.totalCommands,
        total_categories: formatted.totalCategories,
        summary: formatted.markdown,
      },
    };
  }
}
