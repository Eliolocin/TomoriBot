// locales/en.ts (or your desired file name)

// Export the entire locale structure as a default object
export default {
	general: {
		// Cooldown messages
		cooldown_title: `⌛ Please wait!`,
		cooldown: `You need to wait {seconds} seconds before using a \`/{category}\` command again.`,

		// Standard interaction responses (buttons, selects)
		interaction: {
			cancel_title: `❌ Command Cancelled`,
			cancel_description: `The command has been cancelled.`,
			timeout_title: `⏰ Command Timed Out`,
			timeout_description: `You didn't respond in time. Please try again.`,
		},

		// Pagination component messages
		pagination: {
			page_info: `Page {current} of {total}`,
			previous: `Previous`,
			next: `Next`,
			cancel: `Cancel`,
			no_items: `There are no items to display.`,
			cancelled: `Selection has been cancelled.`,
			timeout: `You didn't make a selection in time. Please try again.`,
			item_selected: `Selected: {item}`,
			select_page_title: `Select Page`,
			select_page_description: `Choose a page to view from {totalItems} items across {totalPages} pages:`,
		},

		// Common error messages
		errors: {
			guild_only_title: `Server Only Command`,
			guild_only_description: `This command can only be used within a server.`,
			channel_only_title: `Channel Required`,
			channel_only_description: `This command requires a channel to function properly.`,
			guild_only_command_title: `Server Only Command`,
			guild_only_command_description: `This command can only be used within a server, not in Direct Messages.`,
			channel_not_supported_title: `Unsupported Channel Type`,
			channel_not_supported_description: `Sorry, I can only work in server text channels or Direct Messages. Group DMs and other channel types are not supported.`,
			tomori_not_setup_title: `Initial Setup Required`,
			tomori_not_setup_description: `It seems I haven't been set up on this server yet. A server member with \`Manage Server\` permissions needs to use \`/config setup\` first. You may also use the \`/help setup\` for help, and the \`/config language\` command to set your preferred language.`,
			tomori_not_setup_dm_footer: `Note: DMs are treated as mini "servers" wherein I respond to any of your messages privately. All server related commands will still work as intended and there is no need for the \`Manage Server\` permissions within DMs.`,
			api_key_missing_title: `API Key Missing`,
			api_key_missing_description: `I need an API key to function, but one hasn't been configured for this server. A server member with \`Manage Server\` permissions can set one using \`/config apikeyset\`.`,
			api_key_error_title: `API Key Error`,
			api_key_error_description: `There was an issue accessing or decrypting the configured API key. Please ensure it was set correctly using \`/config apikeyset\`.`,
			context_error_title: `Context Building Error`,
			context_error_description: `I encountered an error while trying to understand the conversation context.`,
			critical_error_title: `Critical Error`,
			critical_error_description: `An unexpected critical error occurred.`,
			update_failed_title: `Update Failed`,
			update_failed_description: `Failed to update the configuration in the database. Please try again.`,
			unknown_error_title: `Unknown Error`,
			unknown_error_description: `An unexpected error occurred. If the issue persists, please report it through \`/support report\`.`,
			invalid_option_title: `Invalid Option`,
			invalid_option_description: `The selected option is invalid. Please choose a valid option.`,
			brave_api: {
				missing_key: {
					title: `Brave API Key Missing`,
					description: `I need a Brave Search API key to perform searches, but one hasn't been configured for this server. A server member with \`Manage Server\` permissions can set one using \`/config braveapiset\` or disable it using \`/config botpermissions\`.`,
					footer: `Get a free API key at https://brave.com/search/api/`,
				},
			},
			duckduckgo_rate_limit: {
				title: `DuckDuckGo Rate Limited`,
				description: `DuckDuckGo search is currently rate limited. For more reliable searching, a server member with \`Manage Server\` permissions can set up Brave Search using \`/config braveapiset\` or disable it using \`/config botpermissions\`.`,
				footer: `Get a free Brave Search API key at https://brave.com/search/api/`,
			},
			operation_failed_title: `Operation Failed`,
			operation_failed_description: `The requested operation could not be completed. Please try again.`,
			provider_not_supported_title: `Provider Not Supported`,
			provider_not_supported_description: `The selected AI provider is not currently supported.`,
			user_blacklisted_title: `User Blacklisted`,
			user_blacklisted_description: `You are currently blacklisted from personalization features on this server and cannot perform this action.`,
		},
		tomori_busy_title: "Busy Replying to Someone Else!",
		tomori_busy_replying:
			"Currently responding to this message: {message_link}. Your message has been queued.",
	},

	genai: {
		// Errors related to LLM API generation
		generic_error_title: `Generation Error`,
		generic_error_description: `{error_message}`,
		generic_error_footer: `Please run \`/tool refresh\` and then try again. If the issue persists, please report it through \`/support report\`.`,
		error_stream_timeout_title: "Connection Timeout",

		// Provider error format template: "{Provider name} Error Code {number}: {message from Google}. {tip from us}"
		provider_error_format:
			"{providerName} Error Code {errorCode}: {apiMessage}. {tip}",
		error_stream_timeout_description:
			"If this keeps happening, there might be a temporary issue with the service. Please try your request again in a moment or use `/tools refresh` to refresh the context history.",

		// Empty response from API
		empty_response_title: `Empty Response`,
		empty_response_description: `I received an empty response from the AI.`,
		// New: Max iterations for function calls
		max_iterations_title: "Thinking Loop",
		max_iterations_streaming_description:
			"I got stuck in a thinking loop and couldn't complete the request.",

		// Search related messages
		search: {
			web_search_title: `🔍 Searching for \`{query}\` on the web...`,
			image_search_title: `🔍 Searching for \`{query}\` images...`,
			video_search_title: `🔍 Searching for \`{query}\` videos...`,
			news_search_title: `🔍 Searching for \`{query}\` in the news...`,
			disclaimer_description: `AI-Generated Responses and Search Results may be inaccurate or incomplete, **please double-check important information**.`,
		},

		// YouTube video processing messages
		video: {
			youtube_processing_title: "👁️ Watching YouTube Video...",
			youtube_processing_description:
				"I'm currently watching the YouTube video: {video_url}",
			youtube_processing_footer:
				"This may take a moment depending on the video length",
		},

		// New: Stream specific error messages
		stream: {
			response_stopped_title: "Response Interrupted",
			response_stopped_description:
				"The response was interrupted for the following reason: {reason}. Make sure that content sent is not too large for the AI provider to handle. Run `/tool refresh` to clear conversation content.",
			prohibited_content_title: "Content Policy Violation",
			prohibited_content_description:
				"The response was blocked due to prohibited content detection.",
			prohibited_content_admin_notice_title: "Admin Notice",
			prohibited_content_admin_notice_description:
				"Please make sure content sent (media, conversation messages, and memories) complies with the AI provider's content policies. Run `/tool refresh` to clear conversation content.",
			streaming_failed_description:
				"An issue while trying to stream the response.",

			// Error interaction messages
			provider_error_interaction:
				"Stream response blocked/stopped. Reason: {reason}.",
			retry_message: "This error is temporary. You can try your request again.",

			// Universal provider error titles and tips (moved from genai.google)
			api_error_title: "❌ API Error",
			api_error_tip: "Please verify your API key and try again",

			rate_limit_title: "🟡 Rate Limit Exceeded",
			rate_limit_tip: "Please wait a few minutes before trying again",

			content_blocked_title: "🛡️ Content Blocked",
			content_blocked_tip:
				"Please rephrase your message to comply with content policies",

			timeout_title: "⏱️ Request Timeout",
			timeout_tip: "Try shortening your message or try again",

			provider_overloaded_title: "🛑 Provider Overloaded",
			provider_overloaded_tip:
				"Provider is currently experiencing unexpectedly high usage, please try again later",

			unknown_title: "❓ Provider Error",
			unknown_tip:
				"Please try again or use `/support report` if this keeps happening",
		},

		// Google-specific error messages (provider-specific default messages only)
		google: {
			// 400 INVALID_ARGUMENT
			"400_default_message": "There was an error in your request format",

			// 400 FAILED_PRECONDITION (billing)
			"400_billing_default_message": "Billing is required for this service",

			// 403 PERMISSION_DENIED
			"403_default_message":
				"Your API key doesn't have the required permissions",

			// 404 NOT_FOUND
			"404_default_message": "A referenced resource could not be found",

			// 429 RESOURCE_EXHAUSTED
			"429_default_message": "You've sent too many requests too quickly",

			// 500 INTERNAL
			"500_default_message": "An unexpected error occurred on Google's servers",

			// 503 UNAVAILABLE
			"503_default_message": "The AI model is currently overloaded",

			// 504 DEADLINE_EXCEEDED
			"504_default_message": "Your request took too long to process",

			// Content blocked errors (SAFETY, PROHIBITED_CONTENT, etc.)
			content_blocked_default_message:
				"Your content was blocked by safety filters",

			// Generic fallback for unknown Google errors
			unknown_default_message: "An unexpected error occurred",
		},

		self_teach: {
			server_memory_learned_title: "🧠 I Learned Something New! (Server-Wide)",
			server_memory_learned_description:
				'I\'ve just learned this about our server: "{memory_content}"',
			personal_memory_learned_title:
				"💡 I Learned Something New! (User-Specific)",
			personal_memory_learned_description:
				'I\'ve just learned this about {user_nickname}: "{memory_content}"',
			server_memory_footer:
				"Server managers can manage this memory using `/teach` and `/unlearn` commands.",
			personal_memory_footer_manage:
				"You can manage your personal memories using `/teach` and `/unlearn` commands.",
			personal_memory_footer_personalization_disabled:
				"This memory was saved, but personalization features are currently disabled on this server, so it will not have an immediate effect here.",
			personal_memory_footer_user_blacklisted:
				"This memory was saved, but the user in question is currently blacklisted from personalization features on this server, so it will not have an immediate effect here",
		},

		// Test/placeholder keys
		some_other: {
			title: `Test GenAI Feature`,
		},
	},

	commands: {
		// General utility commands
		tool: {
			ping: {
				description: `Check the bot's latency.`,
				response_fast: `Pong! 🏓
Response Time: \`{response_time}ms\`
Discord API Latency: \`{discord_response}ms\``,
				response_slow: `Pong! 🐢 (A bit slow...)
Response Time: \`{response_time}ms\`
Discord API Latency: \`{discord_response}ms\``,
			},
			refresh: {
				description: `Clears the recent conversation history.`,
				title: `🧹 Conversation History Cleared`,
				response: `Context has been refreshed. All messages above this one will now be ignored.`,
			},
			status: {
				description: `Show current personal or server status.`,
				type_description: `Which status type to display?`,
				type_choice_personal: `Personal`,
				type_choice_server: `Server`,
				personal_title: `Personal Status`,
				personal_description: `Your personal settings and memories`,
				server_title: `Server Status`,
				server_description: `Server configuration, personality, and memories`,
				field_model: `AI Model`,
				field_temperature: `Temperature`,
				field_humanizer: `Humanizer Level`,
				field_autoch_threshold: `Auto-Chat Threshold`,
				field_autoch_channels: `Auto-Chat Channels`,
				field_trigger_words: `Trigger Words`,
				field_personalization: `Personalization`,
				field_self_teach: `Self-Teaching`,
				field_api_key_set: `API Key Set`,
				field_emoji_usage: `Emoji Usage`,
				field_sticker_usage: `Sticker Usage`,
				field_web_search: `Web Search`,
				field_server_memteaching: `Server Memories Teaching`,
				field_attribute_memteaching: `Attributes Teaching`,
				field_sampledialogue_memteaching: `Sample Dialogues Teaching`,
				field_nickname: `Nickname`,
				field_dialogue_count: `Sample Dialogues`,
				field_attributes: `Attributes`,
				field_user_nickname: `User Nickname`,
				field_language_pref: `Language Preference`,
				field_reminders_count: `Active Reminders`,
				field_personal_memories: `Personal Memories`,
				field_server_memories: `Server Memories`,
				item_count: `{count} items`,
				none: `None`,
				disabled: `Disabled`,
				unknown_channel: `Unknown Channel ID:`,
				not_available: `N/A`,
				see_all_memories_prompt: `Please use the \`/export\` command to see all memories`,
				memories_omitted: `...and {count} more memories omitted`,
				export_footer: `Use the \`/export\` command to see full, non-truncated memories`,
				export_footer_full: `Use the \`/export\` command to see full details on everything`,
				field_personal_memories_with_count: `Personal Memories ({current} out of {max} slots used)`,
				field_trigger_words_with_count: `Trigger Words ({current} out of {max} slots used)`,
				field_attributes_with_count: `Attributes ({current} out of {max} slots used)`,
				field_server_memories_with_count: `Server Memories ({current} out of {max} slots used)`,
				field_dialogue_count_with_count: `Sample Dialogues ({current} out of {max} slots used)`,
			},
		},

		// Help commands
		help: {
			apikey: {
				title: `API Key Help`,
			},
		},

		// Test/placeholder commands
		some_feature: {
			title: `Test Feature`,
		},

		// Bot manual control commands
		bot: {
			respond: {
				description: `Manually trigger response to the latest message in this channel.`,
				success_title: `Manual Response Triggered`,
				success_description: `Responding to the latest message in this channel...`,
			},
			reason: {
				description: `Use current AI provider's smartest reasoning model to respond with optional query.`,
				query_description: `Optional query to focus reasoning on.`,
				success_title: `Reasoning Mode Activated`,
				success_description: `Using advanced reasoning to respond{query}...`,
				no_smart_model_title: `No Reasoning Model Found`,
				no_smart_model_description: `No reasoning model found for your current AI provider. Please switch to a provider that supports reasoning models using \`/config apikeyset\`.`,
			},
		},

		// Configuration commands (Admin only)
		config: {
			options: {
				// General options for config subcommands
				add: `Add`,
				remove: `Remove`,
				enable: `Enable`,
				disable: `Disable`,
			},
			triggeradd: {
				description: `Add a word that makes me respond when mentioned.`,
				word_description: `The word to add as a trigger.`,
				too_short_title: `Trigger Word Too Short`,
				too_short_description: `Trigger words must be at least 2 characters long.`,
				already_exists_title: `Trigger Word Exists`,
				already_exists_description: `The word \`{word}\` is already in the trigger list.`,
				limit_exceeded_title: `Trigger Word Limit Exceeded`,
				limit_exceeded_description: `This server has reached its trigger word limit of {max_allowed} words (currently has {current_count}). Please remove some trigger words with \`/config triggerdelete\` before adding new ones.`,
				success_title: `Trigger Word Added`,
				success_description: `Successfully added \`{word}\` as a trigger word. There are now {word_count} trigger words.`,
			},
			autochchannels: {
				description: `Add or remove channels where I will automatically chat.`,
				channel_description: `The text channel to add or remove.`,
				action_description: `Whether to add or remove the channel.`,
				invalid_channel_title: `Invalid Channel Type`,
				invalid_channel_description: `Please select a standard text channel.`,
				already_added_title: `Channel Already Added`,
				already_added_description: `The channel \`{channel_name}\` is already in the auto-chat list.`,
				not_in_list_title: `Channel Not Found`,
				not_in_list_description: `The channel \`{channel_name}\` is not in the auto-chat list.`,
				added_title: `Auto-Chat Channel Added`,
				added_description: `Successfully added \`{channel_name}\` to the auto-chat channels.`,
				removed_title: `Auto-Chat Channel Removed`,
				removed_description: `Successfully removed \`{channel_name}\` from the auto-chat channels.`,
			},
			autochthreshold: {
				description: `Set the message count threshold for me to auto-chat (0 to disable).`,
				threshold_description_v2: `Messages needed before auto-chat (0 to disable, or 30-100).`,
				invalid_range_title: `Invalid Threshold`,
				invalid_range_specific_description: `The threshold must be exactly \`{min}\` (to disable) or between \`{range_start}\` and \`{max}\`.`,
				success_title: `Auto-Chat Threshold Set`,
				success_description: `I will now automatically chat after \`{threshold}\` messages in designated channels.`,
				success_disabled_title: `Auto-Chat Disabled`,
				success_disabled_description: `Auto-chat feature is now disabled (threshold set to \`{threshold}\`).`,
			},
			blacklist: {
				description: `Add or remove a member from the personalization blacklist.`,
				member_description: `The member to add or remove from the blacklist.`,
				action_description: `Whether to add or remove the member.`,
				personalization_disabled_title: `Personalization Disabled`,
				personalization_disabled_description: `Personalization is currently disabled server-wide. Enable it first with \`/config botpermissions\`.`,
				already_blacklisted_title: `Already Blacklisted`,
				already_blacklisted_description: `\`{user_name}\` is already on the personalization blacklist.`,
				not_blacklisted_title: `Not Blacklisted`,
				not_blacklisted_description: `\`{user_name}\` is not on the personalization blacklist.`,
				added_title: `Member Blacklisted`,
				added_description: `Added \`{user_name}\` to the personalization blacklist. Their personal memories and nickname won't be used.`,
				removed_title: `Member Unblacklisted`,
				removed_description: `Removed \`{user_name}\` from the personalization blacklist. Their personal memories and nickname can now be used.`,
				user_registration_failed_title: `User Registration Failed`,
				user_registration_failed_description: `Failed to register user in the database. Please try again.`,
				cannot_blacklist_bot_title: `Cannot Blacklist Bots`,
				cannot_blacklist_bot_description: `\`{user_name}\` is a bot and cannot be added to the personalization blacklist.`,
			},
			humanizerdegree: {
				description: `Set how 'human-like' my responses should feel.`,
				// value_description: `The level of humanization (0=None, 1=Prompt, 2=Typing/Chunking, 3=Lowercase/No Punctuation).`,
				modal_title: `Set Humanizer Degree`,
				select_label: `Humanizer Level`,
				select_description: `Choose how human-like my responses should feel`,
				select_placeholder: `Choose a level...`,
				choice_none: `0: None (Raw AI Output)`,
				choice_light: `1: Light (Prompt Injection)`,
				choice_medium: `2: Medium (Typing Simulation & Chunking)`,
				choice_heavy: `3: Heavy (Lowercase & No Punctuation - Default)`,
				desc_none: `No humanization. Standard AI responses with formal tone and structure.`,
				desc_light: `Adds human-like response guidelines. Limits emojis (0-2), prefers concise responses.`,
				desc_medium: `Light features + typing simulation and improved message chunking for natural flow.`,
				desc_heavy: `All features + casual text processing (lowercase, reduced punctuation) for informal tone.`,
				// invalid_value_title: `Invalid Value`,
				invalid_value_description: `Humanizer degree must be between {min} and {max}.`,
				already_set_title: `Humanizer Already Set`,
				already_set_description: `The humanizer degree is already set to \`{value}\`.`,
				success_title: `Humanizer Degree Updated`,
				success_description: `Humanizer degree changed from \`{previous_value}\` to \`{value}\`.`,
			},
			language: {
				description: `Set your preferred language for my interface.`,
				value_description: `Choose your preferred language for interfaces.`,
				choice_english: `English`,
				choice_japanese: `Japanese`,
				invalid_value_title: `Invalid Language`,
				invalid_value_description: `Language must be one of: {supported}.`,
				already_set_title: `Language Already Set`,
				already_set_description: `Your language preference is already set to \`{value}\`.`,
				success_title: `Language Updated`,
				success_description: `Your interface language changed from \`{previous_value}\` to \`{value}\`.`,
			},
			memberpermissions: {
				description: `Configure what non-admin members can teach me.`,
				option_description: `The type of memory members can teach.`,
				servermemories_option: `Server Memories`,
				attributelist_option: `Attribute List`,
				sampledialogues_option: `Sample Dialogues`,
				set_description: `Enable or disable this permission for members.`,
				success_title: `Member Permissions Updated`,
				enabled_success: `Members can now teach: \`{permission_type}\`.`,
				disabled_success: `Members can no longer teach: \`{permission_type}\`.`,
				already_set_title: `Permission Already Set`,
				already_enabled_description: `Members are already allowed to teach \`{permission_type}\`.`,
				already_disabled_description: `Members are already prevented from teaching \`{permission_type}\`.`,
			},
			model: {
				description: `Change the underlying AI model that I use.`,
				modal_title: `Select AI Model`,
				select_label: `AI Model`,
				select_description: `Choose the AI model for me to use`,
				select_placeholder: `Choose a model...`,
				no_api_key_title: `No API Key Set`,
				no_api_key_description: `An API key must be configured before changing models. Please use \`/config apikeyset\` to set an API key first.`,
				no_models_title: `No Models Found`,
				no_models_description: `Could not load available AI models from the database.`,
				// invalid_model_title: `Invalid Model`,
				invalid_model_description: `The selected model name is not valid or available.`,
				already_selected_title: `Model Already Selected`,
				already_selected_description: `I'm is already using the \`{model_name}\` model.`,
				validating_api_key_compatibility: `Validating API key compatibility with new provider...`,
				api_key_incompatible_title: `API Key Incompatible`,
				api_key_incompatible_description: `The current API key is not compatible with the {model_name} model from {provider}. Please set a valid API key for {provider} using \`/config apikeyset\`.`,
				validation_error_title: `Validation Error`,
				validation_error_description: `An error occurred while validating API key compatibility. Please try again.`,
				success_title: `Model Updated`,
				success_description: `I will now use the \`{model_name}\` model (previously \`{previous_model}\`).`,
			},
			apikeydelete: {
				description: `Remove the currently configured AI provider API key.`,
				no_key_title: `No API Key Set`,
				no_key_description: `There is no API key currently configured to remove.`,
				success_title: `API Key Removed`,
				success_description: `The AI provider API key has been successfully removed. My chat functions are disabled until a new key is set.`,
			},
			triggerdelete: {
				description: `Remove a word that makes me respond when mentioned.`,
				no_triggers_title: `No Trigger Words`,
				no_triggers_description: `There are no custom trigger words set to remove. Add some with \`/config triggeradd\`.`,
				select_title: `Remove Trigger Word`,
				select_description: `Select the trigger word you want to remove`, // Natural line break here
				trigger_words_label: `Trigger Words`,
				modal_title: `Remove Trigger Word`,
				select_label: `Trigger Word`,
				select_placeholder: `Choose a trigger word to remove`,
				success_title: `Trigger Word Removed`,
				success_description: `Successfully removed trigger word "{triggerWord}" from the server configuration.`,
			},
			apikeyset: {
				description: `Set the API key for your chosen AI provider.`,
				modal_title: `Set API Key`,
				provider_label: `AI Provider`,
				provider_description: `Choose the AI provider for your API key`,
				provider_placeholder: `Select a provider...`,
				api_key_label: `API Key`,
				api_key_description: `Enter your API key for the selected provider. This key will be securely stored. If you are unsure on how to get one, use the \`/help apikey\` command.`,
				api_key_placeholder: `Paste your API key here...`,
				no_providers_title: `No Providers Available`,
				no_providers_description: `No AI providers are available in the database. Please contact the bot administrator.`,
				invalid_key_title: `Invalid API Key Format`,
				invalid_key_description: `The provided API key seems too short or invalid. Please provide a valid key.`,
				validating_key: `Validating API key...`,
				unsupported_provider_title: `Unsupported Provider`,
				unsupported_provider_description: `The provider "{provider}" is not currently supported for API key validation.`,
				validation_error_title: `Validation Error`,
				validation_error_description: `An error occurred while validating the API key. Please try again.`,
				key_validation_failed_title: `API Key Validation Failed`,
				key_validation_failed_description: `The provided API key is not valid for {provider}. Please check the key and try again.`,
				success_title: `API Key Set`,
				success_description: `The {provider} API key has been successfully validated, encrypted, and saved.`,
			},
			braveapiset: {
				description: `Set the Brave Search API key for this server.`,
				key_description: `Your Brave Search API key.`,
				invalid_key_title: `Invalid API Key Format`,
				invalid_key_description: `The provided API key seems too short or invalid. Please provide a valid key.`,
				validating_key: `Validating Brave Search API key...`,
				validation_error_title: `API Key Validation Error`,
				validation_error_description: `An error occurred while validating the Brave Search API key. Please try again or check your connection.`,
				key_validation_failed_title: `Brave API Key Validation Failed`,
				key_validation_failed_description: `The provided Brave Search API key is not valid. Please check the key and try again.`,
				success_title: `Brave API Key Set`,
				success_description: `The Brave Search API key has been successfully validated, encrypted, and saved.`,
			},
			braveapidelete: {
				description: `Remove the currently configured Brave Search API key.`,
				no_key_title: `No Brave API Key Set`,
				no_key_description: `There is no Brave Search API key currently configured to remove.`,
				success_title: `Brave API Key Removed`,
				success_description: `The Brave Search API key has been successfully removed.`,
			},
			rename: {
				description: `Change my name on this server.`,
				option_description: `My new name (2-32 characters).`,
				invalid_length_title: `Invalid Name Length`,
				invalid_length: `Name must be between 2 and 32 characters.`,
				already_set_title: `Name Already Set`,
				already_set_description: `My name is already set to \`{nickname}\`.`,
				success_title: `Name Updated`,
				success_description: `My name has been changed from \`{old_nickname}\` to \`{new_nickname}\`.`,
				success_with_trigger_description: `My name has been changed from \`{old_nickname}\` to \`{new_nickname}\`. Trigger words updated accordingly.`,
				success_with_discord_description: `My name has been changed from \`{old_nickname}\` to \`{new_nickname}\`, and my server nickname has been updated!`,
				success_with_trigger_and_discord_description: `My name has been changed from \`{old_nickname}\` to \`{new_nickname}\`. Trigger words and server nickname updated!`,
				nickname_update_failed_footer: `Note: Server nickname update failed (may require "Change Nickname" permission).`,
				partial_success_title: `Name Updated with Issues`,
				partial_success_description: `My name has been changed to \`{new_nickname}\`, but some trigger word updates failed.`,
			},
			setup: {
				description: `Start the initial setup process.`,
				no_presets_found: `Error: No personality presets found for your language. Cannot proceed with setup.`,
				modal_title: `Initial Setup`,
				api_provider_label: `API Provider`,
				api_provider_description: `Please choose the provider of the LLM of your choice`,
				api_provider_placeholder: `Choose...`,
				api_key_label: `API Key`,
				api_key_description: `Please enter the API key of your chosen LLM provider. This key will be securely stored. If you are unsure on how to get one, use the \`/help apikey\` command.`,
				preset_label: `Personality Preset`,
				preset_description: `Choose a personality preset`,
				preset_placeholder: `Choose a personality...`,
				api_key_invalid: `Error: The API key provided is too short or invalid.`,
				api_key_validating: `Validating API key...`,
				api_key_invalid_api: `Error: Provider rejected the API key. Please ensure it's correct.`,
				preset_invalid: `Error: Invalid preset name. Please enter one of the available preset names exactly: {available}`,
				config_invalid: `Error: Internal configuration validation failed. Please report this.`,
				setup_failed_description: `Error: Failed to save the initial setup configuration to the database. Please try again.`,
				modal_values_missing: `Error: Some required values were not received from the setup form. Please try the setup command again.`,
				provider_invalid: `Error: Invalid API provider selected. Please choose from the available options.`,
				preset_not_found: `Error: The selected preset was not found in the database. Please try again.`,
				success_title: `🎉 Setup Complete!`,
				success_desc: `I am now configured for this server! To modify my configuration, use my \`/config\` and \`/serverconfig\` commands. Here's a summary:`,
				success_desc_dm: `I am now configured for this Direct Message. Here's a summary:`,
				preset_field: `Personality Preset`,
				name_field: `My Name`,
				dm_context_explanation_title: `About Direct Messages`,
				dm_context_explanation: `I will still refer to this Direct Message as a "server". Meaning all "server" features work the same way, just privately here between us! Think of this Direct Message as a 1-on-1 server with me, therefore its server memories are my memories within here only.`,
				already_setup_title: `Already Set Up`,
				already_setup_description: `I am already set up for this server. To modify my configuration, please use other commands like \`/config humanizerdegree\`, \`/config temperature\`, \`/teach attribute\`, etc.

				If you wish to swap my provider, use the \`/config apikeyset\` command.`,
			},
			temperature: {
				description: `Set the creativity/randomness of my responses (0.1-2.0).`,
				value_description: `Value between 1.0 (predictable) and 2.0 (very random). Default: 1.5.`,
				invalid_value_title: `Invalid Temperature`,
				invalid_value_description: `Temperature must be between {min} and {max}.`,
				already_set_title: `Temperature Already Set`,
				already_set_description: `The temperature is already set to \`{temperature}\`.`,
				success_title: `Temperature Updated`,
				success_description: `LLM temperature changed from \`{previous_temperature}\` to \`{temperature}\`.`,
			},
			preset: {
				description: `Apply a preset personality configuration`,
				modal_title: `Apply Personality Preset`,
				select_label: `Personality Preset`,
				select_description: `Choose a preset to apply. This will overwrite current attributes and dialogues.`,
				select_placeholder: `Choose a preset...`,
				no_presets_title: `No Presets Available`,
				no_presets_description: `There are no personality presets available for your language. Please run \`/support report\`.`,
				preset_not_found: `The selected preset could not be found.`,
				success_title: `Preset Applied`,
				success_description: `Successfully applied the '{preset_name}' preset.`,
			},
			botpermissions: {
				description: `Configure my core behavior permissions on this server.`,
				option_description: `The specific permission to configure.`,
				selfteaching_option: `Self-Teaching`,
				personalization_option: `Personalization (Memories/Nicknames)`,
				emojiusage_option: `Emoji Usage`,
				stickerusage_option: `Sticker Usage`,
				websearch_option: "Web Search Permission",
				set_description: `Enable or disable this permission for me.`,
				already_set_title: `Permission Already Set`,
				already_enabled_description: `The permission \`{permission_type}\` is already **enabled**.`,
				already_disabled_description: `The permission \`{permission_type}\` is already **disabled**.`,
				success_title: `Permission Updated`,
				enabled_success: `My permission for \`{permission_type}\` is now **enabled**.`,
				disabled_success: `My permission for \`{permission_type}\` is now **disabled**.`,
			},
			avatar: {
				description: `Set or remove my custom avatar for this server.`,
				image_description: `Image to set as avatar (leave empty to remove custom avatar).`,
				success_title: `Avatar Updated`,
				success_description: `Successfully updated my avatar for this server.`,
				removed_title: `Avatar Reset`,
				removed_description: `Successfully reset my avatar to the default for this server.`,
				invalid_image_title: `Invalid Image`,
				invalid_image_description: `Please provide a valid image file.`,
				file_too_large_title: `File Too Large`,
				file_too_large_description: `The image file is too large. Maximum file size is 8MB.`,
				invalid_format_title: `Invalid Format`,
				invalid_format_description: `Please provide a PNG, JPG, JPEG, or GIF image file.`,
				conversion_error_title: `Conversion Error`,
				conversion_error_description: `Failed to process the image. Please try a different image file.`,
				api_error_title: `API Error`,
				api_error_description: `Failed to update the avatar through Discord's API. Please try again later.`,
			},
		},

		// Commands for teaching Tomori
		teach: {
			sampledialogue: {
				description: `Add a sample user/bot dialogue pair to as an example for how I should respond.`,
				teaching_disabled_title: `Sample Dialogue Teaching Disabled`,
				teaching_disabled_description: `Members are not currently allowed to teach/unlearn sample dialogues on this server. A server member with \`Manage Server\` permissions can enable this using \`/config memberpermissions\`.`,
				modal_title: `Add Sample Dialogue`,
				user_input_label: `User's Line`,
				user_input_description: `A sample question for the bot. Use \`{user}\` instead as a placeholder for the user's name, if used.`,
				user_input_placeholder: `What's your favorite food?`,
				bot_input_label: `My Response`,
				bot_input_description: `How the bot should respond. Use \`{bot}\` instead as a placeholder for the bot's name, if used.`,
				bot_input_placeholder: `I-I like mangoes...`,
				limit_exceeded_title: `Sample Dialogue Limit Exceeded`,
				limit_exceeded_description: `This server has reached its sample dialogue limit of {max_allowed} dialogues (currently has {current_count}). Please remove some sample dialogues with \`/unlearn sampledialogue\` before adding new ones.`,
				success_title: `Sample Dialogue Added`,
				success_description: `Successfully added a new sample dialogue pair:

**User:**
> {user_input}

**Me:**
> {bot_input}`, // Natural line breaks here
			},
			attribute: {
				description: `Add a personality attribute describing me for this server.`,
				teaching_disabled_title: `Attribute Teaching Disabled`,
				teaching_disabled_description: `Members are not currently allowed to teach/unlearn personality attributes on this server. A server member with \`Manage Server\` permissions can enable this using \`/config memberpermissions\`.`,
				modal_title: `Add Personality Attribute`,
				modal_description: `A personality trait that I have for this server. Use \`{bot}\` as a placeholder for my name, if used.`,
				attribute_input_label: `New Attribute`,
				attribute_input_placeholder: `Likes mangoes`,
				duplicate_title: `Duplicate Attribute`,
				duplicate_description: `This attribute '{attribute}' is already in my attribute list.`,
				limit_exceeded_title: `Attribute Limit Exceeded`,
				limit_exceeded_description: `This server has reached its attribute limit of {max_allowed} attributes (currently has {current_count}). Please remove some attributes with \`/unlearn attribute\` before adding new ones.`,
				success_title: `Attribute Added`,
				success_description: `Successfully added '{attribute}' to my personality attributes.`,
			},
			servermemory: {
				description: `Add a server memory to my knowledge base.`,
				teaching_disabled_title: `Server Memory Teaching Disabled`,
				teaching_disabled_description: `Members are not currently allowed to add/remove server memories on this server. A server member with \`Manage Server\` permissions can enable this using \`/config memberpermissions\`.`,
				modal_title: `Add Server Memory`,
				modal_description: `A memory that I remember for this server only. Use \`{bot}\` as a placeholder for my name, if used. For user names, use \`{user}\`.`,
				memory_input_label: `New Server Memory`,
				memory_input_placeholder: `This server's members like mangoes`,
				duplicate_title: `Duplicate Memory`,
				duplicate_description: `This memory '{memory}' is already in my memories for this server.`,
				limit_exceeded_title: `Server Memory Limit Reached`,
				limit_exceeded_description: `This server has reached its memory limit of {max_allowed} memories (currently has {current_count}). Please remove some memories with \`/unlearn servermemory\` before adding new ones.`,
				content_too_long_title: `Memory Content Too Long`,
				content_too_long_description: `The memory content is too long. Maximum allowed length is {max_length} characters.`,
				success_title: `Server Memory Added`,
				success_description: `Successfully added '{memory}' to my server memories.`,
			},
			personalmemory: {
				description: `Add a personal memory of you I can remember across any server.`,
				modal_title: `Add Personal Memory`,
				modal_description: `A memory of you that I remember no matter the server. Use \`{bot}\` as a placeholder for my name, if used. For user names, use \`{user}\`.`,
				memory_input_label: `New Personal Memory`,
				memory_input_placeholder: `Likes mangoes`,
				duplicate_title: `Duplicate Personal Memory`,
				duplicate_description: `This memory '{memory}' is already in your personal memories.`,
				limit_exceeded_title: `Personal Memory Limit Reached`,
				limit_exceeded_description: `You have reached your personal memory limit of {max_allowed} memories (currently have {current_count}). Please remove some memories with \`/unlearn personalmemory\` before adding new ones.`,
				content_too_long_title: `Memory Content Too Long`,
				content_too_long_description: `The memory content is too long. Maximum allowed length is {max_length} characters.`,
				success_title: `Personal Memory Added`,
				success_description: `Successfully added '{memory}' to your personal memories.`,
				success_but_disabled_description: `Successfully added '{memory}' to your personal memories.

**Warning:** Personalization is currently disabled on this server, so this memory won't be used here. It will still be available on other servers where personalization is enabled.`, // Natural line break
				success_but_blacklisted_description: `Successfully added '{memory}' to your personal memories.

**Warning:** You are currently blacklisted from personalization features on this server, so this memory won't be used here. It will still be available on other servers where you are not blacklisted.`, // Natural line break
			},
			nickname: {
				description: `Change the name I use to refer to you.`,
				option_description: `The nickname I should use for you (2-32 characters).`,
				invalid_length_title: `Invalid Nickname Length`,
				invalid_length: `Nickname must be between {min} and {max} characters.`,
				success_title: `Personal Nickname Updated`,
				success_description: `Okay, I'll call you '{new_nickname}' from now on (previously '{old_nickname}').`,
				success_but_disabled_description: `Okay, I'll remember to call you '{new_nickname}' (previously '{old_nickname}').

**Warning:** Personalization is currently disabled on this server, so I won't use this nickname here. I'll still use it on other servers where personalization is enabled.`, // Natural line break
			},
		},

		// Commands for making Tomori unlearn things
		unlearn: {
			sampledialogue: {
				description: `Remove a sample user/bot dialogue pair from my memory.`,
				modal_title: `Remove Sample Dialogue`,
				select_label: `Dialogue to Remove`,
				select_description: `Choose which dialogue pair to remove`,
				select_placeholder: `Select a dialogue...`,
				no_dialogues_title: `No Sample Dialogues`,
				no_dialogues: `There are no sample dialogues stored to remove. Add some with \`/teach sampledialogue\`.`,
				select_title: `Remove Sample Dialogue`,
				dialogue_label: `Dialogue Pair`,
				success_title: `Sample Dialogue Removed`,
				success_description: `Successfully removed the dialogue pair: User: "{input}" → Bot: "{output}"`,
			},
			attribute: {
				description: `Remove a personality attribute from my memory.`,
				modal_title: `Remove Attribute`,
				select_label: `Attribute to Remove`,
				select_description: `Choose which attribute to remove from my personality`,
				select_placeholder: `Select an attribute...`,
				no_attributes_title: `No Attributes`,
				no_attributes: `There are no personality attributes to remove. Add some with \`/teach attribute\`.`,
				select_title: `Remove Attribute`,
				attribute_label: `Attribute`,
				success_title: `Attribute Removed`,
				success_description: `Successfully removed the attribute: "{attribute}"`,
			},
			servermemory: {
				description: `Remove a server memory from my knowledge.`,
				modal_title: `Remove Server Memory`,
				select_label: `Memory to Remove`,
				select_description: `Choose which server memory to remove`,
				select_placeholder: `Select a memory...`,
				no_memories_title: `No Server Memories`,
				no_memories: `There are no server memories stored for this server. Add some with \`/teach servermemory\`.`,
				no_owned_memories: `You don't own any server memories that can be removed.`,
				memory_not_found: `The selected memory could not be found.`,
				select_title: `Remove Server Memory`,
				memory_label: `Server Memory`,
				success_title: `Server Memory Removed`,
				success_description: `Successfully removed the server memory: "{memory}"`,
			},
			personalmemory: {
				description: `Remove a personal memory.`,
				modal_title: `Remove Personal Memory`,
				select_label: `Memory to Remove`,
				select_description: `Choose which personal memory to remove`,
				select_placeholder: `Select a memory...`,
				no_memories_title: `No Personal Memories`,
				no_memories: `You don't have any personal memories stored. Add some with \`/teach personalmemory\`.`,
				select_title: `Remove Personal Memory`,
				memory_label: `Personal Memory`,
				success_title: `Personal Memory Removed`,
				success_description: `Successfully removed the personal memory: "{memory}"`,
				warning_disabled_title: `Personalization Disabled`,
				warning_disabled_description: `The memory was successfully removed.

**Warning:** Personalization is currently disabled on this server, so this change won't affect my behavior here. It will still be reflected on other servers where personalization is enabled.`, // Natural line break
			},
		},
	},

	events: {
		// Messages for when the bot is added to a server
		addBot: {
			rejoin_title: `TomoriBot is Back!`,
			rejoin_description: `Looks like I was re-added to this server. My previous settings and personality are still intact! You can manage me using the \`/config\`, \`/teach\`, and \`unlearn\` commands.

			If you wish to swap my provider, use the \`/config apikeyset\` command.

			**IMPORTANT NOTICE:** I do not save any of your Discord messages. I only store Memories and relevant Settings, all of which you can freely delete and modify using my slash commands. However, the AI providers you choose to power me can have different privacy policies. If you or your server's members do not agree with your chosen provider's privacy policies, please refrain from using me. **Otherwise, just make sure to never share any personal information**.`,
			setup_prompt_title: `TomoriBot Successfully Added`,
			setup_prompt_description: `Thanks for adding me! To get started, someone with the **Manage Server** permission needs to run my \`/config setup\` command to choose my initial personality and configure my AI features. 
			
			Use the \`/help apikey\` command if you are unsure on how to create an API key for your chosen AI provider. API keys will be kept encrypted but if you are still wary of giving it to a public Discord bot (as you normally should), feel free to run your own TomoriBot using the [repository's guide](https://github.com/Eliolocin/TomoriBot) instead.

			**IMPORTANT NOTICE:** I do not save any of your Discord messages. I only store Memories and relevant Settings, all of which you can freely delete and modify using my slash commands. However, the AI providers you choose to power me can have different privacy policies. If you or your server's members do not agree with your chosen provider's privacy policies, please refrain from using me. **Otherwise, just make sure to never share any personal information**.`,
		},
	},

	// Reminder system messages
	reminders: {
		// Confirmation embed when reminder is set
		reminder_set_title: `⏰ Reminder Set`,
		reminder_set_description: `I'll remind {user_nickname} about "**{reminder_purpose}**" at \`{reminder_time}\``,
		reminder_set_footer: `A mention will be sent after {time_remaining} from now.`,

		// Error embed when reminder delivery fails (only user-facing embed during execution)
		reminder_error_title: `Reminder Delivery Failed`,
		reminder_error_description: `{user_mention}'s reminder for "**{reminder_purpose}**" encountered an issue: {error_reason}. {lateness}.`,
		reminder_error_footer: `The reminder has been delivered manually instead because of a technical issue.`,
	},
};
