// locales/en.ts (or your desired file name)

// Export the entire locale structure as a default object
export default {
	general: {
		// Cooldown messages
		cooldown_title: `Please wait!`,
		cooldown: `⏳ You need to wait {seconds} seconds before using a \`/{category}\` command again.`,

		// Standard interaction responses (buttons, selects)
		interaction: {
			cancel_title: `❌ Operation Cancelled`,
			cancel_description: `The operation has been cancelled. You can try again anytime!`,
			timeout_title: `⏰ Operation Timed Out`,
			timeout_description: `You didn't respond in time. Please try again if you'd like to continue.`,
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
		},

		// Common error messages
		errors: {
			guild_only_title: `Server Only Command`,
			guild_only_description: `This command can only be used within a server channel.`,
			dm_not_supported_title: `DMs Not Supported`,
			dm_not_supported_description: `Sorry, I can only chat within server channels, not in Direct Messages.`,
			tomori_not_setup_title: `Tomori Not Configured`,
			tomori_not_setup_description: `It seems I haven't been set up on this server yet. An administrator needs to use \`/config setup\` first.`,
			api_key_missing_title: `API Key Missing`,
			api_key_missing_description: `I need a Google Gemini API key to function, but one hasn't been configured for this server. An administrator can set one using \`/config apikeyset\`.`,
			api_key_error_title: `API Key Error`,
			api_key_error_description: `There was an issue accessing or decrypting the configured API key. Please ensure it was set correctly.`,
			context_error_title: `Context Building Error`,
			context_error_description: `I encountered an error while trying to understand the conversation context. Please try again.`,
			critical_error_title: `Critical Error`,
			critical_error_description: `An unexpected critical error occurred while processing your message. Please report this if it persists.`,
			update_failed_title: `Update Failed`,
			update_failed_description: `Failed to update the configuration in the database. Please try again.`,
			unknown_error_title: `Unknown Error`,
			unknown_error_description: `An unexpected error occurred. Please try again or report this if it persists.`,
			invalid_option_title: `Invalid Option`,
			invalid_option_description: `The selected option is invalid. Please choose a valid option.`,
		},
	},

	gemini: {
		// Errors related to Gemini API generation
		generic_error_title: `Generation Error`,
		generic_error_description: `Sorry, I encountered an error while trying to generate a response. Please try again later.`,
		safety_block_title: `Content Blocked`,
		safety_block_description: `I couldn't process the request or generate a response because it was flagged for safety reasons ({reason}). Please modify your prompt or try something different.`,
		api_error_title: `Gemini API Error`,

		// Specific Gemini API error codes
		"400_invalid_argument_description": `**400 INVALID_ARGUMENT:** The request was malformed (e.g., typo, missing field). Check API documentation if configuring manually.`,
		"400_failed_precondition_description": `**400 FAILED_PRECONDITION:** The Gemini API free tier might not be available in your region, or billing needs to be enabled on the associated Google Cloud project.`,
		"403_permission_denied_description": `**403 PERMISSION_DENIED:** The provided API key is invalid, expired, or lacks the necessary permissions for the selected model.`,
		"404_not_found_description": `**404 NOT_FOUND:** A resource required for the request (like an image or file) wasn't found, or the model name is incorrect.`,
		"429_resource_exhausted_description": `**429 RESOURCE_EXHAUSTED:** Too many requests are being sent. Please wait a moment before trying again (Rate Limit Exceeded).`,
		"500_internal_description": `**500 INTERNAL:** An unexpected error occurred on Google's side. This might be due to a very long prompt/context. Try reducing the input or try again later.`,
		"503_unavailable_description": `**503 UNAVAILABLE:** The Gemini service is temporarily overloaded or unavailable. Please wait a bit and try again.`,
		"504_deadline_exceeded_description": `**504 DEADLINE_EXCEEDED:** The request took too long to process, possibly due to a very large prompt or context. Try reducing the input.`,
		unknown_api_error_description: `An unexpected error occurred while communicating with the Gemini API: \`{error}\``,

		// Empty response from API
		empty_response_title: `Empty Response`,
		empty_response_description: `I received an empty response from the AI. This might happen sometimes. Please try rephrasing or try again.`,
	},

	functions: {
		// Locales for built-in functions (e.g., image search)
		scrapeBooru: {
			title: `Booru Search`,
			description: `Quickly get up to 4 random 'SFW' HQ posts for: \`{query}\`
Filtered Query: \`{filtered_query}\``,
			error_not_nsfw: `Sorry, you can only use this command in NSFW channels!`,
			error_no_results: `Sowwy, I didn't find any posts for: \`{query}\`.
Try a different prompt or try \`/rule34\` instead!`,
			progress_message: `Downloading posts and uploading them in random...`,
			query_comparison_title: `Search Query Translation`,
			query_comparison_description: `Your tags: \`{original}\`
Searching for: \`{filtered}\``,
			result_title: `Original: {source}`,
			result_original: `(No source provided)`,
			result_footer: `Score: {score} | Tags: {tags}`,
		},
		generateImage: {
			description: `Quickly generate an image from a prompt using Stable Diffusion!`,
			progress: `🎨 Generating your image for: \`{prompt}\`...`,
			result: `✨ Here's what I generated for \`{prompt}\` (b ᵔ▽ᵔ)b`,
			error: `🚫 Something went wrong while generating the image. Please try again later.`,
		},
	},

	commands: {
		// General utility commands
		tool: {
			ping: {
				description: `Check the bot's latency.`,
				title: `Pong!`,
				description_content: `My current ping is {ping}ms.`,
				response_fast: `Pong! 🏓
Response Time: \`{response_time}ms\`
Discord API Latency: \`{discord_response}ms\``,
				response_slow: `Pong! 🐢 (A bit slow...)
Response Time: \`{response_time}ms\`
Discord API Latency: \`{discord_response}ms\``,
			},
			refresh: {
				description: `Clears the recent conversation history for Tomori.`,
				title: `Conversation History Cleared`,
				response: `🧹 Okay, I've cleared my short-term memory of our recent chat! Let's start fresh. (This message signals a refresh)`,
			},
			status: {
				description: `Show Tomori's current configuration or personality status.`,
				type_description: `Which status aspect to display?`,
				type_choice_config: `Configuration`,
				type_choice_personality: `Personality`,
				config_title: `Tomori Configuration Status`,
				config_description: `Current operational settings for Tomori.`,
				personality_title: `Tomori Personality Status`,
				personality_description: `Current personality settings for Tomori.`,
				field_model: `AI Model`,
				field_temperature: `Temperature`,
				field_humanizer: `Humanizer Level`,
				field_autoch_threshold: `Auto-Chat Threshold`,
				field_autoch_channels: `Auto-Chat Channels`,
				field_trigger_words: `Trigger Words`,
				field_personalization: `Personalization`,
				field_self_teach: `Self-Teaching`,
				field_api_key_set: `API Key Set`,
				field_nickname: `Nickname`,
				field_dialogue_count: `Sample Dialogues`,
				field_server_memory_count: `Server Memories`,
				field_attributes: `Attributes`,
				item_count: `{count} items`,
				none: `None`,
				disabled: `Disabled`,
				unknown_channel: `Unknown Channel ID:`,
				not_available: `N/A`,
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
				command_description: `Add a word that makes Tomori respond when mentioned.`,
				word_description: `The word to add as a trigger.`,
				too_short_title: `Trigger Word Too Short`,
				too_short_description: `Trigger words must be at least 2 characters long.`,
				already_exists_title: `Trigger Word Exists`,
				already_exists_description: `The word \`{word}\` is already in the trigger list.`,
				success_title: `Trigger Word Added`,
				success_description: `Successfully added \`{word}\` as a trigger word. There are now {word_count} trigger words.`,
			},
			autochchannels: {
				command_description: `Add or remove channels where Tomori will automatically chat.`,
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
				command_description: `Set the message count threshold for Tomori to auto-chat (0 to disable).`,
				threshold_description_v2: `Messages needed before auto-chat (0 to disable, or 30-100).`,
				invalid_range_title: `Invalid Threshold`,
				invalid_range_specific_description: `The threshold must be exactly \`{min}\` (to disable) or between \`{range_start}\` and \`{max}\`.`,
				success_title: `Auto-Chat Threshold Set`,
				success_description: `Tomori will now automatically chat after \`{threshold}\` messages in designated channels.`,
				success_disabled_title: `Auto-Chat Disabled`,
				success_disabled_description: `Auto-chat feature is now disabled (threshold set to \`{threshold}\`).`,
			},
			blacklist: {
				command_description: `Add or remove a member from the personalization blacklist.`,
				member_description: `The member to add or remove from the blacklist.`,
				action_description: `Whether to add or remove the member.`,
				personalization_disabled_title: `Personalization Disabled`,
				personalization_disabled_description: `Personalization is currently disabled server-wide. Enable it first with \`/config personalization\`.`,
				already_blacklisted_title: `Already Blacklisted`,
				already_blacklisted_description: `\`{user_name}\` is already on the personalization blacklist.`,
				not_blacklisted_title: `Not Blacklisted`,
				not_blacklisted_description: `\`{user_name}\` is not on the personalization blacklist.`,
				added_title: `Member Blacklisted`,
				added_description: `Added \`{user_name}\` to the personalization blacklist. Their personal memories and nickname won't be used.`,
				removed_title: `Member Unblacklisted`,
				removed_description: `Removed \`{user_name}\` from the personalization blacklist. Their personal memories and nickname can now be used.`,
			},
			humanizerdegree: {
				command_description: `Set how 'human-like' Tomori's responses should feel.`,
				value_description: `The level of humanization (0=None, 1=Prompt, 2=Typing/Chunking, 3=Lowercase/No Punctuation).`,
				choice_none: `0: None (Raw AI Output)`,
				choice_light: `1: Light (Prompt Injection - Default)`,
				choice_medium: `2: Medium (Typing Simulation & Chunking)`,
				choice_heavy: `3: Heavy (Lowercase & No Punctuation)`,
				invalid_value_title: `Invalid Value`,
				invalid_value_description: `Humanizer degree must be between {min} and {max}.`,
				already_set_title: `Humanizer Already Set`,
				already_set_description: `The humanizer degree is already set to \`{value}\`.`,
				success_title: `Humanizer Degree Updated`,
				success_description: `Humanizer degree changed from \`{previous_value}\` to \`{value}\`.`,
			},
			memberpermissions: {
				command_description: `Configure what non-admin members can teach Tomori.`,
				option_description: `The type of memory members can teach.`,
				servermemories_option: `Server Memories`,
				attributelist_option: `Attribute List`,
				sampledialogues_option: `Sample Dialogues`,
				set_description: `Enable or disable this permission for members.`,
				success_title: `Member Permissions Updated`,
				enabled_success: `Members can now teach: \`{permission_type}\`.`,
				disabled_success: `Members can no longer teach: \`{permission_type}\`.`,
			},
			model: {
				command_description: `Change the underlying AI model Tomori uses.`,
				name_description: `Select the desired Gemini model.`,
				no_models_title: `No Models Found`,
				no_models_description: `Could not load available AI models from the database.`,
				invalid_model_title: `Invalid Model`,
				invalid_model_description: `The selected model name is not valid or available.`,
				already_selected_title: `Model Already Selected`,
				already_selected_description: `Tomori is already using the \`{model_name}\` model.`,
				success_title: `Model Updated`,
				success_description: `Tomori will now use the \`{model_name}\` model (previously \`{previous_model}\`).`,
			},
			nickname: {
				command_description: `Change the name Tomori uses for herself.`,
				option_description: `The new nickname for Tomori (2-32 characters).`,
				invalid_length_title: `Invalid Nickname Length`,
				invalid_length_description: `Nickname must be between {min} and {max} characters.`,
				success_title: `Nickname Updated`,
				success_description: `Tomori's nickname changed from \`{old_nickname}\` to \`{new_nickname}\`.`,
			},
			apikeydelete: {
				command_description: `Remove the currently configured Gemini API key.`,
				no_key_title: `No API Key Set`,
				no_key_description: `There is no API key currently configured to remove.`,
				success_title: `API Key Removed`,
				success_description: `The Gemini API key has been successfully removed. Tomori will stop responding until a new key is set.`,
			},
			triggerdelete: {
				command_description: `Remove a word that makes Tomori respond when mentioned.`,
				no_triggers_title: `No Trigger Words`,
				no_triggers_description: `There are no custom trigger words set to remove. Add some with \`/config triggeradd\`.`,
				select_title: `Remove Trigger Word`,
				select_description: `Select the trigger word you want to remove:

{items}`, // Natural line break here
				trigger_words_label: `Trigger Words`,
			},
			apikeyset: {
				command_description: `Set the Google Gemini API key for this server.`,
				key_description: `Your Google Gemini API key.`,
				invalid_key_title: `Invalid API Key Format`,
				invalid_key_description: `The provided API key seems too short or invalid. Please provide a valid key.`,
				validating_key: `Validating API key with Google...`,
				key_validation_failed_title: `API Key Validation Failed`,
				key_validation_failed_description: `The provided API key is not valid according to Google. Please check the key and try again.`,
				success_title: `API Key Set`,
				success_description: `The Google Gemini API key has been successfully validated, encrypted, and saved.`,
			},
			setup: {
				command_description: `Start the initial setup process for Tomori.`,
				no_presets_found: `Error: No personality presets found for your language. Cannot proceed with setup.`,
				modal_title: `Tomori Initial Setup`,
				api_key_label: `Google Gemini API Key`,
				preset_label: `Personality Preset Name`,
				humanizer_label: `Humanizer Level (0-3)`,
				api_key_invalid: `Error: The API key provided is too short or invalid.`,
				api_key_validating: `Validating API key with Google...`,
				api_key_invalid_api: `Error: Google rejected the API key. Please ensure it's correct and has Gemini API enabled.`,
				preset_invalid: `Error: Invalid preset name. Please enter one of the available preset names exactly: {available}`,
				humanizer_invalid: `Error: Invalid humanizer level. Please enter a number between 0 and 3.`,
				config_invalid: `Error: Internal configuration validation failed. Please report this.`,
				setup_failed_description: `Error: Failed to save the initial setup configuration to the database. Please try again.`,
				success_title: `🎉 Tomori Setup Complete! 🎉`,
				success_desc: `Tomori is now configured for this server. Here's a summary:`,
				preset_field: `Personality Preset`,
				humanizer_field: `Humanizer Level`,
				name_field: `Tomori's Name`,
				modal_timeout: `Setup timed out. Please run \`/config setup\` again.`,
				already_setup_title: `Tomori Already Set Up`,
				already_setup_description: `Tomori is already set up for this server. To modify Tomori's configuration, please use other commands like \`/config humanizerdegree\`, \`/config temperature\`, \`/teach attribute\`, etc.`,
			},
			temperature: {
				command_description: `Set the creativity/randomness of Tomori's responses (0.1-2.0).`,
				value_description: `Value between 1.0 (predictable) and 2.0 (very random). Default: 1.5.`,
				invalid_value_title: `Invalid Temperature`,
				invalid_value_description: `Temperature must be between {min} and {max}.`,
				already_set_title: `Temperature Already Set`,
				already_set_description: `The temperature is already set to \`{temperature}\`.`,
				success_title: `Temperature Updated`,
				success_description: `LLM temperature changed from \`{previous_temperature}\` to \`{temperature}\`.`,
			},
			preset: {
				command_description: `Apply a preset personality configuration to Tomori`,
				no_presets_title: `No Presets Available`,
				no_presets_description: `There are no personality presets available for your language. Please contact the bot administrator.`,
				select_title: `Select Personality Preset`,
				select_description: `Choose a preset to apply to Tomori.

⚠️ **Warning:** This will overwrite the current Attribute List and Sample Dialogues!

{items}`, // Natural line breaks here
				preset_label: `Preset`,
				success_title: `Preset Applied`,
				success_description: `Successfully applied the '{preset}' preset to Tomori.`,
			},
			tomoripermissions: {
				command_description: `Configure Tomori's core behavior permissions on this server.`,
				option_description: `The specific Tomori permission to configure.`,
				selfteaching_option: `Self-Teaching`,
				personalization_option: `Personalization (Memories/Nicknames)`,
				emojiusage_option: `Emoji Usage`,
				stickerusage_option: `Sticker Usage`,
				set_description: `Enable or disable this permission for Tomori.`,
				already_set_title: `Permission Already Set`,
				already_enabled_description: `The permission \`{permission_type}\` is already **enabled**.`,
				already_disabled_description: `The permission \`{permission_type}\` is already **disabled**.`,
				success_title: `Tomori Permission Updated`,
				enabled_success: `Tomori's permission for \`{permission_type}\` is now **enabled**.`,
				disabled_success: `Tomori's permission for \`{permission_type}\` is now **disabled**.`,
			},
		},

		// Commands for teaching Tomori
		teach: {
			sampledialogue: {
				command_description: `Add a sample user/bot dialogue pair to Tomori's memory.`,
				teaching_disabled_title: `Sample Dialogue Teaching Disabled`,
				teaching_disabled_description: `Members are not currently allowed to teach sample dialogues on this server. An admin can enable this using \`/config memberpermissions\`.`,
				modal_title: `Add Sample Dialogue`,
				user_input_label: `User's Line`,
				bot_input_label: `Tomori's Response`,
				success_title: `Sample Dialogue Added`,
				success_description: `Successfully added a new sample dialogue pair:

**User:**
> {user_input}

**Tomori:**
> {bot_input}`, // Natural line breaks here
			},
			attribute: {
				command_description: `Add a personality attribute to Tomori's memory.`,
				teaching_disabled_title: `Attribute Teaching Disabled`,
				teaching_disabled_description: `Members are not currently allowed to teach personality attributes on this server. An admin can enable this using \`/config memberpermissions\`.`,
				modal_title: `Add Personality Attribute`,
				attribute_input_label: `New Attribute`,
				duplicate_title: `Duplicate Attribute`,
				duplicate_description: `This attribute '{attribute}' is already in Tomori's attribute list.`,
				success_title: `Attribute Added`,
				success_description: `Successfully added '{attribute}' to Tomori's personality attributes.`,
			},
			servermemory: {
				command_description: `Add a server memory to Tomori's knowledge.`,
				teaching_disabled_title: `Server Memory Teaching Disabled`,
				teaching_disabled_description: `Members are not currently allowed to add server memories on this server. An admin can enable this using \`/config memberpermissions\`.`,
				modal_title: `Add Server Memory`,
				memory_input_label: `New Server Memory`,
				duplicate_title: `Duplicate Memory`,
				duplicate_description: `This memory '{memory}' is already in Tomori's server memories.`,
				success_title: `Server Memory Added`,
				success_description: `Successfully added '{memory}' to Tomori's server memories.`,
			},
			personalmemory: {
				command_description: `Add a personal memory only you can see.`,
				modal_title: `Add Personal Memory`,
				memory_input_label: `New Personal Memory`,
				duplicate_title: `Duplicate Personal Memory`,
				duplicate_description: `This memory '{memory}' is already in your personal memories.`,
				success_title: `Personal Memory Added`,
				success_description: `Successfully added '{memory}' to your personal memories.`,
				success_but_disabled_description: `Successfully added '{memory}' to your personal memories.

**Warning:** Personalization is currently disabled on this server, so this memory won't be used here. It will still be available on other servers where personalization is enabled.`, // Natural line break
			},
			usernickname: {
				command_description: `Change the name Tomori uses to refer to you.`,
				option_description: `The nickname Tomori should use for you (2-32 characters).`,
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
				command_description: `Remove a sample user/bot dialogue pair from Tomori's memory.`,
				no_dialogues_title: `No Sample Dialogues`,
				no_dialogues: `There are no sample dialogues stored to remove. Add some with \`/teach sampledialogue\`.`,
				select_title: `Remove Sample Dialogue`,
				select_description: `Select the dialogue pair you want to remove:

{items}`, // Natural line break
				dialogue_label: `Dialogue Pair`,
			},
			attribute: {
				command_description: `Remove a personality attribute from Tomori's memory.`,
				no_attributes_title: `No Attributes`,
				no_attributes: `There are no personality attributes to remove. Add some with \`/teach attribute\`.`,
				select_title: `Remove Attribute`,
				select_description: `Select the attribute you want to remove:

{items}`, // Natural line break
				attribute_label: `Attribute`,
			},
			servermemory: {
				command_description: `Remove a server memory from Tomori's knowledge.`,
				no_memories_title: `No Server Memories`,
				no_memories: `There are no server memories stored for this server. Add some with \`/teach servermemory\`.`,
				select_title: `Remove Server Memory`,
				select_description: `Select the server memory you want to remove:

{items}`, // Natural line break
				memory_label: `Server Memory`,
			},
			personalmemory: {
				command_description: `Remove a personal memory.`,
				no_memories_title: `No Personal Memories`,
				no_memories: `You don't have any personal memories stored. Add some with \`/teach personalmemory\`.`,
				select_title: `Remove Personal Memory`,
				select_description: `Select the personal memory you want to remove:

{items}`, // Natural line break
				memory_label: `Personal Memory`,
				warning_disabled_title: `Personalization Disabled`,
				warning_disabled_description: `The memory was successfully removed from your profile.

**Warning:** Personalization is currently disabled on this server, so this change won't affect Tomori's behavior here. It will still be reflected on other servers where personalization is enabled.`, // Natural line break
			},
		},
	},

	events: {
		// Messages related to the main chat event handler
		tomoriChat: {
			setup_required_title: `Bot Setup Required`,
			setup_required_description: `To use the chat feature, please set up the following:
• At least 2 conversation examples using \`/teach convo\`
• At least 1 info entry using \`/teach info\`
You may also use \`/setup\` to easily choose a personality preset for the bot.`, // Natural line breaks
			safety_error_title: `Safety Filter Triggered`,
			safety_error_description: `🚫 Gemini's safety filters blocked the response. This usually happens when the content might violate Google's safety measures.`,
			dm_not_supported_title: `Tomori Unavailable in DMs`,
			dm_not_supported_description: `Tomori can only be used in servers, not in direct messages.`,
			api_key_missing_title: `API Key Missing`,
			api_key_missing_description: `Tomori needs an API key to work. Please ask a server admin to set one up using the \`/config apikeyset\` command.`,
			api_key_error_title: `API Key Error`,
			api_key_error_description: `There was a problem with the API key. Please ask a server admin to check or reset it using the \`/config apikeyset\` command.`,
			generation_error_title: `Response Generation Error`,
			generation_error_description: `I encountered an error while generating a response. Please try again later.`,
			context_error_title: `Context Building Error`,
			context_error_description: `I encountered an error building context for this conversation. Please try again later.`,
			critical_error_title: `Unexpected Error`,
			critical_error_description: `Something went wrong. Please try again later or contact support if this persists.`,
		},

		// Messages for when the bot is added to a server
		addBot: {
			rejoin_title: `I'm Back!`,
			rejoin_description: `Hey there! Looks like I was re-added to this server. My previous settings and personality are still intact! You can manage me using the \`/teach\` and \`/settings\` commands.`,
			setup_prompt_title: `Thanks for adding TomoriBot!`,
			setup_prompt_description: `Hello! Thanks for adding me! To get started, someone with the **Manage Server** permission needs to run my \`/setup\` command to choose my initial personality and configure my AI features.`,
		},
	},
};
