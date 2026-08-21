export default {
  nuke: {
    description: `Completely wipe all server data. Requires re-running /setup afterwards.`,
    confirmation_description: `Confirm you want to permanently delete this server's data. This cannot be undone.`,
    confirmation_choice_yes: `Yes, nuke it`,
    confirmation_choice_no: `No, cancel`,
    preserve_personas_description: `Keep personas and their attributes/configs/memories intact (skips persona-tree deletion).`,
    cancelled_title: `Nuke Cancelled`,
    cancelled_description: `No data was changed. Server data is untouched.`,
    success_full_title: `Server Nuked`,
    success_full_description: `All server data was wiped, including personas. Discord-side webhooks deleted: **{webhooks_deleted}** (failures: **{webhooks_failed}**). Run \`/setup\` to start fresh.`,
    success_preserved_title: `Server Nuked (Personas Preserved)`,
    success_preserved_description: `Server settings, whitelists, quotas, triggers, and integrations were wiped. Personas and their attributes/memories were kept. Discord-side webhooks deleted: **{webhooks_deleted}** (failures: **{webhooks_failed}**). Run \`/setup\` to reconfigure server-level settings.`,
  },
};
