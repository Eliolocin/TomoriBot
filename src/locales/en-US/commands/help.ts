export default {
  help: {
    description: `Browse setup, features, providers, memory, behavior, tools, media, and integration guides.`,
    dashboard: {
      header_title: `Getting Started with TomoriBot`,
      header_description: `Learn how to set up TomoriBot, a customizable AI assistant and role-play system.`,
      categories: {
        setup: `Setup`,
        features: `Features`,
        memory: `Memory`,
        behavior: `Behavior`,
        integrations: `Integrations`,
      },
      pages: {
        setup_step_1: `Step 1: Get an API Key`,
        setup_step_2: `Step 2: Run the Setup Command`,
        setup_step_3: `Step 3: Start Chatting`,
        setup_step_4: `Step 4: Customize TomoriBot (Optional)`,
        features: `Features`,
        personal_providers: `Personal Providers`,
        custom_endpoints: `Custom Endpoints`,
        speech: `Speech`,
        transcription: `Transcription`,
        persistent_memory: `Persistent Memory`,
        short_term_memory: `Short-Term Memory`,
        memory_tagging: `Memory Tagging`,
        customization: `Customization`,
        personal_spotlight: `Personal Spotlight`,
        deliberate_trigger_mode: `Deliberate Trigger Mode`,
        deliberate_tool_mode: `Deliberate Tool Mode`,
        age_restricted_commands: `Age-Restricted Commands`,
        matrix: `Matrix`,
        mcp: `MCP`,
        sillytavern_presets: `SillyTavern Presets`,
      },
      page_reference: `the **{page}** page in \`/help\``,
      page_select_placeholder: `Choose a page`,
      guide_select_placeholder: `Choose a guide`,
      provider_select_placeholder: `Choose Provider`,
      previous_button: `< Previous`,
      next_button: `Next >`,
      docs_link_label: `Read the Web Version`,
      support_link_label: `Get Technical Support`,
      variants: {
        overview: `Overview`,
        chatterbox: `Chatterbox-Turbo`,
        qwen3tts: `Qwen3-TTS`,
        irodoritts: `IrodoriTTS`,
        elevenlabs: `ElevenLabs`,
        whisperx: `WhisperX`,
        koboldcpp: `KoboldCPP`,
      },
      api_keys: {
        title: `Provider API Keys`,
        description: `Choose a provider below to open its API key guide. Closing the guide returns you to this help panel.`,
      },
    },
    "personal-provider": {
      description: `Learn how personal providers work.`,
      title: `Personal Providers`,
      description_body: `Personal providers let your own requests use your own API keys and models instead of a server's shared defaults.`,
      setup_field: `Setup`,
      setup_value: `1. {add_command} saves a provider and immediately enables your personal **Text** model.
2. {model_command} is optional. Use it only if you want a different text model than the default from step 1.
3. Return to {toggle_command} to update credentials, endpoints, or model registrations.`,
      behavior_field: `Behavior`,
      behavior_value: `An enabled capability overrides the server default for your requests only, across every server where you use TomoriBot. Selecting a model enables that capability. Thought logs attribute those turns, and you can tune them with {samplers_command} and {fallback_command}.`,
      byok_field: `BYOK Servers`,
      byok_value: `Servers can require member-provided providers with {byok_command}. If that mode is enabled, user-triggered messages need your personal provider before I can answer.`,
      footer: `Server credentials live in /providers and routing lives in /model. Personal overrides affect only your requests, in every server you use TomoriBot in.`,
    },
    custom_models: {
      description: `Learn how custom endpoints work.`,
      endpoint_description: `Choose which custom endpoint guide to view.`,
      choice_overview: `Overview`,
      choice_comfyui: `ComfyUI`,
      title: `Custom Endpoints`,
      description_body: `Custom endpoints let you register self-hosted or proxy-backed endpoints such as Ollama, LM Studio, LiteLLM, or ComfyUI as labeled provider bundles.`,
      server_field: `Server Scope`,
      server_value: `Open {add_command}, choose **Add New Custom Endpoint**, and select the saved entry when you need to edit or remove it.`,
      personal_field: `Personal Scope`,
      personal_value: `Open {add_command}, choose **Add New Custom Endpoint**, and select the saved entry when you need to edit or remove it.`,
      selection_field: `Selecting Them`,
      selection_value: `After saving a connection, select it and use its model dropdown to register the exact model code. Adding a model activates it. Later, choose the label from {text_command}, {image_command}, or {video_command}; if the label has several models for that capability, a picker lets you choose one. Vision-capable text endpoints also appear in \`/model vision\`.`,
      selection_summary_value: `After registration, choose the label from {text_command}, {image_command}, or {video_command}. If that label has several models for the same capability, TomoriBot will ask which one to use.`,
      labels_field: `Labels And Removal`,
      labels_value: `A label groups every capability under one custom provider bundle. Select the entry in {server_remove_command} or {personal_remove_command}, then choose **Remove** to review the impact and delete the whole labeled bundle.`,
      comfyui_page1_title: `ComfyUI Setup`,
      comfyui_page1_description: `This guide assumes ComfyUI is already installed and running. Page 1 covers the minimum setup to reach a working \`/providers\` or \`/personal providers\` registration. You may also use the ready-to-use [ComfyUI workflows](https://github.com/Bredrumb/TomoriBot/tree/main/assets/comfyui-workflows) from the GitHub repository instead.`,
      comfyui_page1_workflow_field: `1. Build The Workflow`,
      comfyui_page1_workflow_value: `Create and test the workflow in ComfyUI first. For images, the MVP should end in \`SaveImage\` so TomoriBot can download the finished file. A minimal image graph is usually: \`CheckpointLoaderSimple\` -> positive/negative \`CLIPTextEncode\` -> \`EmptyLatentImage\` -> \`KSampler\` -> \`VAEDecode\` -> \`SaveImage\`.`,
      comfyui_page1_placeholders_field: `2. Add Placeholders`,
      comfyui_page1_placeholders_value: `Use \`{TOMORI_PROMPT}\` directly in text fields. TomoriBot replaces supported \`{TOMORI_*}\` tokens inside the uploaded API-format JSON before queueing it. String placeholders can be embedded in longer text. Numeric and boolean placeholders should usually be the entire exported JSON value.`,
      comfyui_page1_export_field: `3. Export And Edit The JSON`,
      comfyui_page1_export_value: `When the workflow works in ComfyUI, use Save (API Format). If you need numeric or boolean placeholders, edit the exported JSON before uploading and use them as the full value, for example \`"width": "{TOMORI_WIDTH}"\`, \`"height": "{TOMORI_HEIGHT}"\`, or \`"duration": "{TOMORI_VIDEO_DURATION}"\`.`,
      comfyui_page1_register_field: `4. Register And Activate`,
      comfyui_page1_register_value: `Open {server_add_command} for a server-wide endpoint or {personal_add_command} for your own. Choose **Add New Custom Endpoint**, use your ComfyUI server URL (for example \`http://127.0.0.1:8188\`), and choose \`ComfyUI\` for API Compatibility. Then select the saved endpoint, choose **+ Add new Image Model** or **+ Add new Video Model** from its model dropdown, enter the checkpoint code, and upload the exported JSON. Adding the model activates it.`,
      comfyui_page2_title: `ComfyUI Placeholders`,
      comfyui_page2_description: `Page 2 lists the main placeholders TomoriBot injects into ComfyUI workflows.`,
      comfyui_page2_core_field: `Core Values`,
      comfyui_page2_core_value: `Core placeholders: \`{TOMORI_PROMPT}\`, \`{TOMORI_MODEL}\`, \`{TOMORI_MODEL_NAME}\`, \`{TOMORI_MODE}\`, \`{TOMORI_ASPECT_RATIO}\`, and \`{TOMORI_SIZE}\`. \`{TOMORI_MODE}\` resolves to \`image\` or \`video\`. \`{TOMORI_SIZE}\` resolves to a string like \`1024x1024\` or \`1280x720\`.`,
      comfyui_page2_numeric_field: `Image Dimensions`,
      comfyui_page2_numeric_value: `Dimension placeholders: \`{TOMORI_WIDTH}\` and \`{TOMORI_HEIGHT}\`. For image generation TomoriBot derives these from the requested aspect ratio. Use them where your JSON expects numbers, such as latent size or canvas size fields.`,
      comfyui_page2_video_field: `Video Arguments`,
      comfyui_page2_video_value: `Video placeholders: \`{TOMORI_VIDEO_DURATION}\`, \`{TOMORI_DURATION_SECONDS}\`, \`{TOMORI_VIDEO_RESOLUTION}\`, \`{TOMORI_RESOLUTION}\`, and \`{TOMORI_GENERATE_AUDIO}\`. These resolve from the \`generate_video\` tool args before the workflow is queued.`,
      comfyui_page3_title: `ComfyUI Img2Img`,
      comfyui_page3_description: `Page 3 covers reference-image behavior for image and video flows.`,
      comfyui_page3_image_refs_field: `How References Are Gathered`,
      comfyui_page3_image_refs_value: `For \`generate_image\`, \`media_id\` contributes all images from the referenced Discord message and \`target_identity\` can add one or more user or persona avatars as extra references. For \`generate_video\`, \`media_id\` contributes the first image from that message as the starting frame.`,
      comfyui_page3_reference_tokens_field: `Reference Placeholders`,
      comfyui_page3_reference_tokens_value: `TomoriBot exposes \`{TOMORI_REFERENCE_IMAGE_COUNT}\`, \`{TOMORI_REFERENCE_IMAGES}\`, \`{TOMORI_REFERENCE_IMAGES_JSON}\`, and indexed values such as \`{TOMORI_REFERENCE_IMAGE_1_DATA_URL}\`, \`{TOMORI_REFERENCE_IMAGE_1_BASE64}\`, \`{TOMORI_REFERENCE_IMAGE_1_MIME_TYPE}\`, and \`{TOMORI_REFERENCE_IMAGE_1_URL}\` when a source URL exists. The same indexed pattern continues for \`_2_\`, \`_3_\`, and so on.`,
      comfyui_page3_reference_note_field: `Important Caveat`,
      comfyui_page3_reference_note_value: `TomoriBot can transport reference-image data into the workflow JSON, but stock ComfyUI nodes do not automatically turn those strings into an \`IMAGE\` tensor. Reference placeholders are mainly useful with a custom node or node pack that can decode data URLs, base64 payloads, or JSON arrays.`,
      comfyui_page4_title: `ComfyUI Video And Output`,
      comfyui_page4_description: `Page 4 covers video flows, saved outputs, and metadata behavior.`,
      comfyui_page4_video_field: `Video Flow`,
      comfyui_page4_video_value: `When you run a video workflow, TomoriBot resolves the workflow placeholders, POSTs the saved graph to ComfyUI's \`/prompt\` API, polls \`/history/{prompt_id}\`, then downloads the first saved file from \`/view\`. ComfyUI endpoints with auth now receive the saved bearer token on those API calls too.`,
      comfyui_page4_output_field: `Saved Outputs`,
      comfyui_page4_output_value: `TomoriBot still downloads only the first saved output, so the workflow must produce a real saved image or video file. Preview-only nodes are not enough. If the workflow saves multiple outputs, TomoriBot will return the first one ComfyUI reports in history.`,
      comfyui_page4_metadata_field: `extra_pnginfo Metadata`,
      comfyui_page4_metadata_value: `TomoriBot also sends resolved values in \`extra_pnginfo\`, including prompt, model, mode, aspect ratio, width, height, size, reference-image count, and video-specific duration/resolution/audio fields. That is useful if you prefer a custom ComfyUI node that reads execution metadata instead of JSON placeholders.`,
      comfyui_summary_description: `ComfyUI custom endpoints let TomoriBot queue your saved image or video workflow and return the first saved output. The full setup guide covers workflow export, placeholders, reference images, polling, and output rules.`,
      comfyui_summary_register_field: `Register And Activate`,
      comfyui_summary_register_value: `Register the connection and its model with {server_add_command} or {personal_add_command}, then select its label from {image_command} or {video_command}. Use the docs button for the full ComfyUI workflow setup.`,
    },
    speech: {
      description: `Learn how speech generation works.`,
      engine_description: `Choose a speech engine guide.`,
      docs_title: `Full Docs`,
      docs_description: `See the [TTS docs](https://docs.tomoribot.app/en/features/capabilities/media-generation/tts-and-stt/#text-to-speech) and [local TTS setup guides](https://docs.tomoribot.app/en/self-hosting/local-endpoints/text-to-speech/) for setup commands and wrapper notes.`,
      summary_title: `Using Speech`,
      summary_description: `For local voice cloning, register a speech connection and model with {custom_endpoint_add}, pick it with {model_speech}, upload a sample with {voice_add}, then assign it with {voice_assign}. For ElevenLabs, choose **Add New Provider** in {elevenlabs}. VoiceDesign setups use {voice_design_set}.`,
      overview: {
        title: `Speech Setup Overview`,
        description: `Speech endpoints let TomoriBot send native Discord voice messages using either a local clone server or ElevenLabs. For local voice cloning, any audio format is accepted (auto-converted to mono WAV). It is recommended to use 10-20 second clips with no background music.`,
        steps_title: `Setup Flow`,
        steps_description: `Local: start a wrapper server, register it with {custom_endpoint_add}, select it with {model_speech}, upload a sample with {voice_add}, then assign it with {voice_assign}.

ElevenLabs: choose **Add New Provider** and **ElevenLabs** in {elevenlabs}, then use {voice_assign} later for more personas.

**Per-engine setup guides:** See the full TTS documentation linked at the bottom of the Speech page.`,
      },
      chatterbox: {
        title: `Chatterbox-Turbo Speech`,
        description: `Chatterbox-Turbo is a fast, lightweight English-only voice clone server. It supports bracket-style delivery tags such as \`[excited]\` or \`[whisper]\` to shape delivery: register it with **Script Markup** set to **Bracket Tags** so TomoriBot passes those tags through intact.`,
        steps_title: `Setup Steps`,
        steps_description: `**Prerequisites**: Python 3.10+, CUDA 12.x + drivers (optional, for GPU)

1. Follow the [local TTS setup guide](https://docs.tomoribot.app/en/self-hosting/local-endpoints/text-to-speech/chatterbox/) to prepare the server.
2. Navigate to the downloaded \`chatterbox\` folder, then create and activate a Python \`.venv\`.
3. Install numpy first (build dep): \`pip install numpy\`, then install \`requirements.txt\`.
4. *(GPU only)* Reinstall PyTorch: \`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
5. Start \`server.py\`.
6. Register with {custom_endpoint_add}: choose \`TTS-Clone\` for API Compatibility. Then select the saved endpoint, add a new speech model, and choose \`Bracket Tags\` for Script Markup.
7. Select with {model_speech}, then run {voice_add} and {voice_assign}.`,
      },
      qwen3tts: {
        title: `Qwen3-TTS Speech`,
        description: `Qwen3-TTS 12Hz Base is a multilingual voice clone server supporting 10 languages: Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian. The bundled Qwen3-TTS server can also run the VoiceDesign model for natural-language voice descriptions, or auto-switch between clone and VoiceDesign requests on one endpoint URL. All modes expect plain speech text only; no emotion markup. Register them with **Script Markup** set to **Plain**.`,
        steps_title: `Setup Steps`,
        steps_description: `**Prerequisites**
• Python 3.10+
• SoX installed system-wide (Windows: \`scoop install sox\`, macOS: \`brew install sox\`)
• CUDA 12.x + drivers (optional, for GPU)

1. Follow the [local TTS setup guide](https://docs.tomoribot.app/en/self-hosting/local-endpoints/text-to-speech/qwen3tts/) to prepare the server.
2. Navigate to the downloaded \`qwen3tts\` folder, create and activate a Python \`.venv\`.
3. Install \`requirements.txt\`.
4. *(GPU)* Reinstall PyTorch: \`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
5. *(Optional)* Install flash-attn for speed: requires step 4, \`pip install wheel\`, then \`pip install flash-attn --no-build-isolation\` (takes 20-40m on Win). Skip initially.
6. Start \`server.py\` for voice cloning, \`server.py --mode voice-design\` for Qwen3-TTS VoiceDesign only, or \`server.py --mode auto\` to detect clone vs VoiceDesign from each request on one URL.
7. Register with {custom_endpoint_add}: choose \`TTS-Clone\` for API Compatibility. Then select the saved endpoint, add a new speech model, and choose \`Plain\` Script Markup. For VoiceDesign, choose \`VoiceDesign\` as the voice source mode; TomoriBot treats it as instruct-capable automatically. In auto mode, you can register clone and VoiceDesign endpoints that point to the same server URL.
8. Select with {model_speech}. For clone mode, run {voice_add} and {voice_assign}; for VoiceDesign, run {voice_design_set} for each persona.`,
      },
      irodoritts: {
        title: `IrodoriTTS Speech`,
        description: `IrodoriTTS is a Japanese-specialized voice clone server. It reads emoji characters embedded in the speech text as emotion cues (e.g. 😊 for happy, 😢 for sad). Register it with **Script Markup** set to **Emoji Markers**: TomoriBot strips bracket tags before sending, leaving only the emoji markers the model expects.`,
        steps_title: `Setup Steps`,
        steps_description: `**Prerequisites**: Python 3.10+, CUDA 12.x + drivers (optional, for GPU)

1. Follow the [local TTS setup guide](https://docs.tomoribot.app/en/self-hosting/local-endpoints/text-to-speech/irodoritts/) to prepare the server.
2. Navigate to the downloaded \`irodoritts\` folder, then create and activate a Python \`.venv\`.
3. Install \`requirements.txt\`.
4. Install irodori-tts via the patch script (upstream packaging bugs require this):
Windows: \`install-irodori.ps1\`
Linux/macOS: \`bash install-irodori.sh\`
5. *(GPU only)* Reinstall PyTorch: \`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
6. Start \`server.py\`.
7. Register with {custom_endpoint_add}: choose \`TTS-Clone\` for API Compatibility. Then select the saved endpoint, add a new speech model, and choose \`Emoji Markers\` for Script Markup.
8. Select with {model_speech}, then run {voice_add} and {voice_assign}.`,
      },
      elevenlabs: {
        title: `ElevenLabs Speech`,
        description: `ElevenLabs uses the same endpoint system and is available as a preset provider entry.`,
        steps_title: `Setup Steps`,
        steps_description: `Open {elevenlabs}, choose **Add New Provider**, select **ElevenLabs**, and submit your API key. It registers speech and transcription endpoints and selects them. Then use {voice_assign} to assign a voice to each persona.`,
      },
    },
    transcription: {
      description: `Learn how audio transcription works.`,
      engine_description: `Choose a transcription engine guide.`,
      docs_title: `Full Docs`,
      docs_description: `See the [STT docs](https://docs.tomoribot.app/en/features/capabilities/media-generation/tts-and-stt/#speech-to-text) and [local STT setup guides](https://docs.tomoribot.app/en/self-hosting/local-endpoints/speech-to-text/).`,
      summary_title: `Using Transcription`,
      summary_description: `Register a transcription connection and model with {custom_endpoint_add}, choose it with {model_transcription}, and use {speech_transcripts} only if you want transcripts visibly posted. ElevenLabs users can choose **Add New Provider** in {elevenlabs}.`,
      overview: {
        title: `Transcription Setup Overview`,
        description: `Transcription endpoints turn user audio attachments into text for background conversation context. Visible transcript posting is controlled separately by {speech_transcripts}.`,
        steps_title: `Recommended Path`,
        steps_description: `Start with WhisperX: follow the local STT setup guide, register its connection and model with {custom_endpoint_add}, then select it with {model_transcription}. ElevenLabs users can choose **Add New Provider** in {elevenlabs}.

**Per-engine setup guides:** See the full STT documentation linked at the bottom of the Transcription page.`,
      },
      whisperx: {
        title: `WhisperX Transcription`,
        description: `WhisperX is the recommended local STT path. It requires FFmpeg on your system and supports GPU acceleration via CUDA.`,
        steps_title: `Setup Steps`,
        steps_description: `**Prerequisites**
• Python 3.10+
• FFmpeg installed system-wide (required for audio decoding)
• CUDA 12.x + drivers (optional, for GPU acceleration)

1. Follow the [local STT setup guide](https://docs.tomoribot.app/en/self-hosting/local-endpoints/speech-to-text/whisperx/) to prepare the server.
2. Navigate to the downloaded \`stt\` folder, then create and activate a Python \`.venv\`.
3. Install \`requirements-whisperx.txt\`.
4. *(GPU only)* Reinstall PyTorch with CUDA support:
\`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
5. Start \`whisperx_server.py\`.
6. Register with {custom_endpoint_add}: choose \`OpenAI Compatible Transcription\` for API Compatibility. Then select the saved endpoint and add a new transcription model whose name matches your chosen size.
7. Select with {model_transcription}.`,
        models_title: `Available Models`,
        models_description: `Set \`WHISPERX_MODEL\` before starting, use the same name when registering.
GPU runs **float16** · CPU runs **int8** (half the bytes, so CPU RAM < GPU VRAM)

\`tiny\`: ~0.5 GB VRAM / ~200 MB RAM
\`base\`: ~0.5 GB VRAM / ~300 MB RAM
\`small\`: ~1 GB VRAM / ~600 MB RAM
\`medium\`: ~2 GB VRAM / ~1.5 GB RAM
\`large-v3\`: ~4-5 GB VRAM / ~2.5 GB RAM *(default, highest accuracy)*
\`large-v3-turbo\`: ~2-3 GB VRAM / ~1.5 GB RAM *(recommended for limited VRAM)*

Transcription supports ~100 languages (auto-detected).`,
      },
      koboldcpp: {
        title: `KoboldCPP Transcription`,
        description: `KoboldCPP STT support depends on the HTTP endpoint shape exposed by your build.`,
        steps_title: `Setup Notes`,
        steps_description: `If your KoboldCPP build exposes an OpenAI-compatible \`/v1/audio/transcriptions\` endpoint, register it with {custom_endpoint_add}. If it only exposes a different endpoint, use a wrapper until TomoriBot has a dedicated adapter.`,
      },
      elevenlabs: {
        title: `ElevenLabs Transcription`,
        description: `ElevenLabs transcription is registered automatically by its preset provider flow.`,
        steps_title: `Setup Steps`,
        steps_description: `Choose **Add New Provider** and **ElevenLabs** in {elevenlabs}. It registers both speech and transcription endpoints and selects them. Use {speech_transcripts} only if you want transcripts visibly posted in chat.`,
      },
    },
    "custom-endpoint": {
      description: `Learn how custom endpoints work.`,
    },
    features: {
      description: `Shows what TomoriBot can do`,
      title: `TomoriBot Features (Version {version})`,
      embed_description: `Here's everything I'm capable of:`,
      summary_chat_title: `Chatting And Personas`,
      summary_chat_description: `TomoriBot can respond through trigger words, mentions, replies, alter personas, webhook identities, and configurable persona behavior.`,
      summary_knowledge_title: `Knowledge And Memory`,
      summary_knowledge_description: `Personal memories, server memories, document knowledge, short-term memory, and privacy controls let servers decide what context TomoriBot may use.`,
      summary_capabilities_title: `Tools And Media`,
      summary_capabilities_description: `TomoriBot can use tools for web/search, scheduling, media analysis, image/video generation, voice messages, transcription, and MCP or custom endpoint integrations.`,
      summary_reference_title: `Admin And Reference`,
      summary_reference_description: `Provider setup, model choices, server controls, age-restricted commands, stats, Matrix bridging, and the generated command reference are all covered in the docs.`,
      vision_title: `Vision & Media`,
      vision_description: `- I can see and analyze images, videos, stickers, and emojis
- I can watch YouTube videos from links
- I can see content within shared embeds (like tweets, articles, etc.)`,
      search_title: `Search & Information`,
      search_description: `- I can search the web for current information
- I can also do image, video, and news search (via \`/providers\`)
- I can fetch and read content from URLs`,
      personality_title: `Personality & Customization`,
      personality_description: `- I can change my name and avatar using \`/persona rename\` and \`/persona avatar\`
- I can switch between different personas using \`/persona\` (you can also share and save personas using \`/persona export\`!)
- Multiple characters can coexist as alter personas, each with their own triggers and webhook avatar
- My behavior and tone can be tweaked with \`/persona attribute add\`, \`/persona sample-dialogue add\`, and \`/persona prompt set\`
- A custom system prompt can be set with \`/config system-prompt\` to further shape my behavior
- Learn more on the **Customization** page in \`/help\``,
      memory_title: `Memory & Personalization`,
      memory_description: `- I can remember personal facts about you and server-wide information, persisting across conversations
- Personal memories persist across servers (try talking to me in another server!)
- I also keep [STM (short-term memory)](https://docs.tomoribot.app/en/features/knowledge/memory/#short-term-memory-stm) of recent conversations for channel and server awareness (opt into cross-server sharing with \`/personal stm\`)
- Change what I call you using \`/personal profile nickname\`
- Use \`/memory\` and \`/persona\` commands to manually add or remove memories and persona data
- I can use server emojis and stickers more accurately after registration with \`/expressions initialize\`
- Full invisibility is available via \`/personal privacy\` if you want to be completely unseen by me
- Learn more on the **Persistent Memory** page in \`/help\``,
      time_title: `Time Awareness`,
      time_description: `- I know what time it currently is in the server (via \`/server timezone\`)
- I can set up reminders for you (try asking me to remind you about something!)
- Recurrent reminders and tasks are supported and are persona-specific, just tell me to do something`,
      alter_title: `Alter Personas`,
      alter_description: `- Multiple characters can coexist in one server via alter personas
- Each alter has its own personality and is triggered by specific keywords
- Alter personas use webhooks for distinct avatars
- Multiple alters can respond to a single message (up to the \`/config trigger-match-limit\` limit)
- Replying to a webhook message continues the conversation as that persona
- Manage alters with \`/persona import\` (alter option) and \`/persona remove\``,
      expressions_title: `Expressions & Reactions`,
      expressions_description: `- I can use your server's custom emojis naturally in conversation (case-insensitive \`:name:\` syntax)
- I can send stickers as part of my replies
- I can react to messages with relevant emojis
- Register emojis and stickers with \`/expressions initialize\` for higher accuracy`,
      documents_title: `Document Knowledge Base`,
      documents_description: `- Upload text, PDF, or Markdown files as server knowledge using \`/memory document add\`
- Extract channel history into searchable knowledge with \`/learn history\`
- I retrieve and reference relevant document content when answering questions
- I can also read file attachments shared directly in chat (PDF, source code, markdown, JSON, YAML, and more): just ask me to read it!
- Requires an embedding model (configure with \`/model embedding\`)
- Remove uploaded or history-extracted documents with \`/memory document remove\` and \`/memory history remove\``,
      impersonation_title: `Impersonation & Tools`,
      impersonation_description: `- Use \`/impersonate\` to send messages as yourself, a persona, or inject system messages
- Set a reusable user-impersonation prompt with \`/personal impersonate prompt\`
- \`/compact\` can summarize or roleplay-compress conversation history
- \`/respond\` to trigger prefilled or guided messages from the bot`,
      imagegen_title: `Image Generation`,
      imagegen_description: `- I can generate images from text prompts or by editing reference images
- Supports Text2Image and Image2Image with customizable aspect ratios
- Use \`/generate image\` or just ask me to generate an image
- Reference images can come from message attachments, stickers, emojis, or user avatars
 - Available on Google, Vertex AI, Vertex AI Express, OpenRouter, Z.ai, and NVIDIA NIM providers (configure with \`/model image\`)`,
      videogen_title: `Video Generation`,
      videogen_description: `- I can generate short videos from text prompts or by animating reference images
- Supports Text2Video and Image2Video with customizable aspect ratios
- Use \`/generate video\` or just ask me to generate a video
- Reference images can come from message attachments or user avatars
- Available on Google, OpenRouter, and Z.ai providers (configure with \`/model video\`)`,
      footer: `Not all features are available for all AI providers. Recommended: Google Gemini. You can also just ask me what I can do!`,
    },
    setup: {
      description: `Learn how to set up TomoriBot for the first time`,
      title: `Getting Started with TomoriBot`,
      embed_description: `Here's how to set up TomoriBot in your server (or DMs!):`,
      step1_title: `Step 1: Get an API Key`,
      step1_description: `TomoriBot supports multiple AI providers. You need an API key from one of them before she can start working. An API Key is a private passkey that lets TomoriBot use the AI models of your chosen provider.

For first-time setup, *Google Gemini* is recommended because it has a generous free tier, but if you already have experience with systems similar to TomoriBot, feel free to use any provider you already use. Choose a provider below to see how to get its API key.`,
      provider_picker_footer: `After safely copying your API key, proceed to the next step. **Do not share your API key with anyone else.**`,
      step2_title: `Step 2: Run the Setup Command`,
      step2_description: `- Use {configSetup} to securely add your API key and initialize TomoriBot
- (Recommended) Run {expressionsInitialize} so I can properly use your server's emojis/stickers
	- Your API key is encrypted and stored safely
	- Each server has its own configuration`,
      step3_title: `Step 3: Start Chatting`,
      step3_description: `- Just mention me or reply to my messages to chat
- Change how I get triggered using {personaTrigger}
- I'll remember our conversations with my memory system (which you can disable using {configPermissions}!)
- Set up auto-trigger with {serverAutotrigger} to chat without mentioning me`,
      step4_title: `Step 4: Customize TomoriBot (Optional)`,
      step4_description: `- Use {persona} commands to completely change my personality (including alter personas!)
- Configure my settings with {server}, {personal}, {memory}, and {config} commands
- Use {memory} for memories/documents and {persona} for behavior shaping
- Explore advanced features like document uploads, API key rotation, and uncensored mode`,
      need_help_title: `Need Help?`,
      need_help_description: `- {helpFeatures} - See what I can do
- {helpMemory} - Learn about my memory system
- {helpCustomization} - Learn about personality customization
- {supportServer} - Join the official TomoriBot support server{legalNotice}`,
    },
    matrix: {
      description: `Learn how to set up and use the Matrix bridge`,
      title: `Matrix Bridge Guide`,
      embed_description: `How to link a Matrix room to a Discord channel, and what currently works from Matrix.`,
      bot_user_fallback: `the configured Matrix bot account`,
      setup_title: `Setup`,
      setup_description: `1. Invite {botUserId} to an unencrypted Matrix room.
2. Copy that room's Internal Room ID.
3. Run {matrixLink} in the Discord channel you want to bridge and paste the room ID there.`,
      room_id_title: `Finding the Room ID`,
      room_id_description: `In most Matrix clients, open Room Settings -> Advanced -> Internal Room ID.
The ID looks like \`!abc:matrix.org\`.

After the bot accepts an invite, it now posts a short reminder in the Matrix room, but you still need to finish the link from Discord with {matrixLink}.`,
      usage_title: `Using It From Matrix`,
      usage_description: `- Talk in Matrix normally after the room is linked
- Matrix messages relay into the linked Discord channel as webhook messages
- I reply back into the Matrix room
- The only Matrix text commands are /kill and /refresh`,
      limitations_title: `Current Limitations`,
      limitations_description: `- No slash commands from Matrix
- No DMs / DM-based cooldown reminders
- Matrix user profile pictures are not visible to me
- Cannot pin messages
- Custom emojis and Markdown do not render reliably
- Embeds relay as plain text
- Personal memories for Matrix users fall back to attributed server memories`,
      troubleshooting_title: `Important Notes`,
      troubleshooting_description: `- If the bot does not auto-join, invite {botUserId} manually and rerun {matrixLink} if needed
- Matrix encryption cannot be disabled later, so encrypted rooms must be replaced with a fresh unencrypted room
- If a limitation is not listed above, assume it should work and report bugs in {supportServer}`,
    },
    data: {
      description: `Learn about data management and privacy`,
      title: `Managing Your Data`,
      embed_description: `How you can manage your data and what I store:`,
      export_title: `Export Your Data`,
      export_description: `Use {memoryPersonalExport}, {memoryServerExport}, {personalConfigExport}, and {serverConfigExport} to download your data:
- **Personal Memories of Persona / Global Personal Memories**: Export one persona scope or your global memory scope
- **Server Memories of Persona**: Export server memories for one selected persona
- **Personal Settings**: Export your nickname, language, and other personal config
- **Server Config**: Export server configuration values (no API keys/triggers)
- **Personas**: Use {personaExport} to export full persona definitions separately
- Data is sent to your DMs as a JSON file`,
      import_title: `Import Your Data`,
      import_description: `Use {memoryPersonalImport}, {memoryServerImport}, {personalConfigImport}, and {serverConfigImport} to restore previously exported data:
- File type is auto-detected from the export file
- For memory files, you'll choose a target persona or Global scope
- Server-related imports require \`Manage Server\` in guilds
- Simply attach your exported file when using the command`,
      delete_title: `Delete Your Data`,
      delete_description: `Use {memoryPersonalRemove}, {memoryServerRemove}, {personalConfigRemove}, and {serverConfigRemove} to permanently remove or reset your data:
- **Personal Memories of Persona** / **Global Personal Memories**
- **Server Memories of Persona**
- **Personal Settings** / **Server Config reset**
- This action cannot be undone!`,
      privacy_title: `Privacy Notice`,
      privacy_description: `**What I Store:**
- Server/personal memories
- My settings and persona
- My server configurations
- Encrypted API keys

**What I Do NOT Store:**
- Your Discord messages
- Chat History

**What is Sent to your Chosen AI Provider:**
Whenever I'm triggered, I fetch the **latest messages** in the text channel as well as any **relevant memories** as context for the AI model to form my reply. I do NOT actively monitor and look at messages outside of these triggers.

You may opt out of my Memory features by using the {personalPrivacy} command, as well as turn off my self-learning using the {configPermissions} command.`,
      footer: `Your chosen AI provider (Google, NovelAI, OpenRouter) processes your messages according to their own privacy policies. Never share personal information with me for privacy.{legalNotice}`,
    },
    "st-preset": {
      description: `Learn how SillyTavern presets behave here`,
      embed1_title: `SillyTavern Presets`,
      embed1_description: `Use {stPresets} to load Prompt Manager presets, inspect enabled nodes, and switch or disable active presets.`,
      embed1_controls_title: `What A Preset Controls`,
      embed1_controls_description: `- Prompt order and marker placement
- Custom prompt nodes
- Post-history / depth injection nodes
- Which imported nodes start enabled or disabled`,
      embed1_still_sent_title: `What It Does Not Fully Replace`,
      embed1_still_sent_description: `- The current system/persona blocks still exist: {configSystemPromptSet}, {personaPromptSet}, {personaAttributeAdd}, and {personaSampleDialogueAdd}
- Live chat history and retrieved document context still exist too
- Automatic Tomori-only context still exists too: server memory, emoji/sticker context, users-in-conversation, STM, conditioning, and similar blocks`,
      embed1_mapping_title: `How Native Blocks Usually Map`,
      embed1_mapping_description: `- \`main\` usually places the current system prompt bucket: {configSystemPromptSet} if set, otherwise the built-in fallback
- \`charDescription\` usually places {personaPromptSet}
- \`charPersonality\` usually places {personaAttributeAdd}
- \`dialogueExamples\` usually places {personaSampleDialogueAdd}
- \`chatHistory\` usually places live channel history
- \`worldInfoBefore\` / \`worldInfoAfter\` usually place retrieved document context, not ST lorebooks`,
      embed1_system_prompt_title: `System Prompt Rule`,
      embed1_system_prompt_description: `- While a preset is active, the built-in fallback system prompt is removed
- If you set your own system prompt with {configSystemPromptSet}, it is still sent
- In ST terms, the preset owns the layout, not every source of prompt text`,
      embed1_footer: `Return to the SillyTavern Presets page in /help anytime after importing a preset`,
      embed2_title: `Limits And Compatibility (Page 1)`,
      embed2_description: `These are the main reasons a preset author thinks something was ignored or moved.
- Imported does not always mean sent: nodes disabled in \`prompt_order\` stay off until you enable them with {stPresets}
- Comment-only nodes and nodes that become empty after \`{{trim}}\` are never sent
- If enabled nodes still contain unsupported preset macros after import, the import summary warns you; those tags may still be sent literally or behave differently here
- Unknown markers are skipped
- Order is literal: if you place \`chatHistory\` before \`dialogueExamples\`, live chat comes first
- I use the \`prompt_order\` in the .json with \`character_id: 100001\`, and falls back to \`100000\` only if \`100001\` is missing
- If sample chats end up last, the bot adds a short separator so strict providers do not continue the example`,
      embed2_footer: `If something looks missing, compare the imported node list in {stPresets} against your preset JSON`,
      embed3_title: `Limits And Compatibility (Page 2)`,
      embed3_description: `- Post-history / depth injections are merged into existing chat history entries, not inserted as standalone messages
- Multiple nodes at the same depth are batched together
- \`{{setvar}}\` and \`{{addvar}}\` work across enabled nodes in node order, but variables are global for the whole preset
- Most native blocks are moved, not removed: \`main\`, \`charDescription\`, \`charPersonality\`, \`dialogueExamples\`, \`chatHistory\`, and \`worldInfo\` markers reposition my own system prompt, persona prompt, persona attributes, sample chats, live history, and retrieved docs
- The real suppressions are narrow: the built-in fallback system prompt is removed only if you did not set {configSystemPromptSet}, and native \`charDescription\` / \`charPersonality\` are skipped only when a custom node already expands \`{{description}}\` / \`{{personality}}\`
- Tomori-only automatic blocks are not owned by ST markers: server info, memories, emoji/sticker context flush after \`main\` / \`charDescription\` / \`charPersonality\`; users-in-conversation, STM, conditioning, and leftover RAG flush before \`dialogueExamples\` / \`chatHistory\`
- User impersonation via {botImpersonate} ignores the preset and uses the normal layout
- Older text-completions presets that use \`context.story_string\` + \`sysprompt.content\` are imported through a best-effort conversion path
- That legacy conversion maps the main system prompt, story layout, and post-history, but ST-only blocks like \`persona\`, \`scenario\`, anchors, stop strings, and old backend settings are still ignored
- Some extra legacy \`post_history\` fields on modern Prompt Manager presets are imported too
- Regex post-processing, preset-side temperature/top_p/model overrides, and layered presets are not supported
- \`worldInfo\` markers use retrieved document context instead of ST lorebooks
- Some automatic server/context blocks may still be inserted even if your preset does not place explicit ST markers for them
- Provider-specific behavior still applies: assistant prefill may work on some providers and be ignored on others`,
      embed3_footer: `Use {stPresets} to disable preset mode instantly`,
    },
    "api-key": {
      description: `Learn how to set up API keys for AI providers`,
      provider_description: `Choose your AI provider`,
      provider_choice_brave: `Brave Search`,
      provider_choice_google: `Google Gemini (Recommended)`,
      provider_choice_deepseek: `DeepSeek`,
      provider_choice_custom: `Custom Endpoint`,
      provider_choice_nvidia: `NVIDIA NIM`,
      provider_choice_novelai: `NovelAI`,
      provider_choice_openrouter: `OpenRouter (Recommended)`,
      provider_description_google: `General-purpose and has generous free usage`,
      provider_description_openrouter: `Paid but reliable and flexible; can generate images, videos, and voice`,
      provider_description_deepseek: `Cheaper paid alternative that is fairly uncensored`,
      provider_description_novelai: `For uncensored role-playing, storytelling, and image generation`,
      provider_description_nvidia: `Hosted text, embedding, and image models`,
      provider_description_zai: `GLM text and image models with coding-use policy limits`,
      provider_description_vertexexpress: `Gemini through Google Cloud with API key authentication`,
      provider_description_vertex: `Enterprise Gemini through Google Cloud credentials`,
      provider_description_custom: `Self-hosted or proxy endpoint; authentication may be optional`,
      provider_description_brave: `Optional web, image, video, and news search`,
      provider_description_elevenlabs: `Speech and transcription API, not a text model`,
      provider_choice_zai: `Z.ai`,
      provider_choice_vertex: `Google Vertex AI`,
      provider_choice_vertexexpress: `Google Vertex AI Express`,
      provider_choice_elevenlabs: `ElevenLabs TTS`,
      brave_title: `Setting Up Brave Search API Key`,
      brave_description: `Brave Search is optional and only enhances my search capabilities. It does NOT power my AI as that's handled by your main provider.
- Enables image, video, and news search
- Provides real-time information from the internet
- Enhances my ability to answer current questions`,
      brave_getting_key_title: `Getting Your API Key:`,
      brave_getting_key_description: `1. Visit [Brave Search API](https://brave.com/search/api/)
2. Sign up for a free account
3. Navigate to your [API Keys](https://api-dashboard.search.brave.com/app/keys) section in the Dashboard
4. Create a new API key
5. Copy and input your API key using the {configBraveapiSet} command`,
      brave_important_title: `Important Notes:`,
      brave_important_description: `- This is separate from your main AI provider
- Without Brave API key, I can still function and use built-in web search
- Brave includes $5 in free monthly credits, but usage above that can be billed. If you only want the free tier, set a $5 usage limit in the [Brave usage limits dashboard](https://api-dashboard.search.brave.com/app/subscriptions/usage-limits)`,
      brave_footer: `For your main AI provider, choose another provider from the API Keys page in \`/help\``,
      google_title: `Setting Up Google Gemini API Key`,
      google_description: `Google Gemini offers free and paid tiers with powerful AI models.
- Free tier available
- [Gemini Privacy Policy](https://ai.google.dev/gemini-api/terms)`,
      google_getting_key_title: `Getting Your API Key:`,
      google_getting_key_description: `1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Click \`Create API Key\` on the top-right (create a new Project if needed)
3. Copy this API key into {configSetup} or {configApikeySet}`,
      google_footer: `After setting up this provider, you may change its default model with {configModel}`,
      deepseek_title: `Setting Up DeepSeek API Key`,
      deepseek_description: `DeepSeek is a pay-as-you-go text provider.
- [DeepSeek API Docs](https://api-docs.deepseek.com/)`,
      deepseek_getting_key_title: `Getting Your API Key:`,
      deepseek_getting_key_description: `1. Visit [DeepSeek API Keys](https://platform.deepseek.com/api_keys)
2. Sign in or create a DeepSeek platform account
3. Create a new API key
4. If needed, add credits in your DeepSeek platform account before use
5. Copy this API key into {configSetup} or {configApikeySet}`,
      deepseek_footer: `After setting up this provider, you may change its default model with {configModel}`,
      custom_title: `Custom Endpoint Setup`,
      custom_description: `The legacy inline Custom Provider flow has moved.

For server-scoped endpoints, use {configSetup} and choose **Custom Endpoint (finish after setup)**, then run {configCustomModelsAdd} and select it with {configModel}.

For personal endpoints, use {personalCustomModelsAdd}.

Use {helpCustomModels} for the full command guide, supported endpoint types, and capability notes.`,
      nvidia_title: `Setting Up NVIDIA NIM API Key`,
      nvidia_description: `NVIDIA NIM provides hosted text, embedding, and image APIs through NVIDIA Build.`,
      nvidia_getting_key_title: `Getting Your API Key:`,
      nvidia_getting_key_description: `1. Visit [NVIDIA Build](https://build.nvidia.com/)
2. Sign in or create an NVIDIA developer account
3. Create or manage your API keys from the [API Keys page](https://build.nvidia.com/settings/api-keys)
4. Copy this API key into {configSetup} or {configApikeySet}`,
      nvidia_important_title: `Important Notes:`,
      nvidia_important_description: `- Text and embeddings use NVIDIA's hosted \`integrate.api.nvidia.com\` surface
- Native image generation uses NVIDIA's hosted \`ai.api.nvidia.com\` FLUX endpoint`,
      nvidia_footer: `After setting up this provider, you may change text, embedding, and image models with {configModel}, {configModelEmbedding}, and {configModelImage}`,
      zai_title: `Setting Up Z.ai API Key`,
      zai_description: `Z.ai provides access to the GLM family through a general API and a separate coding endpoint.

⚠️ **Terms of Service Update:** Z.ai's ToS have been updated to only permit coding/agent use cases. Using the general endpoint for non-coding chat is at your own risk and may violate their terms.`,
      zai_getting_key_title: `Getting Your API Key:`,
      zai_getting_key_description: `1. Visit the [Z.ai Platform](https://z.ai)
2. Sign in or create an account
3. Navigate to API Keys in your dashboard
4. Create a new API key
5. Copy this API key into {configSetup} or {configApikeySet}`,
      zai_important_title: `Important Notes:`,
      zai_important_description: `- Use the general endpoint for normal chat, reasoning, and native image generation
  - The dedicated Coding endpoint is separate and intended for coding-specific workflows
  - ⚠️ Z.ai's ToS restricts usage to coding/agent scenarios only, general chat/roleplay use is at your own risk`,
      zai_footer: `After setting up this provider, you may change its default model with {configModel}`,
      novelai_title: `Setting Up NovelAI API Key`,
      novelai_description: `NovelAI is a subscription-based service focused on creative storytelling and roleplay.
- Unlimited uncensored messages
- Supports uncensored text generation and NovelAI image generation, which is configured separately
- NovelAI text models do not support vision input
- [NovelAI Terms of Service](https://novelai.net/terms)`,
      novelai_getting_key_title: `Getting Your API Key:`,
      novelai_getting_key_description: `1. Visit [NovelAI](https://novelai.net/stories)
2. Navigate to settings through the ⚙️ icon on the top-left
3. Go to \`Account\`
4. Look for \`Get Persistent API Token\` (subscription required!)
5. Copy this API key into {configSetup} or {configApikeySet}`,
      novelai_footer: `After setting up this provider, you may change its default model with {configModel}`,
      openrouter_title: `Setting Up OpenRouter API Key`,
      openrouter_description: `OpenRouter provides access to multiple AI models from different providers on a pay-as-you-go basis.
 - Access to latest and most powerful AI models (some are free)
 - [OpenRouter Terms of Service](https://openrouter.ai/terms)`,
      openrouter_getting_key_title: `Getting Your API Key:`,
      openrouter_getting_key_description: `1. Visit [OpenRouter](https://openrouter.ai/settings/keys)
2. Click \`Create API Key\`
3. Copy this API key {configSetup} or {configApikeySet}`,
      openrouter_important_title: `Important Notes:`,
      openrouter_important_description: `- **Free models have strict rate limits**; paid models are usually more reliable
- **Always check pricing** before selecting a model
- Your OpenRouter account settings still apply here
- If you need a model that is not listed, suggest it in {supportServer}`,
      openrouter_footer: `After setting up this provider, you may change its default model with {configModel}`,
      vertex_title: `Setting Up Google Vertex AI`,
      vertex_description: `Google Vertex AI provides enterprise-grade access to Gemini models through Google Cloud.
- Uses Application Default Credentials (ADC) for authentication, no API key to manage
- Uses local gcloud ADC or a hosted workload identity/service account
- [Vertex AI Documentation](https://cloud.google.com/vertex-ai/docs)`,
      vertex_getting_key_title: `Configuration:`,
      vertex_getting_key_description: `**Step 1: Install the [Google Cloud CLI](https://cloud.google.com/cli)**

**Step 2: Create a Google Cloud project**
Run: \`gcloud projects create PROJECT_ID --name="Vertex AI Project"\`
(replace \`PROJECT_ID\` with a globally unique ID, e.g. \`my-vertex-project-12345\`)

**Step 3: Set it as your active project**
Run: \`gcloud config set project PROJECT_ID\`

**Step 4: Link a billing account**
Run: \`gcloud billing accounts list\` to find your billing account ID,
then: \`gcloud billing projects link PROJECT_ID --billing-account=ACCOUNT_ID\`

**Step 5: Enable the Vertex AI API**
Run: \`gcloud services enable aiplatform.googleapis.com\`

**Step 6: Set up Application Default Credentials**
Run: \`gcloud auth application-default login\` and log in via your browser.

**Step 7: Enter your configuration**
Enter \`{project_id}::{location}\` using {configSetup} or {configApikeySet}
- Use \`global\` as the location (recommended for preview models and best availability)
- Example: \`my-vertex-project-12345::global\``,
      vertex_important_title: `Important Notes:`,
      vertex_important_description: `- The stored value is **configuration** (project + location), not a credential secret
- All Vertex requests use the host's Application Default Credentials identity
- An AI Studio API key alone does not authenticate this provider. The project must have billing and the Vertex AI API enabled, and the host identity needs Vertex access.
- Supports chat, tool calling, streaming, structured output, compaction, embeddings, and preset generation`,
      vertex_footer: `After setting up this provider, you may change its default model with {configModel}`,
      vertexexpress_title: `Setting Up Google Vertex AI Express`,
      vertexexpress_description: `Google Vertex AI Express provides API-key access to Gemini on Vertex AI.
- Uses your own Google Cloud API key instead of host Application Default Credentials
- Best for deployed TomoriBot BYOK setups where each user stores their own key
- Preview feature with a smaller Gemini-only model catalog
- [Vertex AI Express Mode Overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview)`,
      vertexexpress_getting_key_title: `Setup Steps:`,
      vertexexpress_getting_key_description: `1. Open [Vertex AI Express Mode](https://console.cloud.google.com/expressmode)
2. If Google redirects you to standard Google Cloud, use the separate \`vertex\` provider instead. This is because Express Mode only works with Google accounts that have not created a billed GCP account yet.
3. In the Express console, open **APIs & Services > Credentials** and copy the Express API key
4. Add that raw API key with {configSetup} or {configApikeySet}
5. Choose a Vertex AI Express model with {configModel}`,
      vertexexpress_important_title: `Important Notes:`,
      vertexexpress_important_description: `- Store the raw API key, not \`{project_id}::{location}\`
- No location setting is needed here; \`global\` is only for the separate \`vertex\` provider
- Full Google Cloud Vertex projects should use \`vertex\`, not \`vertexexpress\`
- Model availability is limited to the Vertex AI Express Gemini catalog
- Image generation is available, but video and embeddings are not
- Express Mode is currently a Google Preview feature`,
      vertexexpress_footer: `After setting up this provider, you may change its default model with {configModel}`,
    },
    elevenlabs: {
      description: `Learn how to set up ElevenLabs text-to-speech`,
      title: `Setting Up ElevenLabs TTS`,
      getting_key_title: `Getting Your API Key:`,
      getting_key_description: `1. Visit [ElevenLabs](https://elevenlabs.io/app/settings/api-keys)
2. Sign up or sign in to your account
3. Create a new API key
4. Copy this API key using {configSpeechElevenlabs}`,
      choosing_voice_title: `Choosing a Voice:`,
      choosing_voice_description: `After setting up your API key, use {configSpeechVoiceAssign} to browse available voices.
- Add more voices from the [Voice Library](https://elevenlabs.io/app/voice-library), where you can also clone your own voices.`,
      free_voices_title: `Premade Voices (Free Tier):`,
      free_voices_description: `Only premade voices work on the free plan. Browse the full list at [ElevenLabs Premade Voices](https://elevenlabs-sdk.mintlify.app/voices/premade-voices), then use {configSpeechElevenlabs} or {configSpeechVoiceAssign} to assign one to each persona.`,
      important_notes_title: `Important Notes:`,
      important_notes_description: `- Characters are counted when I generate and read voice messages
- Free tier has monthly limits; check your usage on the ElevenLabs dashboard
- Visible transcript posting is controlled separately by {configSpeechTranscripts}`,
      footer: `Run {configSpeechElevenlabs} again to update the ElevenLabs key.`,
    },
    memory: {
      description: `Learn about TomoriBot's memory system`,
      title: `How My Memory Works`,
      embed_description: `I have a persistent memory system that helps me remember facts and information about users and servers across conversations. This is about **what I know** (facts, context, information). For **how I behave** (personality, tone, settings), see {helpCustomization} instead!`,
      teaching_title: `Teaching Me Things`,
      teaching_description: `Use {memoryPersonalAdd} and {memoryServerAdd} to help me remember **facts and information**:
- **Personal memories** ({memoryPersonalAdd}): Facts about individual users
  - Example: "Amaori loves cats", "Prefers dark mode", "Is allergic to peanuts"
- **Server memories** ({memoryServerAdd}): Information relevant to the whole server
  - Example: "Game night is every Friday at 8 PM", "No posting of NSFW", "We use #general for announcements"`,
      forgetting_title: `Forgetting Things`,
      forgetting_description: `Use {memoryPersonalRemove} and {memoryServerRemove} to make me forget memories:
- {memoryPersonalRemove} - Remove personal facts about users
- {memoryServerRemove} - Remove server-wide information`,
      how_it_works_title: `How It Works:`,
      how_it_works_description: `- **Personal memories** are tied to you specifically across all servers which I only keep in mind when replying in conversations you are actively participating in
- **Server memories** only stay within the server, I always keep them in mind when replying in a conversation within the server
- Memories persist until you remove them with the relevant \`/memory ... remove\` command`,
      tips_title: `Memory Tips:`,
      tips_description: `- Teach me your preferences, nicknames, and important facts
- Use server memories for shared information, inside jokes, or server rules
- Review your memories periodically with {memoryPersonalExport}, {memoryServerExport}, or {status}
- Keep memories concise and clear for best results{legalNotice}`,
      documents_title: `Document Knowledge Base`,
      documents_description: `Server administrators can upload documents for me to reference:
- Use \`/memory document add\` to upload text, PDF, or Markdown files
- Use \`/learn history\` to extract channel history into document memories
- Documents are chunked and stored as searchable embeddings
- I automatically retrieve relevant content based on the conversation
- Use \`/memory document remove\` or \`/memory history remove\` to remove stored documents
- Requires an embedding model configured via \`/model embedding\``,
      shortterm_title: `Short-Term Memory`,
      shortterm_description: `In addition to persistent memories, I keep [STM (short-term memory)](https://docs.tomoribot.app/en/features/knowledge/memory/#short-term-memory-stm) of recent conversations:
- Recent messages are cached per channel, and each persona carries the latest STM across channels within the same server
- I can automatically summarize older conversations to keep context efficient
- **Cross-server sharing** is opt-in: use {personalStm} with the \`crossserver\` option to let me reference your own conversations from other servers
- Clear your user-specific STM with {personalStmClear}
- STM expires automatically over time`,
    },
    stm: {
      description: `Learn how to customize my short-term memory (server admins)`,
      title: `Short-Term Memory Customization`,
      embed_description: `Short-term memory (STM) is my working memory of the *current* conversation in each channel (separate from the persistent facts in {helpMemory}). Server admins can tune how it refreshes, how it renders, and what it tracks.`,
      parameters_title: `Tuning Behavior ({stmParameters})`,
      parameters_description: `Adjust the core knobs (*"crude"* means the original, unsummarized messages: the raw conversation before I condense it into a summary):
- **Refresh cadence**: how many of my turns pass between refresh nudges (default **5**).
- **Render mode**: how the summary and the raw messages combine. *Supersede* (the summary replaces the raw messages) or *Crude + summary* (show both).
- **Crude messages**: how many recent raw (unsummarized) messages to keep in context (default **6**).
- **Nudge depth**: where the refresh nudge sits in the conversation (0 = very bottom; 2 = just above the latest exchange, the default).
- **Content depth**: where my memory block sits (-1 = up top as background knowledge, the default; 0 = very bottom; N = before the Nth turn from the bottom). At the same depth as the nudge, my memory block sits just above it.`,
      nudge_title: `How the Refresh Nudge Works`,
      nudge_description: `While a conversation is going I get a quiet system hint to create or update my STM, but only once every *cadence* turns, so I'm not nagged every message. The counter advances each time I respond (whether or not I saved anything) and resets only when I actually use my STM tool. If I keep ignoring it, the nudge stays due until I act.`,
      categories_title: `Categories ({stmCategoriesEdit})`,
      categories_description: `By default STM is one free-form summary. Define up to 5 labeled fields (e.g. \`Goals\`, \`Inventory\`) and I'll fill each one separately via tool calls and render them as labeled sections. Clear all fields to return to the single-summary default.`,
      prompts_title: `Prompt Overrides ({stmPromptEdit})`,
      prompts_description: `Customize two prompt strings:
- **Tool description**: what my STM tool advertises to the model.
- **Memory nudge**: the unified create/update hint text.
Leave a box empty to reset it to the built-in default. Key \`{...}\` macros you can use:
- \`{short_term_memory_tool}\` → the STM tool name
- \`{memory_tool}\` / \`{memory_update_tool}\` → long-term memory tool names
- \`{category_labels}\` → your configured category labels *(nudge only, category mode)*
Unknown placeholders are stripped automatically.`,
      manage_title: `Managing & Scoping`,
      manage_description: `- {stmManage}: review and clear active server-shared STM entries.
- {stmPrivacyBypass}: control whether private-channel STM can surface in other channels.
- {personaStmEdit}: hand-edit a persona's live STM for the current channel.`,
    },
    "memory-tagging": {
      description: `Learn how memory keyword and channel tagging works`,
      title: `Memory Tagging`,
      embed_description: `Scope narrows things first: a server memory only reaches prompts in its own server, a personal memory only when that user is visible in the conversation, and both only for the persona that owns them. Within that scope, all memories are sent with every prompt by default. Tagging narrows it further. Turn on memory and channel tagging with {memoryTaggingSet}.`,
      keywords_title: `Keyword Tags`,
      keywords_description: `- Memories **without** keyword tags will always be active (default behavior)
- Memories **with** keyword tags will only activate when the keyword is visible in the context
- Use {toolPromptSnapshot} to see which memories are currently activating`,
      channels_title: `Channel Tags`,
      channels_description: `- Memories with \`#channel\` tags will activate only in that channel
- Channel tags can be combined with keyword tags
- If using RAG, channel tags can also be applied to documents (\`/memory document add\`) and extracted histories (\`/learn history\`)`,
    },
    spotlight: {
      description: `Learn what personal spotlight does and how to use it`,
      title: `Personal Spotlight Guide`,
      embed_description: `[Personal spotlight](https://docs.tomoribot.app/en/features/knowledge/personalization/#personal-spotlight) lets you narrow which personas *you* can trigger in one channel, and optionally assign one persona to auto-trigger for your own messages there.`,
      what_title: `What It Does`,
      what_description: `- Spotlight is scoped to **you + one channel**
- It does not affect other users
- It acts like a personal persona whitelist for that channel
- You choose which personas stay available there`,
      set_title: `Setting One Up`,
      set_description: `Use {personalSpotlightSet} and choose:
- A duration in hours
- The target channel
- The personas you want in your spotlight

If you set **hours = 0**, the spotlight stays until you remove it manually.`,
      auto_trigger_title: `Auto-Trigger Option`,
      auto_trigger_description: `After choosing personas, you can optionally pick one of them as your personal auto-trigger persona.
- That persona becomes the fallback responder for your messages in that channel
- Direct triggers still target the persona you explicitly called
- If you press Finish instead, no personal auto-trigger persona is set`,
      rules_title: `Important Rules`,
      rules_description: `- Spotlight only **narrows** access; it never expands access
- It still respects server-level persona limits such as {serverWhitelistPersona}
- Selected personas are the **only** personas you can trigger there
- Proxy chains are blocked too: if your spotlight only includes Alice, an Alice reply cannot hand off to Bob for your message chain`,
      manage_title: `Changing Or Removing It`,
      manage_description: `Use {personalSpotlightManage} to review your active spotlight entries.
- Leave an entry checked to keep it
- Uncheck an entry to remove it
- Timed spotlights expire on their own`,
      footer: `Use personal spotlight when you want tighter control over which persona answers you in one channel without changing the server-wide setup.`,
    },
    "deliberate-trigger-mode": {
      description: `Learn how deliberate trigger mode changes message triggering`,
      title: `Deliberate Trigger Mode Guide`,
      embed_description: `[Deliberate Trigger Mode (DTM)](https://docs.tomoribot.app/en/features/chatting-personality/chatting-and-triggers/#deliberate-trigger-mode) changes how explicit persona triggers are recognized, especially for plain trigger words.`,
      normal_title: `Normal Triggering`,
      normal_description: `When DTM is off, I can normally be triggered by:
- Plain trigger words in a message
- Discord mentions
- Replies to the persona
- {respondCommand} for manual replies

In practice, plain trigger words are the biggest difference because they can directly activate a persona just by naming its trigger.`,
      enabled_title: `What Changes When DTM Is On`,
      enabled_description: `When DTM is on, plain trigger words stop counting as explicit persona triggers.
- \`@{trigger}\` still works
- Discord mentions still work
- Replies still work
- {respondCommand} still works

This means users must invoke personas more deliberately instead of accidentally triggering them with ordinary text.`,
      personal_title: `Server And Personal Control`,
      personal_description: `- Server admins can toggle the server-wide behavior with {serverDtm}
- Individual users can override it for themselves with {personalDtm}
- Personal DTM has three modes:
  off = always allow plain trigger words
  follow = use the server setting
  on = always require deliberate invocations`,
      footer: `If users say a persona name often in normal conversation and accidental triggers are a problem, DTM is the setting to use.`,
    },
    customization: {
      description: `Learn how to customize TomoriBot's personality and behavior`,
      embed1_title: `Customizing TomoriBot`,
      embed1_description: `TomoriBot is highly customizable! This is about **how I behave** (personality, tone, settings). For **what I remember** (facts, memories), see {helpMemory} instead!`,
      summary_personas_title: `Personas`,
      summary_personas_description: `Use {personaCreate} or {personaGenerate} to create a persona, then refine it with {personaAttributeAdd} and {personaSampleDialogueAdd}. Personas can be switched, exported, imported, and used as separate alter identities.`,
      summary_behavior_title: `Behavior Settings`,
      summary_behavior_description: `Use {configModel}, {configHumanizer}, {configSystemPromptSet}, and {capabilitiesManage} for model selection, humanlike delivery, system instructions, and feature access.`,
      summary_server_title: `Server Boundaries`,
      summary_server_description: `Admins can combine persona limits, whitelisted channels such as {serverWhitelistChannel}, auto-trigger settings, cooldowns, and role permissions to control where and how TomoriBot responds.`,
      embed1_personas_title: `Personality Personas`,
      embed1_personas_description: `Control my core personality and behavior:

**Persona Commands:**
- {personaCreate} - Create a custom personality from scratch
- {personaGenerate} - AI-generate a personality based on a description and image (requires a compatible provider with structured output; also supports uploading Tomori presets and SillyTavern cards to transform existing characters)
- {personaDefault} - Switch to a default personality
- {personaExport} - Export your persona to share or backup
- {personaImport} - Import a persona from a file (supports importing as an alter persona with its own triggers and webhook avatar)
- {personaRemove} - Remove an alter persona
- {personaAttributeAdd} / {personaSampleDialogueAdd} - Teach me how I should talk and act
- {serverAvatar} - Change my profile picture`,
      embed1_what_personas_include_title: `What Personas Include:`,
      embed1_what_personas_include_description: `- Personality attributes (traits, characteristics, and quirks)
- Sample dialogues (example conversations that teach me on how I should speak)
- Custom server avatar for that personality
- Behavior and tone settings
- Alter personas: separate characters with their own triggers, webhook avatar, and personality`,
      embed1_footer: `Next: Teaching Commands`,
      embed2_title: `Teaching Commands`,
      embed2_description: `Fine-tune my personality and knowledge:

**Personality Shaping:**
- {personaAttributeAdd} - Add personality traits or physical characteristics (e.g., "friendly", "red hair", "ends sentences with *Nya~*")
- {personaSampleDialogueAdd} - Add example conversations to shape how I talk
- {configRename} - Set what I should call myself

**Writing Sample Dialogues:**
Use \`{user}\` and \`{bot}\` placeholders in your examples:
- \`{user}\` = Replaced with the actual user's name/nickname
- \`{bot}\` = Replaced with my current name

**Example:**
\`\`\`
{user}: Hey, how are you?
{bot}: Yoooo {user}! I'm doin' great, ya feel me?
\`\`\`

**Tips for Great Sample Dialogues:**
- Write natural, conversational exchanges
- Include personality traits you want me to exhibit
- Demonstrate the tone you want
- Add variety to help me learn better
- Use placeholders so dialogues work for everyone when sharing me with \`/persona export\``,
      embed2_footer: `Next: Configuration`,
      embed3_title: `Configuration & Management`,
      embed3_description: `**Remove personality customizations:**
- {personaAttributeRemove} - Remove specific personality attributes
- {personaSampleDialogueRemove} - Remove sample dialogue examples

**Server-wide settings and behavior:**
Learning & Privacy:
- {serverMemberpermissions} - Control who can teach me things
- {serverBlacklist} - Prevent me from learning and using memories from specific users

Auto-Trigger Behavior:
- {serverAutotriggerChannels} - Set channels where I respond without mentions
- {serverAutotriggerThreshold} - Set message threshold for auto-responses

Triggers & Appearance:
- {serverTriggerAdd} - Add custom trigger words I respond to (also works with alter personas)
- {serverTriggerRemove} - Remove trigger words
- {serverAvatar} - Set my custom profile picture for this server

Channel Whitelist & Cooldowns:
- {configCooldown} - Set global cooldown between my responses
- {serverWhitelistChannel} - Add a channel to the whitelist (only whitelisted channels can trigger me)
- {serverWhitelistPersona} - Limit which channels a persona can trigger in
- {serverWhitelistRole} - Add/remove roles allowed to trigger me when role whitelist is active
- {serverWhitelistRemove} - Remove whitelist entries
- Whitelisted channels inherit the global cooldown unless you set a channel-specific override

Documents:
- {memoryDocumentAdd} - Upload a document for me to reference
- {memoryDocumentRemove} - Remove an uploaded document`,
      embed3_footer: `Next: Bot Settings`,
      embed4_title: `Advanced Settings`,
      embed4_description: `**Personal bot settings:**
AI Settings:
- {configModel} - Choose which AI model to use
- {configTemperature} - Adjust creativity/randomness. The higher, the more varied the responses (1.0-2.0)
- {configHumanizer} - Change how humanlike my responses should be

Image Generation:
- {generateImage} - Generate an image from a prompt or by editing a reference image
- {configModelImage} - Choose which image generation model to use (supports Text2Image and Image2Image)

System Prompt:
- {configPromptChange} - Add a custom system instruction (up to 16000 characters)
- {configPromptPreset} - Choose from preset system prompts
- {configPromptClear} - Reset to the default system prompt

API Keys:
- {configApikeySet} - Set your AI provider API key
- {configApikeyDelete} - Remove your API key
- {configApikeyRotation} - Manage backup API keys for automatic failover and load balancing
- {configBraveapiSet} - Set Brave Search API key (optional)
- {configBraveapiDelete} - Remove Brave Search API key

Personalization:
- {configRename} - Change what I refer to myself as
- {configTimezone} - Set server timezone for time-aware responses and reminders
- {configPermissions} - Toggle my features on/off (including image generation)
- {configUncensors} - Configure uncensored output options
- {personalPrivacy} - Control your visibility to me (full invisibility option available)
- {expressionsInitialize} - Register server emoji and sticker appearances so I use them correctly

Document Knowledge Base:
- {configModelEmbedding} - Configure an embedding model for document uploads and RAG`,
      embed4_footer: `If you have any more questions, join the support server with /support discord`,
      embed5_title: `Pro Tips`,
      embed5_description: `- Start with a persona (default or generated) as a foundation
- Use \`/persona attribute add\` for quick personality tweaks
- For Sample Dialogues, using examples that exhibit their attributes and traits as well is effective:
\`\`\`
User message: {user}: What's your favorite hobby?
Bot response: {bot}: Fufu~ I like knitting tiny clothes for tiny plushies~♥
\`\`\`
- Test changes by chatting, iterate until it feels right
- Export your persona to back it up or share with other servers!`,
    },
    mcp: {
      description: `Learn how to add and manage MCP tool servers`,
      title: `MCP Server Setup Guide`,
      description_text: `MCP (Model Context Protocol) servers extend TomoriBot's capabilities with external tools. Here's how to get started.`,
      online_title: `Adding an Online MCP`,
      online_description: `Any publicly hosted MCP server with an HTTPS endpoint can be added, Smithery.ai is one example source.

**Using Smithery.ai:**
**1.** Visit [smithery.ai](https://smithery.ai), create an account, and generate an API key from your profile.
**2.** Browse the catalog and open an MCP you want. Copy the **connection URL** shown on its page (e.g. \`https://youtube.run.tools\`).
**3.** Run {mcpsCommand} and choose **+ Add MCP**. In the form, paste the connection URL into **URL**, paste your Smithery API key into **Auth Token**, and choose the required **Server Type**. **General Purpose** is selected by default.

**Using other sources:**
If an MCP server requires no authentication, leave the **Auth Token** field blank. Some servers may use a different auth format. Check the server's documentation for details.

Your auth token is encrypted at rest and never shown in plain text after saving.`,
      online_summary_description: `Open {mcpsCommand} and choose **+ Add MCP** to register a publicly reachable HTTPS MCP server. Auth tokens are encrypted after saving; check the docs for provider-specific connection URL notes.`,
      local_title: `Adding a Local MCP (Self-Hosted Only)`,
      local_description: `Local MCP servers are **only supported on self-hosted TomoriBot instances**. The public hosted bot requires HTTPS and blocks local/private addresses for security.

If you are running your own instance, point the URL to your local server (e.g. \`http://localhost:3000/sse\`). No auth token is needed for local servers.`,
      local_summary_description: `Local MCP servers are self-host only because the public bot blocks local/private addresses. The docs explain how to run a local MCP and register its URL.`,
      removing_title: `Removing an MCP Server`,
      removing_description: `Open {mcpsCommand}, select the server, and choose **Remove**. Confirming immediately disconnects the server and frees a slot for a new one.`,
      security_title: `Security Warning`,
      security_description: `**Only add MCP servers you trust.**

A malicious MCP server can:
- **Prompt-inject** me by sending hidden instructions that override her behavior
- **Exfiltrate data** that users pass to its tools (messages, file content, etc.)
- Return **harmful or false results** that TomoriBot will relay to your server

Treat MCP servers with the same caution as browser extensions or third-party apps. If in doubt, do not add it.`,
      footer: `Always review an MCP's described tools before adding it.`,
    },
    nsfw: {
      description: `Learn how to enable age-restricted (NSFW) commands`,
      title: `Enabling Age-Restricted Commands`,
      embed_description: `TomoriBot supports age-restricted commands. Here's how to enable them:`,
      enable_title: `Step 1: Enable in Discord Settings`,
      enable_description: `**1.** Open Discord and go to **User Settings** (gear icon in the bottom-left)
**2.** Navigate to **Privacy & Safety**
**3.** Toggle on: **Allow access to age-restricted commands in apps**
**4.** Once enabled, you'll be able to use NSFW commands

Note: You must be 18 or older to enable this setting.`,
      channel_title: `Step 2: Use Commands in NSFW Channels`,
      channel_description: `Age-restricted commands can only be executed in channels marked as NSFW:
- On desktop: Right-click a channel → **Edit Channel** → Toggle **NSFW**
- On mobile: Channel settings → Toggle **NSFW**
- Only server admins can mark channels as NSFW

If a command is restricted and the channel isn't marked NSFW, you won't be able to see the command.`,
      warning_title: `⚠️ Content Warning`,
      warning_description: `Age-restricted commands may contain **mature or explicit content**. These commands are intended for adult users only. Use responsibly and respect Discord's Community Guidelines.`,
      footer: `For more help, use \`/help\` to see all available commands.`,
    },
    "deliberate-tool-mode": {
      description: `Learn how deliberate tool mode changes tool availability`,
      title: `Deliberate Tool Mode Guide`,
      embed_description: `[Deliberate Tool Mode](https://docs.tomoribot.app/en/features/capabilities/tools-and-extensions/#deliberate-tool-mode) keeps tool declarations out of ordinary chat turns unless the message looks like it needs a tool.`,
      what_title: `What It Does`,
      what_description: `When deliberate tool mode is active, I first check the message for explicit tool intent. If no intent is found, tool declarations are removed for that turn, which reduces prompt size and helps smaller/local models answer faster.`,
      intent_title: `What Counts As Tool Intent`,
      intent_description: `Built-in triggers cover common requests like reminders, web search, memory updates, cross-channel messages, image/video/voice generation, media analysis, thread creation, and message actions.

Follow-up wording also works when recent context points to a tool, such as \`do that again but angrier\`, \`same thing but softer\`, or \`pretty please?\` after a voice-message request.`,
      custom_title: `Custom Trigger Phrases`,
      custom_description: `Server managers can add literal phrases with {triggerCommand}. For example, \`pic\`, \`img\`, or \`pfp\` can expose image generation, while server-specific slang can map to whichever tool target fits.`,
      control_title: `Controls And Logs`,
      control_description: `- Server managers toggle it with {serverDtm}
- Users can override it for themselves with {personalDtm}
- If a thought-log channel is configured with {thoughtLogs}, successful deliberate-mode tool calls are logged there with the trigger that exposed the tool`,
      footer: `Deliberate tool mode decides which tools are shown to the model. The model still has to actually choose to call the exposed tool.`,
    },
  },
};
