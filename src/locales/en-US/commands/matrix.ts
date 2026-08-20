export default {
  matrix: {
    description: `Link Discord channels to Matrix rooms for bidirectional relay.`,
    link: {
      description: `Link a Discord channel to a Matrix room for bidirectional relay`,
      channel_description: `The Discord channel to link`,
      room_description: `The Matrix room ID to link (e.g., !abc:matrix.org)`,
      success_title: `Matrix Room Linked`,
      success_description: `<#{channel_id}> is now bridged to \`{room_id}\`. Messages from me will appear in the Matrix room, and Matrix messages will appear here.

Open {help_matrix}, then Integrations > Matrix, for setup steps, Matrix-only command notes, and the current limitation list.`,
      invalid_room_title: `Invalid Room ID`,
      invalid_room_description: `The Matrix room ID must start with \`!\` and contain a \`:\` (e.g., \`!abc:matrix.org\`). Please check the room ID and try again.`,
      join_failed_description: `<#{channel_id}> has been linked to \`{room_id}\`, but I couldn't join the Matrix room automatically. Please invite \`{bot_user_id}\` to the room manually. If you need the setup steps and limitation list, open {help_matrix} and go to Integrations > Matrix.`,
      encrypted_room_title: `Cannot Link Encrypted Room`,
      encrypted_room_description: `\`{room_id}\` has end-to-end encryption enabled. Matrix encryption cannot be disabled once set, so this room cannot be used for bridging. Please create a new Matrix room **without** encryption and invite \`{bot_user_id}\` to it instead.`,
      matrix_not_configured_title: `Matrix Bridge Not Available`,
      matrix_not_configured_description: `The Matrix bridge is not configured on this bot instance. Contact the bot owner to enable it.`,
    },
    unlink: {
      description: `Remove the Matrix bridge link from a Discord channel`,
      channel_description: `The Discord channel to unlink from its Matrix room`,
      success_title: `Matrix Room Unlinked`,
      success_description: `<#{channel_id}> is no longer bridged to any Matrix room.`,
      not_linked_title: `Not Linked`,
      not_linked_description: `<#{channel_id}> doesn't have a Matrix room linked to it.`,
    },
  },
};
