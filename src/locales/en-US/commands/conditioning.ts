export default {
  conditioning: {
    description: `Manage persistent reward and punishment conditioning memories.`,
    shared: {
      select_persona_title: `Select a persona to manage`,
      reason_line: `Reason: \`\`{reason}\`\``,
      reward_footer: `❤️ {bot} will remember this. Use /conditioning to manage.`,
      punish_footer: `💀 {bot} will remember this. Use /conditioning to manage.`,
      persona_access_blocked_title: `No Available Personas`,
      persona_access_blocked_description: `Your current whitelist permissions and personal spotlight settings do not leave any personas available for this interaction in this channel.`,
      marker_reward: `❤️`,
      marker_punish: `💀`,
      option_reason_description: `{count} total • due to: "{reason}"`,
      option_reason_description_single: `due to: "{reason}"`,
      option_label: `{type_marker} {persona_name} • {action}`,
    },
    manage: {
      description: `Manage injected conditioning history across all personas in this server.`,
    },
    remove: {
      description: `Remove conditioning entries across every persona in this server.`,
      empty_title: `No Conditioning Memories`,
      empty_description: `There are no persistent conditioning entries to manage in this server.`,
      page_select_prompt: `Found {total} conditioning entries. Select a batch to remove:`,
      page_select_prompt_capped: `Found {total} conditioning entries. The {shown} most recent are
shown below; remove some to reach the rest.`,
    },
    panel: {
      remove_modal_title: `Remove Conditioning`,
      remove_checkbox_label: `Conditioning Entries`,
      remove_checkbox_label_continued: `Conditioning Entries (Continued)`,
      remove_checkbox_description: `Uncheck any conditioning entries you want to remove.`,
      stale_heading: `Panel Out Of Date`,
      stale_detail: `Conditioning entries changed. The panel has been refreshed.`,
      no_changes_heading: `No Changes`,
      no_changes_detail: `No conditioning entries were unchecked.`,
      success_heading: `Conditioning Removed`,
      success_detail: `Removed {count} conditioning entry(s).`,
      write_failed_heading: `Update Failed`,
      write_failed_detail: `The change could not be saved. Please try again.`,
    },
  },
};
