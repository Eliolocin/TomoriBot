export default {
  speech: {
    description: `Manage speech voices and samples.`,
    "voice-add": {
      description: `Upload a local TTS reference voice sample.`,
    },
    "voice-remove": {
      description: `Remove this server's local TTS voice sample.`,
    },
    "voice-assign": {
      description: `Assign a speech voice to a persona.`,
    },
    "voice-design": {
      description: `Manage VoiceDesign prompts for personas.`,
      set: {
        description: `Set a voice design prompt for a persona.`,
      },
      remove: {
        description: `Remove a persona's voice design prompt.`,
      },
    },
    elevenlabs: {
      description: `Connect ElevenLabs speech and transcription.`,
      key_description: `ElevenLabs API key.`,
      invalid_key_title: `Invalid API Key`,
      invalid_key_description: `Enter a valid ElevenLabs API key.`,
      key_validation_failed_title: `Key Validation Failed`,
      key_validation_failed_description: `I couldn't validate this ElevenLabs key. Check the key and try again.`,
      success_title: `ElevenLabs Connected`,
      success_description: `ElevenLabs speech and transcription endpoints are connected. Assign a persona voice with \`/speech voice-assign\`.`,
    },
    chatterbox: {
      description: `Manage Chatterbox speech settings.`,
    },
    transcripts: {
      description: `Toggle visible transcript posting for voice messages.`,
      set_description: `Enable or disable visible transcript messages in chat.`,
      already_set_title: `Already Set`,
      already_enabled_description: `Visible transcript posting is already enabled for this server.`,
      already_disabled_description: `Visible transcript posting is already disabled for this server.`,
      success_title: `Visible Transcript Mode Updated`,
      enabled_success: `Visible transcript posting is now **enabled**. Voice messages will be transcribed and posted as chat messages via webhook. Background STT for my internal understanding is configured separately with \`/providers\`.`,
      disabled_success: `Visible transcript posting is now **disabled**. Background STT can still run for my internal understanding when a transcription endpoint is configured.`,
    },
    voice_assign: {
      description: `Assign a speech voice to a persona.`,
      no_speech_endpoint_title: `No Speech Endpoint`,
      no_speech_endpoint_description: `Register a speech endpoint first with \`/providers\`.`,
      no_sample_title: `No Voice Samples`,
      no_sample_description: `Add a local voice sample first with \`/speech voice-add\`.`,
      select_persona_title: `Select Persona Voice Target`,
      clear_choice_label: `Disable Voice`,
      clear_choice_description: `Remove the current speech voice from this persona.`,
      assign_clone_title: `Assign Voice Sample`,
      sample_ref_hint_with: `With transcript · {duration}`,
      sample_ref_hint_without: `{duration}`,
      elevenlabs_modal_title: `Select ElevenLabs Voice`,
      elevenlabs_voice_fetch_failed_title: `Voice List Unavailable`,
      elevenlabs_voice_fetch_failed_description: `I couldn't load the available ElevenLabs voices. Check the configured key and try again.`,
      success_title: `Persona Voice Updated`,
      success_description: `**{persona}** will now use **{voice}** for voice messages.`,
      cleared_title: `Persona Voice Cleared`,
      cleared_description: `Removed the speech voice from **{persona}**.`,
    },
    voice_design: {
      description: `Set a voice design prompt for a persona.`,
      prompt_description: `Optional voice description; omit to open a larger prompt box.`,
      unsupported_endpoint_title: `VoiceDesign Endpoint Not Active`,
      unsupported_endpoint_description: `Select a local TTS endpoint with Supports Instruct enabled before setting voice design prompts.`,
      select_persona_title: `Select Persona VoiceDesign Target`,
      modal_title: `Voice Design Prompt`,
      update_modal_title: `Update Voice Design Prompt`,
      prompt_label: `Voice Description`,
      prompt_help: `Describe speaker age, tone, texture, accent, pacing, emotion, and delivery style.`,
      prompt_placeholder: `Warm adult narrator, gentle pace, soft breathy texture, calm and reassuring delivery.`,
      prompt_required_description: `Enter a voice design prompt.`,
      success_title: `VoiceDesign Prompt Set`,
      success_description: `**{persona}** will use this voice design prompt for local voice messages:
\`\`\`
{preview}
\`\`\``,
      no_prompt_title: `No VoiceDesign Prompt`,
      no_prompt_description: `There is no voice design prompt to clear. Set one with \`/speech voice-design set\`.`,
      cleared_title: `VoiceDesign Prompt Cleared`,
      cleared_description: `Removed the voice design prompt from **{persona}**.`,
      cleared_description_with_prompt: `Removed the voice design prompt from **{persona}**. Here it is in case you want to keep a copy:
\`\`\`
{removed_prompt}
\`\`\``,
    },
    validation: {
      sample_not_found: `Voice sample not found.`,
      no_voice_assigned: `No voice is assigned to this persona.`,
      unsupported_format: `Unsupported audio format.`,
      file_too_large: `The uploaded file is too large.`,
    },
  },
};
