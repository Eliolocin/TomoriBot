export default {
  "st-preset": {
    description: `Manage SillyTavern presets. See SillyTavern Presets in /help.`,
    import: {
      description: `Import a SillyTavern preset JSON file. See SillyTavern Presets in /help.`,
      file_description: `The SillyTavern preset .json file to import`,
      invalid_file_title: `Invalid File`,
      file_too_large_title: `File Too Large`,
      file_too_large_description: `The preset file must be under {max_size} MB.`,
      download_failed: `Failed to download the attachment. Please try again.`,
      invalid_json: `The file could not be parsed as valid JSON.`,
      not_a_preset_title: `Unsupported Preset Format`,
      not_a_preset_description: `This doesn't look like a supported SillyTavern preset. Only **Chat Completions** presets are supported: either a Prompt Manager \`prompts\` array, or an older preset with \`context.story_string\` + \`sysprompt.content\`.\n\n**Text-completions presets** (which use an \`instruct\` block) are not supported.`,
      no_nodes: `No usable prompt nodes were found in this preset.`,
      success_title: `Preset Imported`,
      success_description: `**{name}** has been imported.

• **{total}** total nodes
• **{markers}** structural markers
• **{toggleable}** toggleable nodes (**{enabled}** enabled)
{notes}
Use {stPresetToggle} to adjust which nodes are active.
Use {helpStPreset} (Integrations > SillyTavern Presets) to learn how imported presets behave here.
Use {stPresetRemove} to revert to default behavior.`,
      note_comment_only: `> **{count}** comment-only node(s) are visible in \`/st-presets\` but are never injected into the prompt.`,
      note_disabled_by_preset: `> **{count}** node(s) are disabled by default in this preset. Use \`/st-presets\` to enable them.`,
      note_unsupported_macros: `> Enabled node(s) still reference unsupported preset macros: {macros}. Those parts may be sent literally or behave differently here.`,
      note_legacy_text_completion: `> This older text-completions preset was converted best-effort from legacy \`story_string\` fields. ST-only blocks such as \`persona\`, \`scenario\`, anchors, stop strings, and backend settings are still ignored.`,
    },
    remove: {
      description: `Remove imported SillyTavern presets`,
      no_preset_title: `No Presets Found`,
      no_preset_description: `No SillyTavern presets have been imported for this server. Nothing to remove.`,
      modal_title: `Remove Presets`,
      checkbox_label: `Presets (uncheck to remove)`,
      checkbox_label_continued: `Presets (continued)`,
      checkbox_description: `Uncheck any preset to delete it. Checked presets are kept.`,
      no_removals_title: `No Presets Removed`,
      no_removals_description: `All presets were kept. Uncheck at least one to remove it.`,
      failed_title: `Removal Failed`,
      failed_description: `Failed to remove one or more presets. Please try again.`,
      success_title: `Preset(s) Removed`,
      success_description: `Removed **{count}** preset(s): {names}{promoted_note}`,
      auto_promoted_note: `

**{name}** has been set as the new active preset.`,
    },
    switch: {
      description: `Switch the active SillyTavern preset`,
      modal_title: `Switch Active Preset`,
      select_label: `Select a preset to activate`,
      select_placeholder: `Choose a preset...`,
      no_presets_title: `No Presets Found`,
      no_presets_description: `No SillyTavern presets have been imported. Use \`/st-presets\` to add one.`,
      single_preset_title: `Only One Preset`,
      single_preset_description: `Only one preset is imported. Import more with \`/st-presets\` before switching.`,
      success_title: `Preset Switched`,
      success_description: `**{name}** is now the active SillyTavern preset.`,
    },
    node: {
      description: `Manage preset prompt nodes`,
      toggle: {
        description: `Toggle preset prompt nodes on or off`,
        no_preset_title: `No Preset Found`,
        no_preset_description: `No active SillyTavern preset found for this server. Import one with \`/st-presets\` first.`,
        no_nodes_title: `No Toggleable Nodes`,
        no_nodes_description: `This preset has no toggleable prompt nodes.`,
        select_page_title: `Select Page`,
        select_page_description: `**{preset_name}** has **{total_nodes}** toggleable nodes across **{total_pages}** pages.
Select a page to view and toggle nodes:`,
        group_description: `Check to enable, uncheck to disable`,
        done_button: `Done`,
        no_changes: `No changes made`,
        result_title: `Node Toggle Results`,
        result_description: `**{enabled}** / **{total}** nodes enabled.

{changes}`,
      },
    },
  },
};
