export default {
  genai: {
    generic_error_title: `Generation Error`,
    generic_error_description: `{error_message}`,
    error_stream_timeout_title: `Connection Timeout`,
    error_stream_timeout_description: `If this keeps happening, there might be a temporary issue with your chosen AI provider. Please try again later or use \`/tool refresh\` to refresh the context history.`,
    empty_response_title: `Empty Response`,
    empty_response_description: `I received an empty response from the AI, use \`/tool refresh\` if this issue persists.`,
    max_iterations_title: `Thinking Loop`,
    max_iterations_streaming_description: `I got stuck in a thinking loop and couldn't complete the request, use \`/tool refresh\` if this issue persists.`,
    still_working_title: `Still Working...`,
    still_working_description: `This task is taking more steps than usual. Use \`/bot kill\` if you think I'm stuck.`,
    nai_tool_retry_exhausted_title: `Tool Error`,
    nai_tool_retry_exhausted_description: `A tool failed multiple times and couldn't complete the request. Please try again or use \`/tool refresh\` if this issue persists.`,
    tool_error_loop_title: `Tool Error Loop`,
    tool_error_loop_description: `I kept running into tool errors and couldn't complete the request. Try rephrasing or use \`/tool refresh\` if this issue persists.`,
    fallback_used_title: `Fallback Model Used`,
    fallback_used_description: `\`{success_model}\` was used instead of {chain}`,
    fallback_used_details_description: `Fallback slot {slot} answered with \`{success_model}\` after these earlier failures:
{failure_list}`,
    fallback_used_failure_line: `{index}. {model} errored with {error_detail}`,
    fallback_used_details_button: `Fallback Used`,
    fallback_used_hide_footer: `Hide this and reroute details to thought logs with \`/config notice-embeds visibility\``,
    markdown_table: {
      show_button: `Show Markdown`,
      source_expired: `That table's markdown is no longer cached, so I can't show the source anymore.`,
      source_attached: `This table is too long to show inline, so here it is as a file:`,
    },
    no_response_title: `No Response`,
    no_response_description: `I didn't respond - this may be due to an empty response or timeout from the AI.`,
    thought_log: {
      title: `Thought Log`,
      description: `Source: {source_line}`,
      personal_attribution: `Generated via {user_mention}'s personal {provider} configuration.`,
      personal_attribution_title: `Personal Provider Attribution`,
      summary_field: `Thought Summary`,
      raw_field: `Raw Thoughts`,
      fetched_content_field: `Fetched Content`,
      footer: `Provider: {provider} | Model: {model}`,
      footer_with_generation_time: `Provider: {provider} | Model: {model} | Generation time: {generation_time}`,
      provider_with_serving: `{provider} via {serving_provider}`,
    },
    message_interaction: {
      reply_context_author: `Replying to {user}`,
      reply_context_description: `{message_url}`,
      reply_context_footer: `Replying to {user} • {message_url}`,
    },
    text_quota_exceeded_title: `🔴 Text Quota Exceeded`,
    text_quota_exceeded_description: `You have reached your text generation quota. {reset_info}`,
    text_user_quota_exceeded_description: `You have reached your daily text generation quota. {reset_info}`,
    text_serverwide_quota_exceeded_description: `This server has reached its text generation quota for this period. {reset_info}`,
    text_quota_resets_in_hours: `Quota resets in {hours} hour(s).`,
    text_quota_resets_in_days: `Quota resets in {days} day(s).`,
    text_quota_exceeded_footer: `This quota is configured by this server's managers via \`/server quota\`.`,
    stream: {
      response_stopped_title: `Response Interrupted`,
      response_stopped_description: `The response was interrupted for the following reason: {reason}. Make sure that content sent is not too large for the AI provider to handle. Run \`/tool refresh\` to clear conversation content.`,
      streaming_failed_description: `An issue while trying to stream the response.`,
      provider_error_interaction: `Stream response blocked/stopped. Reason: {reason}.`,
      api_error_title: `🔴 Provider API Error`,
      privacy_error_title: `🔴 Provider Privacy Settings`,
      model_error_title: `🔴 Model Configuration Error`,
      model_error_description: `The selected model was rejected by the provider. Check the configured model name and switch to one of the provider's supported model IDs.`,
      rate_limit_title: `🟡 Provider Rate Limit Exceeded`,
      rate_limit_title_all_rotation_keys: `🟡 Provider Rate Limit Exceeded (All Rotation Keys)`,
      content_blocked_title: `🔴️ Provider Content Filter`,
      timeout_title: `🟡️ Provider Request Timeout`,
      provider_overloaded_title: `🔴 Provider Overloaded`,
      provider_overloaded_description: `The provider is currently overloaded or temporarily unavailable`,
      context_length_title: `🔴 Message Too Long for This Model`,
      credit_limit_title: `🔴 Not Enough Provider Credits`,
      balance_exhausted_title: `🔴 Provider Account Out of Credit`,
      flush_limit_title: `🟡️ Response Length Limit Reached`,
      flush_limit_description: `This response has reached the maximum message length limit and has been stopped. You can use \`/bot respond\` to manually continue the response if needed.`,
      inactivity_timeout_title: `🟡️ Response Timed Out`,
      inactivity_timeout_description: `The AI provider stopped responding and the connection timed out. This can happen when the provider is overloaded or experiencing issues. Please try again.`,
    },
    // Atomic tip-item strings rendered by createTipEmbed() as a dashed bullet list in a separate
    // green "Tip" embed. Each key is one bullet; callers compose them (including conditional items)
    // instead of maintaining whole-paragraph tip strings. Descriptions render markdown + hyperlinks.
    tips: {
      title: `💡 What you can do`,
      wait_and_retry: `Please wait a few minutes before trying again.`,
      api_key_rotation: `If this server has multiple keys, set up \`/provider api-key rotation\` to cycle through them.`,
      model_fallback: `Add backup models with \`/model fallback\` for better resilience.`,
      model_fallback_personal: `Add backup models with \`/personal model fallback\` for better resilience.`,
      openrouter_free_models: `Add more free models from the [OpenRouter free model list](https://openrouter.ai/models?max_price=0&output_modalities=text) with \`/openrouter model add\`.`,
      openrouter_models: `Browse the [OpenRouter model list](https://openrouter.ai/models) and switch models with \`/openrouter model add\`.`,
      choose_supported_model: `Choose a supported model ID with \`/model text\` or your custom endpoint settings.`,
      choose_supported_model_personal: `Choose a supported model ID with \`/personal provider model-text\` or your custom endpoint settings.`,
      verify_api_key: `Double-check this server's API key, then try again.`,
      verify_api_key_personal: `Double-check your personal API key with \`/personal provider add\`, then try again.`,
      google_credential_type: `This looks like an OAuth or service account token. The \`google\` provider needs a plain API key from [Google AI Studio](https://aistudio.google.com/apikey); use the \`vertex\` provider for Google Cloud credentials.`,
      openrouter_privacy_settings: `Adjust your "Data Policy" settings at [OpenRouter Privacy Settings](https://openrouter.ai/settings/privacy) to allow this model, or choose a different model.`,
      openrouter_fund_account: `Add at least 10 credits to your OpenRouter account to unlock 1000 free model requests per day.`,
      reduce_context_length: `Try reducing the length of your message or clearing context with \`/tool refresh\`.`,
      reduce_output_tokens: `Lower the reply length cap with \`/model parameters\` (output tokens) to free up room for chat history.`,
      reduce_output_tokens_personal: `Lower the reply length cap with \`/personal parameters\` (output tokens) to free up room for chat history.`,
      openrouter_add_credits: `Add credits at [OpenRouter Credits](https://openrouter.ai/settings/credits), or lower the reply length with \`/model parameters\` (output tokens).`,
      openrouter_add_credits_personal: `Add credits at [OpenRouter Credits](https://openrouter.ai/settings/credits), or lower the reply length with \`/personal parameters\` (output tokens).`,
      top_up_provider_balance: `Your API key is valid, but the account behind it has run out of credit. Top it up with your provider, then try again. Shortening the message or lowering the reply length will not help here.`,
      deepseek_top_up: `Add funds on the [DeepSeek top-up page](https://platform.deepseek.com/top_up).`,
      adjust_parameters: `Use \`/model parameters\` and adjust either **Temperature** or **Top P** to ensure only one is sent.`,
      adjust_parameters_personal: `Use \`/personal parameters\` and adjust either **Temperature** or **Top P** to ensure only one is sent.`,
      switch_model_provider: `Switch to a different model or provider with \`/model text\` or \`/provider add\`.`,
      switch_model_provider_personal: `Switch with \`/personal provider model-text\`, or turn **Text** off in \`/personal provider toggle-models\` to use this server's model.`,
      disable_personal_text_override: `This request error was from your [personal provider](https://docs.tomoribot.app/en/features/knowledge/personalization/#your-own-providers). If you meant to use this server's configured model instead, disable **Text** in \`/personal provider toggle-models\`.`,
      // Auto-appended to every non-empty tip embed by createTipEmbed(); never list it in a caller's tipKeys.
      support_server: `Visit the [Official Support Server](https://discord.gg/bjCfHm9QsB) for assistance.`,
      shorten_message: `Try shortening your message, then send it again.`,
      refresh_context: `Clear the conversation context with \`/tool refresh\`.`,
      provider_overloaded_wait: `The provider is under heavy load right now. Try again shortly or switch providers.`,
      nsfw_jailbreaks: `Turn on \`/nsfw jailbreaks\` to help prevent this filter.`,
      review_messages: `Review recent messages, or clear them with \`/tool refresh\`.`,
      review_memories: `Check your memories and config (\`/memory personal export\`, \`/memory server export\`, \`/server config export\`).`,
      blacklist_member: `Blacklist a problematic member with \`/server user-blacklist add\`.`,
    },
    google: {
      "400_default_message": `There was an error in your request format`,
      "400_billing_default_message": `Billing is required for this service`,
      "401_default_message": `Your Google credentials were rejected. Make sure you're using an API key from Google AI Studio`,
      "403_default_message": `Your API key doesn't have the required permissions. Please ensure you're using your own legally obtained API key from Google AI Studio`,
      "404_default_message": `A referenced resource could not be found`,
      "429_default_message": `You've sent too many requests too quickly`,
      "503_default_message": `The AI model is currently overloaded`,
      "504_default_message": `Your request took too long to process`,
      content_blocked_default_message: `Your content was blocked by safety filters`,
      unknown_default_message: `An unexpected error occurred`,
    },
    vertexexpress: {
      "403_predict_permission_message": `This key can't call Vertex AI Express models. Use an Express-mode key, or use the separate \`vertex\` provider for full Google Cloud projects.`,
      unknown_default_message: `An unexpected error occurred`,
    },
    novelai: {
      "400_default_message": `Invalid request format or parameters. Please ensure you inputted the correct API key.`,
      "400_trial_message": `Your trial account requires recaptcha verification for generations. API access requires a paid NovelAI subscription. Please upgrade your account at https://novelai.net/`,
      "401_default_message": `Your NovelAI API key is invalid or expired`,
      "402_default_message": `You don't have enough Anlas credits`,
      "429_default_message": `You're sending too many requests, please slow down`,
      "503_default_message": `NovelAI servers are currently overloaded`,
      "504_default_message": `Your request took too long to process`,
      unknown_default_message: `An unexpected error occurred`,
    },
    openrouter: {
      "404_privacy_policy_error": `**Privacy Policy Restriction**
The selected model requires allowing data for paid model training, but your OpenRouter account privacy settings currently block this.`,
      "400_default_message": `Invalid request sent to OpenRouter`,
      "401_default_message": `Your OpenRouter API key is invalid or expired`,
      "402_default_message": `Your OpenRouter account has insufficient credits`,
      "403_default_message": `Access denied: check your OpenRouter account settings`,
      "408_default_message": `The OpenRouter request timed out`,
      "429_default_message": `OpenRouter rate limit exceeded, please wait before retrying`,
      "429_free_models_message": `OpenRouter rate limit exceeded for free models.`,
      "500_default_message": `OpenRouter encountered an internal server error`,
      "502_default_message": `The upstream AI provider is temporarily unavailable`,
      "503_default_message": `The upstream AI model is currently overloaded`,
      "504_default_message": `The upstream model request timed out`,
      unknown_default_message: `An unexpected error occurred`,
    },
    anthropic: {
      "400_default_message": `Invalid request to Anthropic API.`,
      "401_default_message": `Your Anthropic API key is invalid. Please check your key at console.anthropic.com`,
      "403_default_message": `Your Anthropic API key does not have permission for this operation.`,
      "404_default_message": `The requested Anthropic model could not be found.`,
      "429_default_message": `Anthropic rate limit exceeded. Please wait a moment and try again.`,
      "500_default_message": `Anthropic returned an internal server error.`,
      "503_default_message": `Anthropic is currently unavailable or overloaded.`,
      temperature_top_p_conflict_message: `Anthropic rejected this request because both Temperature and Top-P were sent.`,
      unknown_default_message: `An unexpected error occurred while communicating with Anthropic.`,
    },
    custom: {
      "402_default_message": `Your account with this endpoint has insufficient balance`,
      unknown_default_message: `An unexpected error occurred`,
    },
    deepseek: {
      "402_default_message": `Your DeepSeek account has insufficient balance`,
      unknown_default_message: `An unexpected error occurred`,
    },
    zai: {
      // Z.ai reports billing denial as 429; the formatter re-codes it so it does not read as a rate limit.
      "429_balance_default_message": `Your Z.ai account has insufficient balance`,
      "429_plan_access_default_message": `Your Z.ai subscription plan does not include access to this model`,
      unknown_default_message: `An unexpected error occurred`,
    },
    nvidia: {
      "404_default_message": `The requested NVIDIA NIM model could not be found. It may be deprecated by NVIDIA.`,
      "500_default_message": `The NVIDIA backend serving this model failed. This is usually transient, so try again in a moment. The details below are NVIDIA's own report and are authoritative: if they name a request parameter, adjust that setting rather than guessing.`,
      // Shown instead of 500_default_message only when NVIDIA's own text names a droppable request
      // parameter. Asserting this cause on every 500 previously sent users to change settings the
      // failing payload never carried.
      "500_parameter_default_message": `NVIDIA rejected one or more request parameters for this model. If the details name unsupported sampler parameters such as \`min_p\`, set them to \`0\` with \`/model parameters\` to turn them off. If the details name \`logit_bias\`, clear saved entries with \`/model logit-bias remove\`.`,
      unknown_default_message: `An unexpected error occurred`,
    },
    self_teach: {
      server_memory_learned_title: `🧠 {persona_nickname} Learned Something New!`,
      server_memory_learned_description: `A **[Server Memory](https://docs.tomoribot.app/en/features/knowledge/memory/#long-term-memory)** has been saved:
\`\`\`
{memory_content}
\`\`\``,
      server_memory_updated_title: `📝 {persona_nickname} Updated a Memory!`,
      server_memory_updated_description: `A **[Server Memory](https://docs.tomoribot.app/en/features/knowledge/memory/#long-term-memory)** has been updated:
\`\`\`
{memory_content}
\`\`\``,
      server_memory_deleted_title: `🗑️ {persona_nickname} Deleted a Memory!`,
      server_memory_deleted_description: `A **[Server Memory](https://docs.tomoribot.app/en/features/knowledge/memory/#long-term-memory)** has been deleted:
\`\`\`
{memory_content}
\`\`\``,
      personal_memory_learned_title: `💡 {persona_nickname} Learned Something New about {user_nickname}!`,
      personal_memory_learned_description: `A **[Personal Memory](https://docs.tomoribot.app/en/features/knowledge/memory/#long-term-memory)** about {user_nickname} has been saved:
\`\`\`
{memory_content}
\`\`\``,
      personal_memory_updated_title: `📝 {persona_nickname} Updated a Memory about {user_nickname}!`,
      personal_memory_updated_description: `A **[Personal Memory](https://docs.tomoribot.app/en/features/knowledge/memory/#long-term-memory)** about {user_nickname} has been updated:
\`\`\`
{memory_content}
\`\`\``,
      personal_memory_deleted_title: `🗑️ {persona_nickname} Deleted a Memory about {user_nickname}!`,
      personal_memory_deleted_description: `A **[Personal Memory](https://docs.tomoribot.app/en/features/knowledge/memory/#long-term-memory)** about {user_nickname} has been deleted:
\`\`\`
{memory_content}
\`\`\``,
      server_memory_footer: `Server managers can manage this memory using \`/memory server\`.`,
      personal_memory_footer_manage: `You can manage your personal memories using \`/memory personal\`.`,
      personal_memory_footer_personalization_disabled: `This memory was saved, but personalization features are currently disabled on this server, so it will not have an immediate effect here. Use \`/memory personal export\` to view it. You can opt out with \`/personal privacy\`.`,
      personal_memory_footer_user_blacklisted: `This memory was saved, but the user in question is currently blacklisted from personalization features on this server, so it will not have an immediate effect here. Use \`/memory personal export\` to view it. You can opt out with \`/personal privacy\`.`,
      expand_memory_button: `Show Full Memory`,
      expand_memory_title: `Full Memory Content`,
    },
  },
};
