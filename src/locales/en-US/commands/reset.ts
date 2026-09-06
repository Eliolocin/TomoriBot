export default {
  reset: {
    description: "Reset server or personal configuration to defaults.",
    config: {
      description: "Reset this server's configuration to database defaults.",
      confirm_title: "Reset Server Configuration",
      confirm_description:
        "> This restores server settings to database defaults.\n> Authored prompts, notes, and tag lists will be reset.\n>\n> Affected sections:\n> • Persona: 0 settings (all personas are preserved)\n> • Behavior: 9 settings (system prompt, notes, triggers)\n> • Channels: 6 settings (channel rules, auto-triggers)\n> • Permissions: 11 settings (capabilities, permissions)\n> • Models: 3 settings (samplers, fallbacks; IDs preserved)\n>\n> Not touched:\n> Memories, expressions, personas, providers,\n> recorded quota consumption, and external\n> integrations are kept intact.\n-# Personas: use `/persona remove`\n-# Memories: use `/memories` or `/personal memories`\n-# Providers: use `/providers` or `/personal providers`\n-# Scheduled tasks: use `/scheduled-task remove`\n-# Full server wipe: use `/nuke`",
      confirm_button: "Reset Configuration",
      no_permission_title: "Permission Denied",
      no_permission_description: "You need the Manage Server permission to reset this server's configuration.",
      no_server_data_title: "No Server Data",
      no_server_data_description: "No configuration was found for this server.",
      success_title: "Configuration Reset",
      success_description: "Server configuration has been reset to database defaults.",
    },
    personal: {
      description: "Personal configuration commands.",
      config: {
        description: "Reset your personal configuration to database defaults.",
        confirm_title: "Reset Personal Configuration",
        confirm_description:
          "> This restores personal settings to database defaults.\n>\n> Affected sections:\n> • Profile: nickname, appearance, gender, pronouns\n> • Privacy: privacy level, cross-server opt-in\n> • Advanced: response mode, impersonation, spotlights\n> • Models: 0 settings (all provider settings preserved)\n>\n> Not touched:\n> Saved provider configs, custom endpoints, personal\n> memories, and scheduled tasks are kept intact.\n-# Providers: use `/personal providers`\n-# Memories: use `/personal memories`\n-# Scheduled tasks: use `/scheduled-task remove`",
        confirm_button: "Reset Configuration",
        success_title: "Personal Configuration Reset",
        success_description: "Personal configuration and channel spotlights have been reset to database defaults.",
      },
    },
  },
};
