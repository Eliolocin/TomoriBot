export default {
  speech: {
    description: `音声出力の声とサンプルを管理します。`,
    "voice-add": {
      description: `ローカルTTS用の参照音声サンプルをアップロードします。`,
    },
    "voice-remove": {
      description: `このサーバーのローカルTTS音声サンプルを削除します。`,
    },
    "voice-assign": {
      description: `ペルソナに音声出力用の声を割り当てます。`,
    },
    "voice-design": {
      description: `ペルソナの VoiceDesign プロンプトを管理します。`,
      set: {
        description: `ペルソナに VoiceDesign 用の声質プロンプトを設定します。`,
      },
      remove: {
        description: `ペルソナの VoiceDesign プロンプトを削除します。`,
      },
    },
    elevenlabs: {
      description: `ElevenLabs の音声生成と文字起こしを接続します。`,
      key_description: `ElevenLabs APIキー。`,
      invalid_key_title: `APIキーが無効です`,
      invalid_key_description: `有効な ElevenLabs APIキーを入力してください。`,
      key_validation_failed_title: `キー検証に失敗しました`,
      key_validation_failed_description: `この ElevenLabs キーを検証できませんでした。キーを確認して再試行してください。`,
      success_title: `ElevenLabs を接続しました`,
      success_description: `ElevenLabs の音声生成と文字起こしエンドポイントを接続しました。\`/speech voice-assign\` でペルソナに声を割り当てます。`,
    },
    chatterbox: {
      description: `Chatterbox の音声設定を管理します。`,
    },
    transcripts: {
      description: `ボイスメッセージの表示用字幕投稿を切り替えます。`,
      set_description: `チャット内の表示用字幕メッセージを有効または無効にします。`,
      already_set_title: `既に設定済みです`,
      already_enabled_description: `このサーバーでは表示用字幕投稿が既に有効です。`,
      already_disabled_description: `このサーバーでは表示用字幕投稿が既に無効です。`,
      success_title: `表示用字幕モードを更新しました`,
      enabled_success: `表示用字幕投稿を**有効**にしました。ボイスメッセージは文字起こしされ、Webhook経由でチャットに投稿されます。内部理解用の背景STTは \`/providers\` で別途設定します。`,
      disabled_success: `表示用字幕投稿を**無効**にしました。文字起こしエンドポイントが設定されている場合、内部理解用の背景STTは引き続き利用できます。`,
    },
    voice_assign: {
      description: `ペルソナに音声出力用の声を割り当てます。`,
      no_speech_endpoint_title: `音声エンドポイントがありません`,
      no_speech_endpoint_description: `まず \`/providers\` で音声エンドポイントを登録してください。`,
      no_sample_title: `音声サンプルがありません`,
      no_sample_description: `まず \`/speech voice-add\` でローカル音声サンプルを追加してください。`,
      select_persona_title: `音声を設定するペルソナを選択`,
      clear_choice_label: `音声を無効化`,
      clear_choice_description: `このペルソナの現在の音声設定を削除します。`,
      assign_clone_title: `音声サンプルを割り当て`,
      sample_ref_hint_with: `書き起こしあり · {duration}`,
      sample_ref_hint_without: `{duration}`,
      elevenlabs_modal_title: `ElevenLabs音声を選択`,
      elevenlabs_voice_fetch_failed_title: `音声一覧を取得できませんでした`,
      elevenlabs_voice_fetch_failed_description: `ElevenLabsの音声一覧を読み込めませんでした。設定済みキーを確認して再試行してください。`,
      success_title: `ペルソナの音声を更新しました`,
      success_description: `**{persona}** は今後、ボイスメッセージで **{voice}** を使用します。`,
      cleared_title: `ペルソナの音声を解除しました`,
      cleared_description: `**{persona}** の音声設定を削除しました。`,
    },
    voice_design: {
      description: `ペルソナに VoiceDesign 用の声質プロンプトを設定します。`,
      prompt_description: `任意の声質説明。省略すると大きめの入力欄を開きます。`,
      unsupported_endpoint_title: `VoiceDesign エンドポイントが有効ではありません`,
      unsupported_endpoint_description: `VoiceDesign プロンプトを設定する前に、Supports Instruct が有効なローカルTTSエンドポイントを選択してください。`,
      select_persona_title: `VoiceDesign を設定するペルソナを選択`,
      modal_title: `VoiceDesign プロンプト`,
      update_modal_title: `VoiceDesign プロンプトを更新`,
      prompt_label: `声質説明`,
      prompt_help: `話者の年齢、声色、質感、アクセント、速度、感情、話し方を説明してください。`,
      prompt_placeholder: `落ち着いた大人のナレーター。ゆっくりめで、柔らかく息成分のある、安心感のある話し方。`,
      prompt_required_description: `VoiceDesign プロンプトを入力してください。`,
      success_title: `VoiceDesign プロンプトを設定しました`,
      success_description: `**{persona}** はローカルボイスメッセージで次の VoiceDesign プロンプトを使用します:
\`\`\`
{preview}
\`\`\``,
      no_prompt_title: `VoiceDesign プロンプトがありません`,
      no_prompt_description: `削除できる VoiceDesign プロンプトがありません。\`/speech voice-design set\` で設定できます。`,
      cleared_title: `VoiceDesign プロンプトを削除しました`,
      cleared_description: `**{persona}** から VoiceDesign プロンプトを削除しました。`,
      cleared_description_with_prompt: `**{persona}** から VoiceDesign プロンプトを削除しました。控えが必要な場合は以下をコピーしてください：
\`\`\`
{removed_prompt}
\`\`\``,
    },
    validation: {
      sample_not_found: `音声サンプルが見つかりません。`,
      no_voice_assigned: `このペルソナには音声が割り当てられていません。`,
      unsupported_format: `未対応の音声形式です。`,
      file_too_large: `アップロードされたファイルが大きすぎます。`,
    },
  },
};
