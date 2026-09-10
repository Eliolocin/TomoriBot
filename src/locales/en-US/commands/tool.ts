export default {
  tool: {
    description: `Utility actions for conversation context, prompts, and diagnostics.`,
    estimate: {
      description: `Estimate usage and costs`,
      cost: {
        description: `Estimate API costs for paid AI providers`,
        title: `Estimated API Costs`,
        embed_description: `Here are **VERY ROUGH** estimated costs per trigger in a Discord channel when using paid AI providers. Costs are estimated using example **{provider}** costs (Input: {inputPrice}/M tokens, Output: {outputPrice}/M tokens)`,
        current_context_description: `Estimated cost for your **current context only**. Input tokens are measured by the provider API using your current setup and recent channel history on **{provider}** model **{model}**. Output tokens remain estimated. Pricing used: Input {inputPrice}/M, Output {outputPrice}/M.`,
        current_context_estimated_description: `Estimated cost for your **current context only**. **{provider}** (model **{model}**) has no live token-counting API, so input tokens are **approximated from character counts** (~4 characters per token) over your current setup and recent channel history. Accuracy varies by language, and denser scripts like Japanese tokenize higher than this estimate. Output tokens are also estimated. Pricing used: Input {inputPrice}/M, Output {outputPrice}/M.`,
        current_input_title: `Measured Input Tokens (Current Context)`,
        current_input_estimated_title: `Estimated Input Tokens (Current Context)`,
        current_input_value: `**Input:** {inputTokens} tokens
**Input cost only:** ~{inputCost} per trigger`,
        current_output_typical_title: `Estimated Output: Typical`,
        current_output_persona_average_title: `Estimated Output: Persona Average`,
        current_output_band_value: `**Output estimate:** {outputTokens} tokens
**Output estimate cost:** ~{outputCost} per trigger`,
        average_total_cost_title: `Average Total Cost Per Trigger`,
        average_total_cost_value: `**Total estimate:** {totalTokens} tokens
~{costPerMessage} per trigger (~{costPer100} per 100 triggers)`,
        current_footer: `Input token counts are provider-measured only for providers with live counting support. Output token counts are estimated. The "Persona Average" band combines the persona's sample dialogue replies and recent persona turns in this channel. Falls back to a typical estimate when neither source is available.`,
        current_estimated_footer: `This provider has no live counting API, so input tokens are approximated from character counts. Treat them as a rough figure, especially for Japanese or JSON-heavy contexts. Output token counts are also estimated. The "Persona Average" band combines the persona's sample dialogue replies and recent persona turns in this channel. Falls back to a typical estimate when neither source is available.`,
        no_cost_provider_description: `Current provider does not have costs`,
        unavailable_description: `Live cost estimation is not available for the current provider (**{provider}**).`,
        fallback_notice_title: `Live Counting Unavailable`,
        fallback_notice_value: `Live provider token counting could not be used for your current setup, so this view is a rough fallback estimate.`,
        minimum_scenario_title: `Minimum Scenario (Light Usage)`,
        minimum_scenario_value: `**Context:** 1 user with 0 memories, 1 paragraph of persona, conversations are less than a sentence per message
**Tokens:** {inputTokens} input + {outputTokens} output`,
        average_scenario_title: `Average Scenario (Moderate Usage)`,
        average_scenario_value: `**Context:** 3 users with 10 memories each, ~16 paragraphs of persona (includes attributes & dialogues), conversations are 1-2 sentences per message
**Tokens:** {inputTokens} input + {outputTokens} output`,
        maximum_scenario_title: `Maximum Scenario (Heavy Usage)`,
        maximum_scenario_value: `**Context:** 5 users with 25 memories each, ~31 paragraphs of persona (includes attributes & dialogues), conversations are 2 paragraphs per message
**Tokens:** {inputTokens} input + {outputTokens} output`,
        breakdown_title: `What Affects Cost?`,
        breakdown_value: `**Input tokens (context sent to AI):**
- Persona paragraphs (includes attributes & sample dialogues)
- Server & personal memories
- Enabled tools (if any)
- User statuses & reminders
- Recent conversation history (includes images, videos, stickers, emojis, embeds if provider supports)
- Server emojis (10 constant)

**Output tokens (AI response):**
- Response length varies by query complexity
- More detailed questions = longer responses = higher cost

**Tips to reduce costs:**
I have built-in features to help reduce costs from abusers or spammers in your server, but here are some additional tips:
- Use fewer persona paragraphs (attributes & dialogues)
- Keep memories concise
- Use free AI providers (Google Gemini free tier)
- Limit auto-trigger channels`,
        footer: `Free providers like Google Gemini (free tier) and some OpenRouter models have no cost! NovelAI offers unlimited usage with a subscription. Open \`/help\` to Setup, then Step 1: Get an API Key, to learn more.`,
      },
    },
    delete: {
      description: `Delete turns or other channel content.`,
      turn: {
        description: `Delete the last persona's turn from the channel.`,
        regenerate_description: `If true, re-trigger the persona after deletion.`,
        select_persona_description: `If true, choose which persona's turn to delete.`,
        no_permission_title: `Permission Denied`,
        no_permission_description: `This command requires Manage Server permission or must be used in a designated RP channel.`,
        already_running_title: `Already Deleting`,
        already_running_description: `A deletion is already in progress for this channel. Please wait.`,
        no_persona_found_title: `No Persona Turn Found`,
        no_persona_found_description: `Couldn't find a contiguous block of persona messages in the recent history.`,
        deleting_title: `⏳ Deleting Turn`,
        deleting_description: `Deleting {count} message(s) from **{persona_name}**...`,
        success_title: `✅ Turn Deleted`,
        success_description: `Deleted {count} message(s) from **{persona_name}**.`,
        success_regenerate_description: `Deleted {count} message(s) from **{persona_name}**. Re-triggering...`,
        partial_title: `⚠️ Partial Deletion`,
        partial_description: `Deleted {deleted_count}/{total_count} message(s) from **{persona_name}**. Some messages could not be deleted.`,
        partial_no_manage_messages_description: `Deleted {deleted_count}/{total_count} message(s) from **{persona_name}**. I couldn't delete all of them because I am missing the **Manage Messages** permission.`,
        bot_no_delete_title: `Cannot Delete Messages`,
        bot_no_delete_description: `I don't have the **Manage Messages** permission in this channel, and couldn't delete any messages through webhook fallback either. Please grant me the **Manage Messages** permission or ensure my webhook is available.`,
        bot_failed_delete_description: `I encountered an unexpected error while trying to delete the messages.`,
      },
    },
    prompt: {
      description: `Inspect the prompts TomoriBot sends to the model.`,
      snapshot: {
        description: `Dump the exact LLM prompt for a persona to a file for debugging.`,
        format_description: `Output format for the snapshot file.`,
        fetch_tools_description: `If true, appends the available tool/function definitions to the snapshot (JSON only).`,
        text_option: `Text`,
        json_option: `JSON`,
        no_permission_title: `Permission Denied`,
        no_permission_description: `You need **Manage Server** permission, or the server owner must enable this for members via \`/moderation\`.`,
        modal_title: `Select Persona`,
        persona_select_label: `Persona`,
        persona_select_description: `Choose which persona to snapshot the prompt for.`,
        persona_select_placeholder: `Select a persona...`,
        dm_title: `Prompt Snapshot`,
        dm_description: `Here's the prompt snapshot for persona **{persona_name}** (format: {format}).`,
        dm_txt_headers_note: `The \`=== Title (/command) ===\` and \`== SubTitle ==\` headers in the TXT file are annotations that show which config command controls each section. They are **not** part of the actual prompt sent to the LLM. "Untagged" means that it either rearranged by or part of a custom st-preset`,
        dm_hint_try_json: `Run the command again with \`format: JSON\` for the raw format.`,
        dm_hint_try_text: `Run the command again with \`format: Text\` for a more user-readable format.`,
        dm_tools_txt_note: `Tool definitions are omitted from TXT format, please re-run with \`format: JSON\` and \`fetch_tools: true\` to include them.`,
        dm_config_heading: `**Sampling / request config** (matches what the provider adapter would send at runtime):`,
        dm_failed_title: `Could Not Send DM`,
        dm_failed_description: `I couldn't send a DM. Your snapshot is attached here instead. Enable DMs from server members to receive future snapshots in DMs.`,
        success_title: `Snapshot Sent`,
        success_description: `The prompt snapshot has been sent to your DMs.`,
        no_personas_title: `No Personas Found`,
        no_personas_description: `No personas found for this server.`,
        build_failed_title: `Snapshot Failed`,
        build_failed_description: `Failed to build the prompt snapshot. Please try again.`,
        guild_only_title: `Server Only`,
        guild_only_description: `This command can only be used in a server channel.`,
        dm_tools_filtering_note: `Tool definitions in JSON snapshots are filtered for the latest visible turn when deliberate tool mode is active. After-the-fact snapshots may not perfectly reconstruct transient retained tool context, but they no longer dump the full toolbox when the live turn would have scoped or suppressed tools.`,
      },
    },

    visualize: {
      description: `Generate a quick scene image from the ongoing channel context.`,
      missing_permissions_title: `Missing Permissions`,
      missing_permissions_description: `I need permission to view this channel, read message history, send messages, and attach files before I can generate a scene image here.`,
      cooldown_active: `This server's managers have configured a cooldown. Please wait **{seconds}** seconds before using \`/generate image\` in **Draw what's happening now** mode again. This cooldown is shared with message triggers and other manual commands.`,
      channel_not_whitelisted: `This server has whitelist restrictions active. \`/generate image\` in **Draw what's happening now** mode can only be used in whitelisted channels by members with whitelisted roles, and only with personas allowed in this channel.`,
      persona_access_blocked: `Your current whitelist permissions and personal spotlight settings do not leave any personas available for \`/generate image\` in **Draw what's happening now** mode in this channel.`,
      no_backend_title: `No Image Backend Available`,
      no_backend_description: `I couldn't find a usable image backend for this server right now. Configure **{current_provider}** with a valid image model, or add a NovelAI optional key if you want to use the NovelAI renderer instead.`,
      planner_unavailable_title: `No Planning Model Available`,
      planner_unavailable_description: `I couldn't find a structured-output model for the current provider, so I can't plan a scene image right now.`,
      planner_failed_title: `Scene Planning Failed`,
      planner_failed_description: `I couldn't turn the recent channel context into an image plan: {error}`,
      success_title: `Scene Image Posted`,
      success_description: `I planned the shot from the recent channel context and posted the image in this channel.`,
      modal: {
        title: `Scene Image`,
        prompt_label: `Extra Direction (Optional)`,
        prompt_description: `Add any correction, mood, or detail you want the scene planner to respect`,
        prompt_placeholder: `e.g. focus on the rain, make it softer, show both characters clearly`,
        setting_label: `Shot Preset`,
        setting_description: `Choose the framing/style preset for this fire-and-forget scene image`,
        setting_storybeat_label: `Story Beat`,
        setting_storybeat_description: `Wide cinematic framing for the immediate scene`,
        setting_character_label: `Character Focus`,
        setting_character_description: `Closer framing around the main character or speaker`,
        setting_snapshot_label: `Square Snapshot`,
        setting_snapshot_description: `Balanced square composition for the current moment`,
        setting_vertical_label: `Phone Wallpaper`,
        setting_vertical_description: `Tall vertical framing with stronger silhouette`,
        backend_label: `Image Backend`,
        backend_description: `Choose which renderer should generate the scene image`,
        backend_current_label: `Current Provider`,
        backend_current_description: `Use {provider}'s normal image-generation flow and prompt style`,
        backend_novelai_label: `NovelAI`,
        backend_novelai_description: `Convert the scene into NovelAI-style tags and use the NovelAI image tool`,
        persona_label: `Sender Persona`,
        persona_description: `Choose which persona posts the generated image`,
      },
    },
  },
};
