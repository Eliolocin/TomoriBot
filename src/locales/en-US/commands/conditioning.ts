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
    },
    manage: {
      description: `Manage injected conditioning history across all personas in this server.`,
      marker_reward: `❤️`,
      marker_punish: `💀`,
      none_title: `Nothing to Manage`,
      none_description: `There are no injected conditioning entries to manage in this server.`,
      too_many_title: `Too Many Entries`,
      too_many_description: `Found {total_entries} entries across {total_pages} pages. The current limit is {max_pages} pages.`,
      select_page_title: `Select a Conditioning Page`,
      select_page_description: `Select which page of injected conditioning entries to manage.
Entries: {total_entries}
Pages: {total_pages}
Each entry shows the persona and whether it is a reward or punishment record.`,
      checkbox_label: `Conditioning Entries`,
      checkbox_label_continued: `Conditioning Entries (Continued)`,
      checkbox_description: `Leave an entry checked to keep it. Uncheck it to delete that injected conditioning group.`,
      option_reason_description: `{count} total • due to: "{reason}"`,
      option_reason_description_single: `due to: "{reason}"`,
      option_label: `{type_marker} {persona_name} • {action}`,
      modal_title: `Manage Conditioning`,
      done_button: `Done`,
      no_changes_title: `No Changes Made`,
      no_changes_description: `Everything stayed checked, so nothing was removed.`,
      success_title: `Conditioning Updated`,
      success_description: `Removed {reward_groups} reward groups and {punish_groups} punishment groups across {persona_count} persona(s) ({deleted_rows} stored rows deleted).`,
    },
  },
};
