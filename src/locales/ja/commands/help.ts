export default {
  help: {
    description: `セットアップ、機能、プロバイダー、メモリ、動作、ツール、メディア、連携のガイドを表示します。`,
    dashboard: {
      header_title: `TomoriBotを始める`,
      header_description: `カスタマイズ可能なAIアシスタント兼ロールプレイシステム、TomoriBotの設定方法を紹介します。`,
      categories: {
        setup: `セットアップ`,
        features: `機能`,
        memory: `メモリ`,
        behavior: `動作`,
        integrations: `連携`,
      },
      pages: {
        setup_step_1: `ステップ1：APIキーを取得`,
        setup_step_2: `ステップ2：セットアップを実行`,
        setup_step_3: `ステップ3：チャットを開始`,
        setup_step_4: `ステップ4：TomoriBotをカスタマイズ（任意）`,
        features: `機能`,
        personal_providers: `個人プロバイダー`,
        custom_endpoints: `カスタムエンドポイント`,
        speech: `音声生成`,
        transcription: `文字起こし`,
        persistent_memory: `永続メモリ`,
        short_term_memory: `短期メモリ`,
        memory_tagging: `メモリタグ`,
        customization: `カスタマイズ`,
        personal_spotlight: `個人スポットライト`,
        deliberate_trigger_mode: `慎重トリガーモード`,
        deliberate_tool_mode: `慎重ツールモード`,
        age_restricted_commands: `年齢制限コマンド`,
        matrix: `Matrix`,
        mcp: `MCP`,
        sillytavern_presets: `SillyTavernプリセット`,
      },
      page_reference: `\`/help\`内の **{page}** ページ`,
      page_select_placeholder: `ページを選択`,
      guide_select_placeholder: `ガイドを選択`,
      provider_select_placeholder: `プロバイダーを選択`,
      previous_button: `< 前へ`,
      next_button: `次へ >`,
      docs_link_label: `ウェブ版を読む`,
      support_link_label: `技術サポートを受ける`,
      variants: {
        overview: `概要`,
        chatterbox: `Chatterbox-Turbo`,
        qwen3tts: `Qwen3-TTS`,
        irodoritts: `IrodoriTTS`,
        elevenlabs: `ElevenLabs`,
        whisperx: `WhisperX`,
        koboldcpp: `KoboldCPP`,
      },
      api_keys: {
        title: `プロバイダーAPIキー`,
        description: `下からプロバイダーを選ぶとAPIキーの案内が開きます。案内を閉じても、このヘルプ画面は引き続き利用できます。`,
      },
    },
    "personal-provider": {
      description: `個人プロバイダーの仕組みを確認します。`,
      title: `個人プロバイダー`,
      description_body: `個人プロバイダーを使うと、サーバー共通の既定ではなく、あなた自身のAPIキーとモデルであなた自身のリクエストを処理できます。`,
      setup_field: `設定手順`,
      setup_value: `1. {add_command} でプロバイダーを保存すると、個人の **テキスト** モデルが同時に有効になります。
2. {model_command} は任意です。手順1の既定モデル以外を使いたい場合にのみ使用します。
3. {toggle_command} で機能ごとに個人上書きを有効化・無効化します。`,
      behavior_field: `動作`,
      behavior_value: `有効な機能は、TomoriBotを使うすべてのサーバーであなた自身のリクエストにのみサーバー既定を上書きします。モデルを選んだ時点でその機能は有効になるため、手順3は主に機能をオフに戻すためのものです。思考ログにはその旨が記録され、{samplers_command} と {fallback_command} で調整できます。`,
      byok_field: `BYOKサーバー`,
      byok_value: `{byok_command} により、メンバー自身のプロバイダーが必須になるサーバーがあります。このモードでは、ユーザー発言に対する応答に個人プロバイダーが必要です。`,
      footer: `サーバー既定は /provider と /model で管理します。個人上書きは、TomoriBotを使うすべてのサーバーであなたのリクエストにのみ影響します。`,
    },
    custom_models: {
      description: `カスタムエンドポイントの使い方を確認します。`,
      endpoint_description: `表示するカスタムエンドポイントのガイドを選びます。`,
      choice_overview: `概要`,
      choice_comfyui: `ComfyUI`,
      title: `カスタムエンドポイント`,
      description_body: `カスタムエンドポイントを使うと、Ollama、LM Studio、LiteLLM、ComfyUI などの自己ホスト/プロキシ型エンドポイントをラベル付きプロバイダーバンドルとして登録できます。`,
      server_field: `サーバー登録`,
      server_value: `{add_command} でサーバー共通のエンドポイントを登録し、{remove_command} でそのラベルから選んだ機能だけ削除できます。`,
      personal_field: `個人登録`,
      personal_value: `{add_command} で自分専用のラベル付きエンドポイントを登録し、{remove_command} で選んだ機能だけ削除できます。`,
      selection_field: `使い方`,
      selection_value: `登録後は {text_command}、{image_command}、{video_command} からラベルを選択してください。そのラベルに同じ機能のモデルが複数ある場合は、選択メニューから1つ選べます。画像理解対応のテキストエンドポイントは \`/model vision\` にも表示されます。同じラベル・同じ機能で別のモデル名を指定して追加コマンドを再実行すると、その接続にモデルを追加登録できます（エンドポイントURLとAPIスタイルは引き継がれます）。`,
      selection_summary_value: `登録後は {text_command}、{image_command}、{video_command} からラベルを選択します。同じラベルに同一機能のモデルが複数ある場合は、TomoriBot が使用するモデルを確認します。`,
      labels_field: `ラベルと削除`,
      labels_value: `1つのラベルは対応する全機能をまとめたカスタムプロバイダーバンドルです。{server_remove_command} と {personal_remove_command} はチェックを外した機能だけ削除します。{server_provider_remove_command} と {personal_provider_remove_command} はそのラベル全体を削除します。`,
      comfyui_page1_title: `ComfyUI セットアップ`,
      comfyui_page1_description: `このガイドでは、ComfyUI がすでにインストール済みかつ起動中である前提で進めます。1ページ目では、\`/provider custom-endpoint add\` または \`/personal custom-endpoint add\` まで到達する最小構成を説明します。または、GitHubリポジトリにあるそのまま使える[ComfyUIワークフロー](https://github.com/Bredrumb/TomoriBot/tree/main/assets/comfyui-workflows)を使用することもできます。`,
      comfyui_page1_workflow_field: `1. ワークフローを作る`,
      comfyui_page1_workflow_value: `まず ComfyUI 側でワークフローを作成し、正常に動くことを確認してください。画像用 MVP では、TomoriBot が完成ファイルを取得できるよう最後を \`SaveImage\` で終える必要があります。最小構成の画像グラフは通常、\`CheckpointLoaderSimple\` -> positive/negative \`CLIPTextEncode\` -> \`EmptyLatentImage\` -> \`KSampler\` -> \`VAEDecode\` -> \`SaveImage\` です。`,
      comfyui_page1_placeholders_field: `2. プレースホルダーを入れる`,
      comfyui_page1_placeholders_value: `テキスト入力欄には \`{TOMORI_PROMPT}\` をそのまま使えます。TomoriBot は、アップロードした API 形式 JSON 内の対応済み \`{TOMORI_*}\` トークンを実行前に置換します。文字列プレースホルダーは長い文章の一部として埋め込めますが、数値や真偽値は通常 JSON の値全体を置き換える形で使います。`,
      comfyui_page1_export_field: `3. JSON を書き出して編集する`,
      comfyui_page1_export_value: `ComfyUI で動作確認できたら Save (API Format) で JSON を保存してください。数値や真偽値のプレースホルダーを使う場合は、アップロード前に JSON を編集し、値全体をプレースホルダーに置き換えます。例: \`"width": "{TOMORI_WIDTH}"\`、\`"height": "{TOMORI_HEIGHT}"\`、\`"duration": "{TOMORI_VIDEO_DURATION}"\`。`,
      comfyui_page1_register_field: `4. 登録して有効化する`,
      comfyui_page1_register_value: `サーバー共通なら {server_add_command}、個人用なら {personal_add_command} を使います。\`endpoint_url\` には ComfyUI サーバーの URL（例: \`http://127.0.0.1:8188\`）を入れ、\`api_style\` は \`ComfyUI\`、\`capability\` は \`Image\` か \`Video\` を選択してください。コマンド実行後に表示されるモーダルの **ワークフローJSON** ファイル欄に書き出した JSON をアップロードします。その後、{image_command} または {video_command} でラベルを選択して有効化します。`,
      comfyui_page2_title: `ComfyUI プレースホルダー`,
      comfyui_page2_description: `2ページ目では、TomoriBot が ComfyUI ワークフローへ注入できる主なプレースホルダーをまとめます。`,
      comfyui_page2_core_field: `基本値`,
      comfyui_page2_core_value: `基本プレースホルダー: \`{TOMORI_PROMPT}\`、\`{TOMORI_MODEL}\`、\`{TOMORI_MODEL_NAME}\`、\`{TOMORI_MODE}\`、\`{TOMORI_ASPECT_RATIO}\`、\`{TOMORI_SIZE}\`。\`{TOMORI_MODE}\` は \`image\` または \`video\` に解決され、\`{TOMORI_SIZE}\` は \`1024x1024\` や \`1280x720\` のような文字列になります。`,
      comfyui_page2_numeric_field: `画像サイズ`,
      comfyui_page2_numeric_value: `サイズ系プレースホルダー: \`{TOMORI_WIDTH}\` と \`{TOMORI_HEIGHT}\`。画像生成では、TomoriBot が要求されたアスペクト比からこれらを導出します。latent サイズやキャンバスサイズなど、JSON 上で数値を期待する欄に使ってください。`,
      comfyui_page2_video_field: `動画用引数`,
      comfyui_page2_video_value: `動画用プレースホルダー: \`{TOMORI_VIDEO_DURATION}\`、\`{TOMORI_DURATION_SECONDS}\`、\`{TOMORI_VIDEO_RESOLUTION}\`、\`{TOMORI_RESOLUTION}\`、\`{TOMORI_GENERATE_AUDIO}\`。これらは \`generate_video\` ツールの引数から解決されます。`,
      comfyui_page3_title: `ComfyUI Img2Img`,
      comfyui_page3_description: `3ページ目では、画像参照つきのフローと img2img 的な扱いを説明します。`,
      comfyui_page3_image_refs_field: `参照画像の集め方`,
      comfyui_page3_image_refs_value: `\`generate_image\` では、\`media_id\` で参照した Discord メッセージ内の全画像が追加され、\`target_identity\` を使うと 1 人以上のユーザーまたはペルソナのアバターを追加参照として渡せます。\`generate_video\` では、\`media_id\` で参照したメッセージの最初の画像だけが開始フレーム候補になります。`,
      comfyui_page3_reference_tokens_field: `参照画像プレースホルダー`,
      comfyui_page3_reference_tokens_value: `TomoriBot は \`{TOMORI_REFERENCE_IMAGE_COUNT}\`、\`{TOMORI_REFERENCE_IMAGES}\`、\`{TOMORI_REFERENCE_IMAGES_JSON}\` に加えて、\`{TOMORI_REFERENCE_IMAGE_1_DATA_URL}\`、\`{TOMORI_REFERENCE_IMAGE_1_BASE64}\`、\`{TOMORI_REFERENCE_IMAGE_1_MIME_TYPE}\`、URL がある場合は \`{TOMORI_REFERENCE_IMAGE_1_URL}\` も渡します。複数ある場合は \`_2_\`、\`_3_\`… と同じ形式で増えます。`,
      comfyui_page3_reference_note_field: `重要な注意点`,
      comfyui_page3_reference_note_value: `TomoriBot は参照画像データをワークフロー JSON に運べますが、標準 ComfyUI ノードはその文字列を自動で \`IMAGE\` テンソルに変換しません。参照画像プレースホルダーは、data URL・base64・JSON 配列を読めるカスタムノードやノードパックと組み合わせる前提だと考えてください。`,
      comfyui_page4_title: `ComfyUI 動画と出力`,
      comfyui_page4_description: `4ページ目では、動画フロー、保存出力、メタデータについて説明します。`,
      comfyui_page4_video_field: `動画フロー`,
      comfyui_page4_video_value: `動画ワークフロー実行時、TomoriBot はプレースホルダーを解決した後に ComfyUI の \`/prompt\` へグラフを POST し、\`/history/{prompt_id}\` をポーリングし、最初に保存されたファイルを \`/view\` から取得します。認証つき ComfyUI エンドポイントには、保存済み Bearer トークンもこれらの API 呼び出しへ送られます。`,
      comfyui_page4_output_field: `保存出力`,
      comfyui_page4_output_value: `TomoriBot が取得するのは最初に保存された出力だけなので、ワークフローは実際に画像または動画ファイルを保存する必要があります。プレビュー専用ノードだけでは不十分です。複数保存した場合は、ComfyUI の history で最初に報告されたものが返されます。`,
      comfyui_page4_metadata_field: `extra_pnginfo メタデータ`,
      comfyui_page4_metadata_value: `TomoriBot は、解決済みの値を \`extra_pnginfo\` にも入れます。そこには prompt、model、mode、aspect ratio、width、height、size、参照画像数、さらに動画用の duration・resolution・audio フラグも含まれます。JSON プレースホルダーの代わりに ComfyUI メタデータを読むカスタムノードを使いたい場合に有用です。`,
      comfyui_summary_description: `ComfyUI カスタムエンドポイントでは、保存済みの画像/動画ワークフローを TomoriBot がキューに送り、最初に保存された出力を返します。詳しい手順は、ワークフロー書き出し、プレースホルダー、参照画像、ポーリング、出力ルールを含むドキュメントを確認してください。`,
      comfyui_summary_register_field: `登録して有効化`,
      comfyui_summary_register_value: `{server_add_command} または {personal_add_command} でエンドポイントを登録し、{image_command} または {video_command} でそのラベルを選択します。ComfyUI ワークフロー設定の詳細はドキュメントボタンから確認してください。`,
    },
    speech: {
      description: `音声生成の設定方法を確認します。`,
      engine_description: `音声エンジンのガイドを選択します。`,
      docs_title: `詳細ドキュメント`,
      docs_description: `設定手順とラッパーの注意点は、[TTSドキュメント](https://docs.tomoribot.app/ja/features/capabilities/media-generation/tts-and-stt/#text-to-speech) と [ローカルTTS設定ガイド](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/text-to-speech/) を確認してください。`,
      summary_title: `音声生成の使い方`,
      summary_description: `ローカル音声クローンでは、{custom_endpoint_add} で音声エンドポイントを登録し、{model_speech} で選択、{voice_add} でサンプル追加、{voice_assign} で割り当てます。ElevenLabs は {elevenlabs} を実行します。VoiceDesign 設定は {voice_design_set} を使います。`,
      overview: {
        title: `音声生成の概要`,
        description: `音声エンドポイントを使うと、ローカル音声クローンまたはElevenLabsでDiscordボイスメッセージを送信できます。ローカルクローンの場合、どの音声形式でも自動でモノラルWAVに変換されます。BGMなしの10〜20秒のクリップを推奨します。`,
        steps_title: `設定フロー`,
        steps_description: `ローカル: ラッパーサーバーを起動し、{custom_endpoint_add} で登録、{model_speech} で選択、{voice_add} でサンプル追加、{voice_assign} で割り当てます。

ElevenLabs: {elevenlabs} を実行し、追加ペルソナは後で {voice_assign} を使います。

**エンジン別設定ガイド:** 音声生成ページ下部の完全なTTSドキュメントをご覧ください。`,
      },
      chatterbox: {
        title: `Chatterbox-Turbo 音声`,
        description: `Chatterbox-Turbo は高速・軽量な英語専用の音声クローンサーバーです。\`[excited]\`・\`[whisper]\` のような角括弧デリバリータグで発話スタイルを制御できます。TomoriBotがこれらのタグをそのまま送信できるように、登録時は **Script Markup（スクリプトマークアップ）** を **Bracket Tags（角括弧タグ）** に設定してください。`,
        steps_title: `設定手順`,
        steps_description: `**前提条件**: Python 3.10+、CUDA 12.x + ドライバー（任意、GPU 用）

1. [ローカルTTS設定ガイド](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/text-to-speech/chatterbox/) に従ってサーバーを準備します。
2. ダウンロードした \`chatterbox\` フォルダに移動し、Python \`.venv\` を作成して有効化します。
3. numpy を先にインストールします: \`pip install numpy\`、その後 \`requirements.txt\` をインストールします。
4. *(GPU のみ)* PyTorch を再インストールします: \`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
5. \`server.py\` を起動します。
6. {custom_endpoint_add} で登録します。Capability（機能）は \`Speech\`、API Style（API スタイル）は \`TTS-Clone\`、Script Markup（スクリプトマークアップ）は \`Bracket Tags\` を選択します。
7. {model_speech} で選択し、{voice_add} と {voice_assign} を実行します。`,
      },
      qwen3tts: {
        title: `Qwen3-TTS 音声`,
        description: `Qwen3-TTS 12Hz Base は中国語・英語・日本語・韓国語・ドイツ語・フランス語・ロシア語・ポルトガル語・スペイン語・イタリア語の 10 言語に対応した多言語音声クローンサーバーです。同じ Qwen3-TTS サーバーで、自然言語の声質説明を使う VoiceDesign モデルを起動したり、1つのエンドポイントURLでクローンと VoiceDesign のリクエストを自動判定したりできます。どのモードも感情マークアップなしのプレーンテキストのみ受け付けます。登録時は **Script Markup（スクリプトマークアップ）** を **Plain（通常テキスト）** に設定してください。`,
        steps_title: `設定手順`,
        steps_description: `**前提条件**
• Python 3.10+
• SoX をシステムにインストール（Windows: \`scoop install sox\`、macOS: \`brew install sox\`）
• CUDA 12.x + ドライバー（任意、GPU 用）

1. [ローカルTTS設定ガイド](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/text-to-speech/qwen3tts/) に従ってサーバーを準備します。
2. ダウンロードした \`qwen3tts\` フォルダに移動し、Python \`.venv\` を作成して有効化します。
3. \`requirements.txt\` をインストールします。
4. *(GPU)* PyTorch を再インストール: \`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
5. *(任意)* 高速化のため flash-attn をインストール：手順 4 の後 \`pip install wheel\`、次に \`pip install flash-attn --no-build-isolation\` (Winは20-40分)。初回はスキップ。
6. 音声クローンには \`server.py\`、Qwen3-TTS VoiceDesign のみには \`server.py --mode voice-design\`、1つのURLでリクエストごとにクローン/VoiceDesignを判定するには \`server.py --mode auto\` を起動します。
7. {custom_endpoint_add} で登録: Capability（機能）は \`Speech\`、API Style（API スタイル）は \`TTS-Clone\`、Script Markup（スクリプトマークアップ）は \`Plain\` を選択。VoiceDesign では音声ソースモードに \`VoiceDesign\` を選ぶと、TomoriBot が自動的に instruct 対応として扱います。auto モードでは、同じサーバーURLを指すクローン用と VoiceDesign 用のエンドポイントを登録できます。
8. {model_speech} で選択します。クローンモードでは {voice_add} と {voice_assign}、VoiceDesign では各ペルソナに {voice_design_set} を実行します。`,
      },
      irodoritts: {
        title: `IrodoriTTS 音声`,
        description: `IrodoriTTS は日本語特化の音声クローンサーバーです。テキスト中に埋め込んだ絵文字（例: 😊 = 喜び、😢 = 悲しみ）を感情キューとして読み取ります。登録時は **Script Markup（スクリプトマークアップ）** を **Emoji Markers（絵文字マーカー）** に設定してください。TomoriBot が角括弧タグを除去し、モデルが期待する絵文字マーカーだけを残します。`,
        steps_title: `設定手順`,
        steps_description: `**前提条件**: Python 3.10+、CUDA 12.x + ドライバー（任意、GPU 用）

1. [ローカルTTS設定ガイド](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/text-to-speech/irodoritts/) に従ってサーバーを準備します。
2. ダウンロードした \`irodoritts\` フォルダに移動し、Python \`.venv\` を作成して有効化します。
3. \`requirements.txt\` をインストールします。
4. パッチスクリプトで irodori-tts をインストール（上流のバグ対処）:
Windows: \`install-irodori.ps1\`
Linux/macOS: \`bash install-irodori.sh\`
5. *(GPU)* PyTorch を再インストール: \`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
6. \`server.py\` を起動します。
7. {custom_endpoint_add} で登録: Capability（機能）は \`Speech\`、API Style（API スタイル）は \`TTS-Clone\`、Script Markup（スクリプトマークアップ）は \`Emoji Markers\` を選択。
8. {model_speech} で選択し、{voice_add} と {voice_assign} を実行します。`,
      },
      elevenlabs: {
        title: `ElevenLabs 音声`,
        description: `ElevenLabs も同じ音声エンドポイント機構を使いますが、ショートカットコマンドで設定できます。`,
        steps_title: `設定手順`,
        steps_description: `{elevenlabs} に ElevenLabs APIキーを指定して実行します。音声生成と文字起こしエンドポイントを登録・選択します。その後 {voice_assign} で各ペルソナに声を割り当てます。`,
      },
    },
    transcription: {
      description: `音声文字起こしの設定方法を確認します。`,
      engine_description: `文字起こしエンジンのガイドを選択します。`,
      docs_title: `詳細ドキュメント`,
      docs_description: `文字起こしについては [STTドキュメント](https://docs.tomoribot.app/ja/features/capabilities/media-generation/tts-and-stt/#speech-to-text) と [ローカルSTT設定ガイド](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/speech-to-text/) を確認してください。`,
      summary_title: `文字起こしの使い方`,
      summary_description: `{custom_endpoint_add} で文字起こしエンドポイントを登録し、{model_transcription} で選択します。字幕をチャットに表示したい場合だけ {speech_transcripts} を使います。ElevenLabs ユーザーは {elevenlabs} を実行できます。`,
      overview: {
        title: `文字起こしの概要`,
        description: `文字起こしエンドポイントは、音声添付を内部会話コンテキスト用のテキストに変換します。見える形で投稿する字幕は {speech_transcripts} で別途制御します。`,
        steps_title: `推奨経路`,
        steps_description: `まず WhisperX を推奨します。ローカルSTT設定ガイドに従い、{custom_endpoint_add} で登録してから {model_transcription} で選択します。ElevenLabs ユーザーは {elevenlabs} を実行します。

**エンジン別設定ガイド:** 文字起こしページ下部の完全なSTTドキュメントをご覧ください。`,
      },
      whisperx: {
        title: `WhisperX 文字起こし`,
        description: `WhisperX は推奨ローカルSTT経路です。FFmpeg のシステムインストールが必要で、CUDA による GPU 高速化にも対応しています。`,
        steps_title: `設定手順`,
        steps_description: `**前提条件**
• Python 3.10+
• FFmpeg をシステムにインストール（必須）
• CUDA 12.x + ドライバー（任意、GPU 高速化用）

1. [ローカルSTT設定ガイド](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/speech-to-text/whisperx/) に従ってサーバーを準備します。
2. ダウンロードした \`stt\` フォルダに移動し、Python \`.venv\` を作成して有効化します。
3. \`requirements-whisperx.txt\` をインストールします。
4. *(GPU)* CUDA 対応 PyTorch を再インストール:
\`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124\`
5. \`whisperx_server.py\` を起動します。
6. {custom_endpoint_add} で登録: Capability（機能）は \`Transcription\`、API Style（API スタイル）は \`OpenAI Compatible\` を選び、選択したサイズのモデル名を指定します。
7. {model_transcription} で選択します。`,
        models_title: `利用可能なモデル`,
        models_description: `サーバー起動前に \`WHISPERX_MODEL\` を指定し、登録時も同じ名前を使います。
GPU は **float16** · CPU は **int8**（バイト数が半分なので CPU RAM < GPU VRAM）

\`tiny\`：VRAM 約0.5 GB / RAM 約200 MB
\`base\`：VRAM 約0.5 GB / RAM 約300 MB
\`small\`：VRAM 約1 GB / RAM 約600 MB
\`medium\`：VRAM 約2 GB / RAM 約1.5 GB
\`large-v3\`：VRAM 約4-5 GB / RAM 約2.5 GB *(デフォルト、最高精度)*
\`large-v3-turbo\`：VRAM 約2-3 GB / RAM 約1.5 GB *(VRAM が少ない場合に推奨)*

文字起こしは約100言語に対応（自動検出）。`,
      },
      koboldcpp: {
        title: `KoboldCPP 文字起こし`,
        description: `KoboldCPP のSTT対応は、利用しているビルドが公開するHTTPエンドポイント形状に依存します。`,
        steps_title: `設定メモ`,
        steps_description: `OpenAI互換の \`/v1/audio/transcriptions\` を公開している場合は {custom_endpoint_add} で登録できます。異なるエンドポイントだけの場合は、専用アダプターが入るまでラッパーを使ってください。`,
      },
      elevenlabs: {
        title: `ElevenLabs 文字起こし`,
        description: `ElevenLabs の文字起こしは音声ショートカットで自動登録されます。`,
        steps_title: `設定手順`,
        steps_description: `{elevenlabs} を実行します。音声生成と文字起こしの両方を登録・選択します。チャットに見える字幕を投稿したい場合だけ {speech_transcripts} を使います。`,
      },
    },
    "custom-endpoint": {
      description: `カスタムエンドポイントの使い方を確認します。`,
    },
    features: {
      description: `TomoriBotができることを表示`,
      title: `TomoriBotの機能（バージョン {version}）`,
      embed_description: `これが私の全機能です：`,
      summary_chat_title: `会話とペルソナ`,
      summary_chat_description: `TomoriBot はトリガーワード、メンション、返信、アルターペルソナ、Webhook ID、設定可能なペルソナ動作で応答できます。`,
      summary_knowledge_title: `知識とメモリー`,
      summary_knowledge_description: `個人メモリー、サーバーメモリー、ドキュメント知識、短期記憶、プライバシー制御により、TomoriBot が使える文脈をサーバーごとに決められます。`,
      summary_capabilities_title: `ツールとメディア`,
      summary_capabilities_description: `Web/検索、予定タスク、メディア解析、画像/動画生成、音声メッセージ、文字起こし、MCP、カスタムエンドポイント連携などのツールを使えます。`,
      summary_reference_title: `管理とリファレンス`,
      summary_reference_description: `プロバイダー設定、モデル選択、サーバー管理、年齢制限コマンド、統計、Matrix連携、自動生成コマンド一覧はドキュメントにまとまっています。`,
      vision_title: `ビジョン＆メディア`,
      vision_description: `- 画像、動画、スタンプ、絵文字を見て分析できます
- YouTubeリンクから動画を視聴できます
- 共有された埋め込み（ツイート、記事など）の内容を見ることができます`,
      search_title: `検索＆情報 `,
      search_description: `- 最新情報をウェブ検索できます
- 画像、動画、ニュース検索も可能です（\`/optional-key brave set\`経由）
- URLからコンテンツを取得して読むことができます`,
      personality_title: `パーソナリティ＆カスタマイズ`,
      personality_description: `- \`/config rename\`と\`/persona avatar\`で名前とアバターを変更できます
- \`/persona\`で異なるペルソナに切り替えられます（\`/persona export\`でペルソナを共有・保存もできます！）
- アルターペルソナとして複数のキャラクターが同一サーバーで共存し、それぞれ独自のトリガーとウェブフックアバターを持てます
- \`/persona attribute add\`、\`/persona sample-dialogue add\`、\`/persona prompt set\`で行動やトーンを調整できます
- \`/config system-prompt\`でカスタムシステムプロンプトを設定し、行動をさらに形張ることができます
- 詳しくは\`/help\`内の **カスタマイズ** ページをご覧ください`,
      memory_title: `記憶＆パーソナライゼーション`,
      memory_description: `- ユーザーやサーバーに関する事実を記憶し、会話を跨いで保持します
- 個人的な記憶は全サーバーで保持されます（他のサーバーでも私に話しかけてみて！）
- 最近の会話は[STM（短期記憶）](https://docs.tomoribot.app/ja/features/knowledge/memory/#short-term-memory-stm)として保持し、チャンネルやサーバーをまたいで文脈を把握します（クロスサーバー共有は\`/personal stm\`でオプトインできます）
- \`/personal profile nickname\`であなたを呼ぶ名前を変更できます
- \`/memory\` と \`/persona\` コマンドで手動で記憶やペルソナ情報を追加・削除できます
- \`/server expressions initialize\`で絵文字やステッカーを登録すると、より適切な場面で使えるようになります
- \`/personal privacy\`で完全に見えなくなるオプションが利用可能です
- 詳しくは\`/help\`内の **永続メモリ** ページをご覧ください`,
      time_title: `時間認識`,
      time_description: `- サーバーの現在時刻を認識しています（\`/server timezone\`経由）
- リマインダーを設定できます（何かを思い出させるように頼んでみて！）
- 繰り返しリマインダーもサポートされており、ペルソナ固有です`,
      alter_title: `アルターペルソナ`,
      alter_description: `- アルターペルソナを使って、一つのサーバーに複数のキャラクターが共存できます
- それぞれのアルターは独自のパーソナリティを持ち、特定のキーワードでトリガーされます
- アルターペルソナは異なるアバターのためにウェブフックを使用します
- 一つのメッセージで複数のアルターを同時にマッチできます（\`/config trigger-match-limit\`の上限まで）
- ウェブフックメッセージに返信すると、そのペルソナとして会話が続きます
- \`/persona import\`（アルターオプション）と\`/persona remove\`でアルターを管理できます`,
      expressions_title: `表情＆リアクション`,
      expressions_description: `- サーバーのカスタム絵文字を会話で自然に使えます（大文字小文字不問の \`:名前:\` 形式）
- 返信の一部としてスタンプを送れます
- 関連する絵文字でメッセージにリアクションできます
- \`/server expressions initialize\`で絵文字とスタンプを登録すると精度が向上します`,
      documents_title: `ドキュメント知識庫`,
      documents_description: `- \`/memory document add\`でテキスト、PDF、Markdownファイルをサーバー知識としてアップロードできます
- \`/memory history import\`でチャンネル履歴を検索可能な知識として抽出できます
- 質問に答える際に、私は関連するドキュメント内容を取得して参照します
- チャットで共有されたファイル添付（PDF、ソースコード、Markdown、JSON、YAMLなど）も直接読み取れます、読んでと頼むだけ！
- 埋め込みモデルが必要です（\`/model embedding\`で設定）
- \`/memory document remove\`と\`/memory history remove\`で保存済みドキュメントを削除できます`,
      impersonation_title: `なりきり＆ツール`,
      impersonation_description: `- \`/bot impersonate\`で自分自身、ペルソナ、またはシステムメッセージとしてメッセージを送信できます
- \`/personal impersonate prompt\`でユーザーなりきり用の再利用プロンプトを設定できます
- \`/tools compact\`で会話履歴を要約したりロールプレイで圧縮できます
- \`/bot respond\`でボットから定型文や案内付きメッセージを送信できます`,
      imagegen_title: `画像生成`,
      imagegen_description: `- テキストプロンプトから画像を生成し、参照画像を編集することもできます
- Text2ImageとImage2Imageをカスタマイズタブルなアスペクト比で対応
- \`/generate image\`を使うか、画像を生成してほしいと頼むだけで動作します
- 参照画像としてメッセージの添付ファイル、ステッカー、絵文字、ユーザーアバターを使えます
 - Google、Vertex AI、Vertex AI Express、OpenRouter、Z.ai、NVIDIA NIMプロバイダーで利用可能（\`/model image\`で設定）`,
      videogen_title: `動画生成`,
      videogen_description: `- テキストプロンプトから短い動画を生成し、参照画像をアニメーション化することもできます
- Text2VideoとImage2Videoをカスタマイズ可能なアスペクト比で対応
- \`/generate video\`を使うか、動画を生成してほしいと頼むだけで動作します
- 参照画像としてメッセージの添付ファイルやユーザーアバターを使えます
- Google、OpenRouter、Z.aiプロバイダーで利用可能（\`/model video\`で設定）`,
      footer: `すべての機能がすべてのAIプロバイダーで利用できるわけではありません。推奨：Google Gemini。私に直接何ができるか聞いてみることもできます！`,
    },
    setup: {
      description: `TomoriBotの初期設定方法を学ぶ`,
      title: `TomoriBotを始める`,
      embed_description: `サーバー（またはDM）でTomoriBotを設定する方法：`,
      step1_title: `ステップ1：APIキーを取得`,
      step1_description: `TomoriBotは複数のAIプロバイダーに対応しています。TomoriBotが動作を始めるには、いずれかのAPIキーが必要です。APIキーとは、選択したプロバイダーのAIモデルをTomoriBotが利用するための秘密のパスキーです。

初めて設定する場合は、無料枠が充実したGoogle Geminiがおすすめですが、TomoriBotに似たシステムの利用経験がある場合は、使い慣れたプロバイダーを選んでも構いません。下からプロバイダーを選択して、APIキーの取得方法を確認してください。`,
      provider_picker_footer: `APIキーを安全にコピーしたら、次のステップへ進んでください。**APIキーは誰とも共有しないでください。**`,
      step2_title: `ステップ2：セットアップコマンドを実行`,
      step2_description: `- {configSetup}を使用してAPIキーを安全に追加し、TomoriBotを初期化
- （推奨）{serverInitializeExpressions}を実行して、サーバーの絵文字/スタンプ表現を適切に使えるようにする
	- APIキーは暗号化されて安全に保存されます
	- 各サーバーには独自の設定があります`,
      step3_title: `ステップ3：チャットを開始`,
      step3_description: `- メンションするか、私のメッセージに返信するだけでチャットできます
- {serverTrigger}でトリガー方法を変更できます
- 記憶システムで会話を記憶します（{configPermissions}で無効化できます！）
- {serverAutotrigger}で自動トリガーを設定し、メンションなしでチャットできます`,
      step4_title: `ステップ4：TomoriBotをカスタマイズ（任意）`,
      step4_description: `- {persona}コマンドで私のパーソナリティを完全に変更（アルターペルソナも含む！）
- {server}、{personal}、{memory}、{config}コマンドで設定を調整
- {memory}で記憶やドキュメント、{persona}で振る舞いを調整できます
- ドキュメントアップロード、APIキーローテーション、検閲なしモードなどの高度な機能も探してみてください`,
      need_help_title: `ヘルプが必要ですか？`,
      need_help_description: `- {helpFeatures} - 私ができることを見る
- {helpMemory} - 記憶システムについて学ぶ
- {helpCustomization} - パーソナリティのカスタマイズについて学ぶ
- {supportServer} - 公式TomoriBotサポートサーバーに参加{legalNotice}`,
    },
    matrix: {
      description: `Matrixブリッジの設定方法と使い方を学ぶ`,
      title: `Matrixブリッジガイド`,
      embed_description: `MatrixルームをDiscordチャンネルにリンクする方法と、現在Matrix側で使える機能の案内です。`,
      bot_user_fallback: `設定されているMatrixボットアカウント`,
      setup_title: `セットアップ`,
      setup_description: `1. 暗号化されていないMatrixルームに {botUserId} を招待します。
2. そのルームの Internal Room ID を確認します。
3. ブリッジしたいDiscordチャンネルで {serverMatrixLink} を実行し、そのルームIDを貼り付けます。`,
      room_id_title: `ルームIDの確認方法`,
      room_id_description: `多くのMatrixクライアントでは Room Settings -> Advanced -> Internal Room ID から確認できます。
IDの形式は \`!abc:matrix.org\` のようになります。

ボットが招待を受け入れると、Matrixルームにも短い案内を送りますが、リンク完了には引き続きDiscord側で {serverMatrixLink} を実行する必要があります。`,
      usage_title: `Matrixからの使い方`,
      usage_description: `- ルームをリンクした後は、Matrixで普通に話しかければ使えます
- Matrixのメッセージはリンク先のDiscordチャンネルにWebhookとして転送されます
- TomoriBotの返信はMatrixルームにも戻ってきます
- Matrix側で使えるテキストコマンドは /kill と /refresh のみです`,
      limitations_title: `現在の制限`,
      limitations_description: `- MatrixからSlash Commandは使えません
- DM / DM経由のクールダウン通知は使えません
- Matrixユーザーのプロフィール画像はTomoriBotから見えません
- メッセージのピン留めはできません
- カスタム絵文字やMarkdownは安定して描画されません
- Embedはプレーンテキストとして転送されます
- Matrixユーザーの個人メモリは属性付きのサーバーメモリにフォールバックします`,
      troubleshooting_title: `注意事項`,
      troubleshooting_description: `- ボットが自動参加しない場合は {botUserId} を手動で招待し、必要なら {serverMatrixLink} を再実行してください
- Matrixの暗号化は後から無効化できないため、暗号化済みルームは使えず、新しい非暗号化ルームが必要です
- 上に書かれていない制限は基本的に動作する想定なので、動かない場合は {supportServer} で報告してください`,
    },
    data: {
      description: `データ管理とプライバシーについて学ぶ`,
      title: `データの管理`,
      embed_description: `データの管理方法と保存内容：`,
      export_title: `データのエクスポート`,
      export_description: `{memoryPersonalExport}、{memoryServerExport}、{personalConfigExport}、{serverConfigExport}を使ってデータをダウンロード：
- **ペルソナの個人メモリ / グローバル個人メモリ**
- **ペルソナのサーバーメモリ**
- **個人設定**
- **サーバー設定**
- **ペルソナ本体** は {personaExport} で別途エクスポート
- データはJSONファイルとしてDMに送信されます`,
      import_title: `データのインポート`,
      import_description: `{memoryPersonalImport}、{memoryServerImport}、{personalConfigImport}、{serverConfigImport}を使ってエクスポートしたデータを復元：
- エクスポートファイルの種類を自動判別します
- メモリ系ファイルは「ペルソナ」または「グローバル」適用先を選択します
- サーバー系インポートにはサーバー管理権限が必要です
- コマンド使用時にエクスポートしたファイルを添付するだけ`,
      delete_title: `データの削除`,
      delete_description: `{memoryPersonalRemove}、{memoryServerRemove}、{personalConfigRemove}、{serverConfigRemove}を使用してデータを完全に削除またはリセット：
- **ペルソナの個人メモリ** / **グローバル個人メモリ**
- **ペルソナのサーバーメモリ**
- **個人設定** / **サーバー設定のリセット**
- この操作は元に戻せません！`,
      privacy_title: `プライバシー通知`,
      privacy_description: `**保存するもの：**
- サーバー/個人の記憶
- 私の設定とペルソナ
- 私のサーバー設定
- 暗号化されたAPIキー

**保存しないもの：**
- Discordメッセージ
- チャット履歴

**選択したAIプロバイダーに送信されるもの：**
トリガーされるたびに、AIモデルが返信を形成するためのコンテキストとして、テキストチャンネルの**最新メッセージ**と**関連する記憶**を取得します。これらのトリガー以外でメッセージを積極的に監視したり閲覧したりすることはありません。

{personalPrivacy}コマンドで記憶機能をオプトアウトし、{configPermissions}コマンドで自己学習を無効化できます。`,
      footer: `選択したAIプロバイダー（Google、NovelAI、OpenRouter）は独自のプライバシーポリシーに従ってメッセージを処理します。プライバシーのため、個人情報を共有しないでください。{legalNotice}`,
    },
    "st-preset": {
      description: `この環境でのSillyTavernプリセットの挙動を学ぶ`,
      embed1_title: `この環境でのSillyTavernプリセット`,
      embed1_description: `{stPresetImport}でPrompt Managerプリセットを読み込み、{stPresetToggle}で有効ノードを確認し、{stPresetRemove}で通常レイアウトに戻せます。`,
      embed1_controls_title: `プリセットが制御するもの`,
      embed1_controls_description: `- プロンプト順序とマーカー配置
- カスタムプロンプトノード
- post-history / depth injection ノード
- インポート時に有効・無効で始まるノード`,
      embed1_still_sent_title: `それでも完全には置き換えないもの`,
      embed1_still_sent_description: `- 現在の system/persona 系ブロックは残ります: {configSystemPromptSet}、{personaPromptSet}、{personaAttributeAdd}、{personaSampleDialogueAdd}
- ライブ会話履歴と取得済み文書コンテキストも残ります
- Tomori専用の自動コンテキストも残ります: サーバーメモリ、絵文字/ステッカー文脈、会話参加者一覧、STM、conditioning など`,
      embed1_mapping_title: `ネイティブブロックの対応関係`,
      embed1_mapping_description: `- \`main\` は通常、現在の system prompt バケットを置きます: 設定済みなら {configSystemPromptSet}、なければ組み込みのフォールバック
- \`charDescription\` は通常 {personaPromptSet} を置きます
- \`charPersonality\` は通常 {personaAttributeAdd} を置きます
- \`dialogueExamples\` は通常 {personaSampleDialogueAdd} を置きます
- \`chatHistory\` は通常ライブ会話履歴を置きます
- \`worldInfoBefore\` / \`worldInfoAfter\` は通常、ST lorebook ではなく取得済み文書コンテキストを置きます`,
      embed1_system_prompt_title: `システムプロンプトのルール`,
      embed1_system_prompt_description: `- プリセットが有効な間は、組み込みのフォールバック用システムプロンプトは外れます
- {configSystemPromptSet} で自分のシステムプロンプトを設定していれば、それは送信されます
- STの感覚では、プリセットが制御するのはレイアウトであって、すべてのプロンプト供給元ではありません`,
      embed1_footer: `プリセット読み込み後も /help のSillyTavernプリセットページからいつでも確認できます`,
      embed2_title: `よくある意外な挙動`,
      embed2_description: `「無視された」「位置がおかしい」と感じやすい主な理由です。

- インポートされたからといって必ず送信されるとは限りません。 \`prompt_order\` で無効なノードは {stPresetToggle} で有効にするまで送られません
- コメント専用ノードや \`{{trim}}\` の結果が空になるノードは送信されません
- 有効なノードに未対応マクロが残っている場合、インポート結果で警告が出ます。そのタグはそのまま送信されたり、ここでは別の挙動になることがあります
- 未対応のマーカーはスキップされます
- 順序は文字どおりです。 \`chatHistory\` を \`dialogueExamples\` より前に置くと、ライブ会話が先に来ます
- 基本は \`character_id: 100001\` の \`prompt_order\` を使い、\`100001\` がない場合だけ \`100000\` にフォールバックします
- サンプル会話が最後になると、厳格なプロバイダーが例文を続けないよう短い区切り文が追加されます`,
      embed2_footer: `何か足りないように見えるときは、{stPresetToggle} のノード一覧と元JSONを見比べてください`,
      embed3_title: `制限と互換性`,
      embed3_description: `- post-history / depth injection は独立したメッセージとして挿入されず、既存の会話履歴項目にマージされます
- 同じ深さのノードはまとめて1つに束ねられます
- \`{{setvar}}\` と \`{{addvar}}\` は有効ノードの順番どおりに動きますが、変数はプリセット全体で共有されます
- 多くの native ブロックは削除ではなく移動です: \`main\`、\`charDescription\`、\`charPersonality\`、\`dialogueExamples\`、\`chatHistory\`、\`worldInfo\` マーカーは、Tomori 側の system prompt、persona prompt、性格属性、サンプル会話、ライブ履歴、取得済み文書を再配置します
- 実際に抑制されるのは限られています: {configSystemPromptSet} を設定していない場合だけ組み込みフォールバック system prompt が外れ、native の \`charDescription\` / \`charPersonality\` はカスタムノードが \`{{description}}\` / \`{{personality}}\` を展開したときだけスキップされます
- Tomori専用の自動ブロックは ST マーカーの所有物ではありません: サーバー情報・記憶・絵文字/ステッカー文脈は \`main\` / \`charDescription\` / \`charPersonality\` の後で flush され、会話参加者一覧・STM・conditioning・余った RAG は \`dialogueExamples\` / \`chatHistory\` の前で flush されます
- {botImpersonate} によるユーザーなりきりではプリセットが無視され、通常レイアウトが使われます
- \`context.story_string\` + \`sysprompt.content\` を使う古い text-completions プリセットは、ベストエフォートの変換経路でインポートされます
- その legacy 変換ではメインのシステムプロンプト、story layout、post-history は取り込みますが、\`persona\`、\`scenario\`、アンカー、stop strings、古いバックエンド設定などの ST 専用要素は引き続き無視されます
- modern Prompt Manager プリセット上にある追加の legacy \`post_history\` フィールドも一部取り込みます
- regex後処理、プリセット側の temperature/top_p/モデル上書き、多段プリセットは未対応です
- \`worldInfo\` マーカーは ST lorebook ではなく、取得された文書コンテキストを使います
- プリセットに明示的なSTマーカーを置かなくても、一部の自動サーバー/文脈ブロックは挿入されることがあります
- プロバイダー差も残ります。assistant prefill は効くプロバイダーもあれば無視するものもあります`,
      embed3_footer: `{stPresetRemove} でプリセットモードをすぐ無効化できます`,
    },
    "api-key": {
      description: `AIプロバイダーのAPIキー設定方法を学ぶ`,
      provider_description: `AIプロバイダーを選択`,
      provider_choice_brave: `Brave Search`,
      provider_choice_google: `Google Gemini（おすすめ）`,
      provider_choice_deepseek: `DeepSeek`,
      provider_choice_custom: `カスタムエンドポイント`,
      provider_choice_nvidia: `NVIDIA NIM`,
      provider_choice_novelai: `NovelAI`,
      provider_choice_openrouter: `OpenRouter（おすすめ）`,
      provider_description_google: `汎用性が高く、無料利用枠も充実`,
      provider_description_openrouter: `有料ながら安定性と柔軟性が高く、画像・動画・音声も生成可能`,
      provider_description_deepseek: `比較的検閲が少ない、より安価な有料の選択肢`,
      provider_description_novelai: `無検閲のロールプレイ、物語、画像生成向け`,
      provider_description_nvidia: `ホスト型のテキスト、埋め込み、画像モデル`,
      provider_description_zai: `GLMのテキスト・画像モデル。コーディング用途の規約制限あり`,
      provider_description_vertexexpress: `APIキー認証でGoogle CloudのGeminiを利用`,
      provider_description_vertex: `Google Cloud認証情報で企業向けGeminiを利用`,
      provider_description_custom: `セルフホストやプロキシ用。認証は任意の場合あり`,
      provider_description_brave: `任意のウェブ、画像、動画、ニュース検索`,
      provider_description_elevenlabs: `音声生成・文字起こし用。テキストモデルではありません`,
      brave_title: `Brave Search APIキーの設定`,
      brave_description: `Brave Searchはオプションで、検索機能を強化するだけです。これは私のAIを動かすものではありません（それはメインプロバイダーが担当します）。
- 画像、動画、ニュース検索を有効化
- インターネットからリアルタイム情報を提供
- 最新の質問に答える能力を強化`,
      brave_getting_key_title: `APIキーの取得：`,
      brave_getting_key_description: `1. [Brave Search API](https://brave.com/search/api/)にアクセス
2. 無料アカウントに登録
3. ダッシュボードの[APIキー](https://api-dashboard.search.brave.com/app/keys)セクションに移動
4. 新しいAPIキーを作成
5. {configBraveapiSet}コマンドでAPIキーをコピーして入力`,
      brave_important_title: `重要な注意事項：`,
      brave_important_description: `- これはメインAIプロバイダーとは別です
- Brave APIキーがなくても、組み込みウェブ検索で機能します
- Braveでは毎月5ドル分の無料クレジットが含まれますが、それを超えると課金される場合があります。無料枠だけ使いたい場合は、[Braveの使用量上限ダッシュボード](https://api-dashboard.search.brave.com/app/subscriptions/usage-limits)で使用量上限を5ドルに設定してください`,
      brave_footer: `メインAIプロバイダーについては、\`/help\`のAPIキーページで別のプロバイダーを選んでください`,
      google_title: `Google Gemini APIキーの設定`,
      google_description: `Google Geminiは強力なAIモデルを備えた無料および有料プランを提供します。
- 無料プランで十分な制限あり
- ビジョンやペルソナ生成などTomoriBotの全機能をサポート
- [Geminiプライバシーポリシー](https://ai.google.dev/gemini-api/terms)`,
      google_getting_key_title: `APIキーの取得：`,
      google_getting_key_description: `1. [Google AI Studio](https://aistudio.google.com/apikey)にアクセス
2. 右上の\`APIキーを作成\`をクリック（必要に応じて新しいプロジェクトを作成）
3. このAPIキーを{configSetup}または{configApikeySet}にコピー`,
      google_footer: `このプロバイダーを設定したら、{configModel}でデフォルトモデルを変更できます`,
      deepseek_title: `DeepSeek APIキーの設定`,
      deepseek_description: `DeepSeekは従量課金制のテキストプロバイダーです。
- [DeepSeek APIドキュメント](https://api-docs.deepseek.com/)`,
      deepseek_getting_key_title: `APIキーの取得：`,
      deepseek_getting_key_description: `1. [DeepSeek API Keys](https://platform.deepseek.com/api_keys)にアクセス
2. DeepSeekのプラットフォームアカウントにログイン、または新規作成
3. 新しいAPIキーを作成
4. 必要に応じて、使用前にDeepSeekプラットフォームアカウントへ残高を追加
5. このAPIキーを{configSetup}または{configApikeySet}にコピー`,
      deepseek_footer: `このプロバイダーを設定したら、{configModel}でデフォルトモデルを変更できます`,
      custom_title: `カスタムエンドポイントのセットアップ`,
      custom_description: `旧来のインラインなカスタムプロバイダーフローは移動しました。

サーバー単位のエンドポイントは、{configSetup} で **カスタムエンドポイント（セットアップ後に完了）** を選び、その後 {configCustomModelsAdd} を実行してから {configModel} で有効化してください。

個人用エンドポイントは {personalCustomModelsAdd} を使用してください。

対応エンドポイント種類や手順の詳細は {helpCustomModels} を参照してください。`,
      nvidia_title: `NVIDIA NIM APIキーの設定`,
      nvidia_description: `NVIDIA NIMは、NVIDIA Build経由でホスト型のテキスト・埋め込み・画像APIを提供します。`,
      nvidia_getting_key_title: `APIキーの取得：`,
      nvidia_getting_key_description: `1. [NVIDIA Build](https://build.nvidia.com/)にアクセス
2. NVIDIA開発者アカウントでログイン、または新規作成
3. [API Keysページ](https://build.nvidia.com/settings/api-keys)でAPIキーを作成または管理
4. このAPIキーを{configSetup}または{configApikeySet}にコピー`,
      nvidia_important_title: `重要な注意事項：`,
      nvidia_important_description: `- テキストと埋め込みはNVIDIAのホスト型 \`integrate.api.nvidia.com\` を使用します
- ネイティブ画像生成はNVIDIAホストの \`ai.api.nvidia.com\` FLUXエンドポイントを使用します`,
      nvidia_footer: `このプロバイダーを設定したら、{configModel}、{configModelEmbedding}、{configModelImage}でテキスト・埋め込み・画像モデルを変更できます`,
      provider_choice_zai: `Z.ai`,
      provider_choice_vertex: `Google Vertex AI`,
      provider_choice_vertexexpress: `Google Vertex AI Express`,
      provider_choice_elevenlabs: `ElevenLabs TTS`,
      zai_title: `Z.ai APIキーの設定`,
      zai_description: `Z.aiは、汎用APIと別個のCodingエンドポイントを通じてGLMファミリーへアクセスできます。

⚠️ **利用規約の更新：** Z.aiの利用規約が更新され、コーディング/エージェントのユースケースのみが許可されるようになりました。汎用エンドポイントをコーディング以外のチャットに使用する場合、自己責任となり規約に違反する可能性があります。`,
      zai_getting_key_title: `APIキーの取得：`,
      zai_getting_key_description: `1. [Z.aiプラットフォーム](https://z.ai)にアクセス
2. ログインまたはアカウントを作成
3. ダッシュボードでAPIキーに移動
4. 新しいAPIキーを作成
5. このAPIキーを{configSetup}または{configApikeySet}にコピー`,
      zai_important_title: `重要な注意事項：`,
      zai_important_description: `- 通常のチャット、推論、画像生成には汎用エンドポイントを使ってください
- 専用のCodingエンドポイントは別扱いで、コーディング特化ワークフロー向けです
- ⚠️ Z.aiの利用規約がコーディング/エージェントのシナリオのみに制限されました。一般チャットでの使用は自己責任です`,
      zai_footer: `このプロバイダーを設定したら、{configModel}でデフォルトモデルを変更できます`,
      novelai_title: `NovelAI APIキーの設定`,
      novelai_description: `NovelAIはクリエイティブなストーリーテリングとロールプレイに焦点を当てたサブスクリプションベースのサービスです。
- 無制限の無検閲メッセージ
- 無検閲のテキスト生成と、別途設定するNovelAI画像生成に対応
- NovelAIのテキストモデルは画像入力に未対応
- [NovelAI利用規約](https://novelai.net/terms)`,
      novelai_getting_key_title: `APIキーの取得：`,
      novelai_getting_key_description: `1. [NovelAI](https://novelai.net/stories)にアクセス
2. 左上の⚙️アイコンから設定に移動
3. \`アカウント\`に移動
4. \`永続的APIトークンを取得\`を探す（購読申し込みが必要です！）
5. このAPIキーを{configSetup}または{configApikeySet}にコピー`,
      novelai_footer: `このプロバイダーを設定したら、{configModel}でデフォルトモデルを変更できます`,
      openrouter_title: `OpenRouter APIキーの設定`,
      openrouter_description: `OpenRouterは従量課金制で複数のプロバイダーの様々なAIモデルへのアクセスを提供します。
 - 最新かつ最も強力なAIモデルへのアクセス（無料もあります）
 - 現在、TomoriBotの全機能をサポートしていません
 - [OpenRouter利用規約](https://openrouter.ai/terms)`,
      openrouter_getting_key_title: `APIキーの取得：`,
      openrouter_getting_key_description: `1. [OpenRouter](https://openrouter.ai/settings/keys)にアクセス
2. \`APIキーを作成\`をクリック
3. このAPIキーを{configSetup}または{configApikeySet}にコピー`,
      openrouter_important_title: `重要な注意事項：`,
      openrouter_important_description: `- **無料モデルは厳格なレート制限があります**。通常は有料モデルの方が安定します
- モデルを選ぶ前に**必ず料金を確認**してください
- OpenRouterアカウント側の設定もそのまま適用されます
- 一覧にないモデルが必要なら{supportServer}で提案してください`,
      openrouter_footer: `このプロバイダーを設定したら、{configModel}でデフォルトモデルを変更できます`,
      vertex_title: `Google Vertex AIの設定`,
      vertex_description: `Google Vertex AIは、Google Cloudを通じてGeminiモデルへのエンタープライズグレードのアクセスを提供します。
- 認証にApplication Default Credentials（ADC）を使用、APIキーの管理が不要
- ローカルのgcloud ADC、またはホスト環境のワークロードID・サービスアカウントを使用
- [Vertex AIドキュメント](https://cloud.google.com/vertex-ai/docs)`,
      vertex_getting_key_title: `設定手順：`,
      vertex_getting_key_description: `**手順1: [Google Cloud CLI](https://cloud.google.com/cli)をインストール**

**手順2: Google Cloudプロジェクトを作成**
\`gcloud projects create PROJECT_ID --name="Vertex AI Project"\`
（\`PROJECT_ID\` を一意のIDに置き換えてください。例：\`my-vertex-project-12345\`）

**手順3: アクティブプロジェクトに設定**
\`gcloud config set project PROJECT_ID\`

**手順4: 請求先アカウントを紐付け**
\`gcloud billing accounts list\` で請求先アカウントIDを確認し、
\`gcloud billing projects link PROJECT_ID --billing-account=ACCOUNT_ID\` を実行

**手順5: Vertex AI APIを有効化**
\`gcloud services enable aiplatform.googleapis.com\`

**手順6: Application Default Credentialsを設定**
\`gcloud auth application-default login\` を実行してブラウザでログイン

**手順7: 設定を入力**
{configSetup}または{configApikeySet}で \`{project_id}::{location}\` の形式で入力
- ロケーションは \`global\` を推奨（プレビューモデル対応・最高の可用性）
- 例：\`my-vertex-project-12345::global\``,
      vertex_important_title: `重要な注意事項：`,
      vertex_important_description: `- 保存される値は**設定情報**（プロジェクト＋ロケーション）であり、認証情報ではありません
- すべてのVertexリクエストはホストのApplication Default Credentials IDを使用します
- AI StudioのAPIキーだけではこのプロバイダーを認証できません。プロジェクトで請求とVertex AI APIを有効にし、ホストIDにVertexアクセス権を付与してください。
- チャット、ツール呼び出し、ストリーミング、構造化出力、圧縮、埋め込み、プリセット生成に対応`,
      vertex_footer: `このプロバイダーを設定したら、{configModel}でデフォルトモデルを変更できます`,
      vertexexpress_title: `Google Vertex AI Expressの設定`,
      vertexexpress_description: `Google Vertex AI Expressは、Vertex AI上のGeminiへAPIキーでアクセスできるモードです。
- ホスト側のApplication Default Credentialsではなく、自分のGoogle Cloud APIキーを使用します
- デプロイ済みTomoriBotで各ユーザーが自分のキーを持つBYOK運用に向いています
- Gemini限定の小さめなモデルカタログを持つPreview機能です
- [Vertex AI Express Mode概要](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview)`,
      vertexexpress_getting_key_title: `設定手順：`,
      vertexexpress_getting_key_description: `1. [Vertex AI Express Mode](https://console.cloud.google.com/expressmode) を開く
2. 標準の Google Cloud にリダイレクトされる場合は、別プロバイダーの \`vertex\` を使ってください
3. Express コンソールで **APIs & Services > Credentials** を開き、Express の API キーをコピー
4. その生の API キーを {configSetup} または {configApikeySet} で追加
5. {configModel} で Vertex AI Express 用モデルを選択`,
      vertexexpress_important_title: `重要な注意事項：`,
      vertexexpress_important_description: `- 保存するのは \`{project_id}::{location}\` ではなく、生の API キーです
- ここではロケーション設定は不要です。\`global\` は別プロバイダーの \`vertex\` 用です
- フル Google Cloud の Vertex プロジェクトは \`vertexexpress\` ではなく \`vertex\` を使ってください
- 利用できるモデルは Vertex AI Express 対応の Gemini カタログに限定されます
- 画像生成には対応しますが、動画と埋め込みには対応しません
- Express Mode は現在 Google の Preview 機能です`,
      vertexexpress_footer: `このプロバイダーを設定したら、{configModel}でデフォルトモデルを変更できます`,
    },
    elevenlabs: {
      description: `ElevenLabs音声合成の設定方法を学ぶ`,
      title: `ElevenLabs TTSの設定`,
      getting_key_title: `APIキーの取得：`,
      getting_key_description: `1. [ElevenLabs](https://elevenlabs.io/app/settings/api-keys)にアクセス
2. アカウントにサインインまたは新規登録
3. 新しいAPIキーを作成
4. {configSpeechElevenlabs}を使用してAPIキーを入力`,
      choosing_voice_title: `ボイスの選択：`,
      choosing_voice_description: `APIキーを設定したら、使用するボイスを選択できます。
 - {configSpeechVoiceAssign}を使って利用可能なボイスを参照・選択
 - [Voice Library](https://elevenlabs.io/app/voice-library) からボイスを追加でき、自分の声のクローンも作成できます`,
      free_voices_title: `プリメイド音声（無料プラン対応）：`,
      free_voices_description: `プリメイド音声は無料プランでも利用できます。一覧は [ElevenLabs Premade Voices](https://elevenlabs-sdk.mintlify.app/voices/premade-voices) で確認し、{configSpeechElevenlabs} または {configSpeechVoiceAssign} で各ペルソナに割り当てましょう。`,
      important_notes_title: `重要な注意点：`,
      important_notes_description: `- 音声メッセージを生成・読み上げると文字数が消費されます
- 無料ティアには月間制限があります。使用量はElevenLabsダッシュボードで確認してください
- 表示用字幕投稿は {configSpeechTranscripts} で別途制御します`,
      footer: `ElevenLabsキーを更新するには {configSpeechElevenlabs} を再実行してください。`,
    },
    memory: {
      description: `TomoriBotの記憶システムについて学ぶ`,
      title: `記憶の仕組み`,
      embed_description: `会話を跨いでユーザーやサーバーに関する事実や情報を記憶する永続的な記憶システムがあります！これは**私が知っていること**（事実、コンテキスト、情報）についてです。**私がどう振る舞うか**（パーソナリティ、トーン、設定）については、代わりに{helpCustomization}をご覧ください！`,
      teaching_title: `物事を教える`,
      teaching_description: `{memoryPersonalAdd}と{memoryServerAdd}を使用して**事実と情報**を記憶させます：
- **個人的な記憶**（{memoryPersonalAdd}）：個々のユーザーに関する事実
  - 例：「Alexは猫が好き」、「ダークモードを好む」、「ピーナッツアレルギー」
- **サーバーの記憶**（{memoryServerAdd}）：サーバー全体に関連する情報
  - 例：「ゲームナイトは毎週金曜日午後8時」、「NSFWの投稿禁止」、「お知らせには#generalを使用」`,
      forgetting_title: `忘れること`,
      forgetting_description: `{memoryPersonalRemove}と{memoryServerRemove}を使用して記憶を削除：
- {memoryPersonalRemove} - ユーザーに関する個人的な事実を削除
- {memoryServerRemove} - サーバー全体の情報を削除`,
      how_it_works_title: `仕組み：`,
      how_it_works_description: `- **個人的な記憶**は全サーバーであなた専用に紐付けられ、あなたが積極的に参加している会話で返信する際にのみ記憶します
- **サーバーの記憶**はサーバー内にのみ留まり、サーバー内の会話で返信する際に常に記憶します
- 記憶は対応する\`/memory ... remove\`コマンドを使用するまで保持されます`,
      tips_title: `記憶のヒント：`,
      tips_description: `- 好み、ニックネーム、重要な事実を教えてください
- サーバーの記憶には共有情報、内輪ネタ、サーバー文化を使用
- {memoryPersonalExport}、{memoryServerExport}、または{status}で定期的に記憶を確認
- 最良の結果を得るために記憶を簡潔明瞭に保つ{legalNotice}`,
      documents_title: `ドキュメント知識庫`,
      documents_description: `サーバー管理者は参照用のドキュメントをアップロードできます：
- \`/memory document add\`でテキスト、PDF、Markdownファイルをアップロード
- \`/memory history import\`でチャンネル履歴をドキュメント記憶として抽出
- ドキュメントは検索可能な埋め込みとして分割して保存されます
- 会話に基づいて私は自動的に関連する内容を取得します
- \`/memory document remove\`または\`/memory history remove\`で保存済みドキュメントを削除
- \`/model embedding\`で埋め込みモデルの設定が必要`,
      shortterm_title: `短期記憶`,
      shortterm_description: `永続的な記憶に加え、最近の会話は[STM（短期記憶）](https://docs.tomoribot.app/ja/features/knowledge/memory/#short-term-memory-stm)として保持しています：
- 最近のメッセージはチャンネルごとにキャッシュされ、各ペルソナは同じサーバー内の他チャンネルにも最新のSTMを持ち越します
- 古い会話を自動的に要約し、文脈を効率的に保つことができます
- **クロスサーバー共有**はオプトイン制です：{personalStm}の\`crossserver\`オプションを使うと、あなた自身の他サーバーでの会話も参照できるようになります
- {personalStmClear}でユーザー固有のSTMをすべて削除できます
- STMは時間とともに自動的に期限切れになります`,
    },
    stm: {
      description: `短期記憶のカスタマイズ方法を学びます（サーバー管理者向け）`,
      title: `短期記憶のカスタマイズ`,
      embed_description: `短期記憶（STM）は、各チャンネルでの*現在の*会話に関する作業記憶です。{helpMemory}にある永続的な事実とは別物です。サーバー管理者は、更新の頻度・表示方法・記録する内容を調整できます。`,
      parameters_title: `動作の調整（{stmParameters}）`,
      parameters_description: `主なつまみを調整します（*「生（crude）」*とは、要約する前の元のメッセージ、つまり生の会話のことです）：
- **更新頻度**：更新を促すまでに私が応答するターン数（デフォルト**5**）。
- **表示モード**：要約と生メッセージの組み合わせ方。*置き換え*（要約が生メッセージを置換）または*生＋要約*（両方を表示）。
- **生メッセージ数**：コンテキストに残す直近の生（要約前の）メッセージ数（デフォルト**6**）。
- **促しの挿入位置**：更新の促しを会話のどこに置くか（0＝最下部、2＝直近のやり取りの直前でデフォルト）。
- **記憶ブロックの挿入位置**：私の記憶ブロックをどこに置くか（-1＝上部に背景知識として置く、デフォルト；0＝最下部；N＝下からN番目の発言の前）。促しと同じ位置のとき、記憶ブロックはその直前に置かれます。`,
      nudge_title: `更新の促しの仕組み`,
      nudge_description: `会話が続いている間、STMを作成・更新するための控えめなシステムヒントが出ます。ただし*更新頻度*ごとに一度だけなので、毎メッセージ催促されることはありません。カウンターは私が応答するたびに（保存したかどうかに関わらず）進み、実際にSTMツールを使った時のみリセットされます。無視し続けると、行動するまで促しは出続けます。`,
      categories_title: `カテゴリ（{stmCategoriesEdit}）`,
      categories_description: `デフォルトのSTMは1つの自由記述の要約です。最大5つのラベル付きフィールド（例：\`Goals\`、\`Inventory\`）を定義すると、私がツール呼び出しで個別に埋め、ラベル付きセクションとして表示します。すべてのフィールドを空にすると単一要約のデフォルトに戻ります。`,
      prompts_title: `プロンプトの上書き（{stmPromptEdit}）`,
      prompts_description: `2つのプロンプト文字列をカスタマイズできます：
- **ツール説明**：私のSTMツールがモデルに提示する説明文。
- **メモリの促し**：統合された作成・更新のヒント文。
空欄にすると組み込みのデフォルトに戻ります。使用できる主な\`{...}\`マクロ：
- \`{short_term_memory_tool}\` → STMツール名
- \`{memory_tool}\` / \`{memory_update_tool}\` → 長期記憶ツール名
- \`{category_labels}\` → 設定済みカテゴリラベル一覧 *（促しのみ・カテゴリモード）*
未知のプレースホルダーは自動的に除去されます。`,
      manage_title: `管理とスコープ`,
      manage_description: `- {stmManage}：有効なサーバー共有STMエントリを確認・削除します。
- {stmPrivacyBypass}：プライベートチャンネルのSTMを他チャンネルに表示するか制御します。
- {personaStmEdit}：現在のチャンネルでペルソナのライブSTMを手動編集します。`,
    },
    "memory-tagging": {
      description: `記憶のキーワードタグとチャンネルタグの仕組みを学ぶ`,
      title: `記憶タグ付け`,
      embed_description: `デフォルトでは、すべての記憶が毎回のプロンプトに含まれます。タグを使うと、どの記憶をどこで有効にするかを制御できます。{memoryTaggingSet}で記憶タグとチャンネルタグを有効にできます。`,
      keywords_title: `キーワードタグ`,
      keywords_description: `- キーワードタグが**ない**記憶は常に有効です（デフォルト動作）
- キーワードタグが**ある**記憶は、そのキーワードがコンテキストに含まれている場合のみ有効になります
- どの記憶が現在有効かは{toolPromptSnapshot}で確認できます`,
      channels_title: `チャンネルタグ`,
      channels_description: `- \`#チャンネル\`タグが付いた記憶は、そのチャンネルでのみ有効になります
- チャンネルタグはキーワードタグと組み合わせて使用できます
- RAGを使用している場合、チャンネルタグはドキュメント（\`/memory document add\`）や履歴インポート（\`/memory history import\`）にも適用できます`,
    },
    spotlight: {
      description: `パーソナルスポットライトの仕組みと使い方を学ぶ`,
      title: `パーソナルスポットライトガイド`,
      embed_description: `[パーソナルスポットライト](https://docs.tomoribot.app/ja/features/knowledge/personalization/#personal-spotlight)を使うと、特定のチャンネルで**あなた自身**がトリガーできるペルソナを絞り込み、必要ならそのチャンネル専用の自動トリガーペルソナも設定できます。`,
      what_title: `何をする機能か`,
      what_description: `- スポットライトは **あなた + 1チャンネル** 単位で適用されます
- 他のユーザーには影響しません
- そのチャンネル専用の個人向けペルソナホワイトリストのように動きます
- その場で使えるペルソナを自分で選べます`,
      set_title: `設定方法`,
      set_description: `{personalSpotlightSet} を使って、次を選びます：
- 継続時間（時間）
- 対象チャンネル
- スポットライトに含めたいペルソナ

**hours = 0** にすると、手動で消すまで永続になります。`,
      auto_trigger_title: `自動トリガーの設定`,
      auto_trigger_description: `ペルソナを選んだ後、その中から1人を個人用の自動トリガーペルソナとして設定できます。
- そのチャンネルでは、そのペルソナがあなたのメッセージに対する既定の応答役になります
- 明示的に別ペルソナを直接トリガーした場合は、そちらが優先されます
- Finish を押した場合は、自動トリガーペルソナは設定されません`,
      rules_title: `重要なルール`,
      rules_description: `- スポットライトはアクセスを**狭めるだけ**で、広げることはありません
- {serverWhitelistPersona} などのサーバー側制限もそのまま適用されます
- 選んだペルソナだけがそのチャンネルでトリガー可能です
- 代理トリガー連鎖も防がれます。たとえばAliceだけを選んでいる場合、Aliceの返信からBobへ受け渡すことはできません`,
      manage_title: `変更・削除するには`,
      manage_description: `{personalSpotlightManage} で現在のスポットライト一覧を確認できます。
- チェックを残すと維持
- チェックを外すと削除
- 時間制スポットライトは期限が来ると自動で消えます`,
      footer: `サーバー全体の設定を変えずに、特定チャンネルで自分向けに応答ペルソナを絞りたいときに使ってください。`,
    },
    "deliberate-trigger-mode": {
      description: `明示的トリガーモードで何が変わるかを学ぶ`,
      title: `明示的トリガーモードガイド`,
      embed_description: `[明示的トリガーモード（DTM）](https://docs.tomoribot.app/ja/features/chatting-personality/chatting-and-triggers/#deliberate-trigger-mode)は、ペルソナの明示的トリガーとして何を認めるかを変える設定です。特に通常のトリガーワードの扱いが変わります。`,
      normal_title: `通常時のトリガー`,
      normal_description: `DTMがオフのとき、Tomoriは通常次の方法で反応できます：
- メッセージ中の通常のトリガーワード
- Discordメンション
- そのペルソナへのリプライ
- 手動返信用の {botRespond}

いちばん大きい違いは、通常のトリガーワードだけでもペルソナを直接起動できることです。`,
      enabled_title: `DTMオンで変わること`,
      enabled_description: `DTMがオンになると、通常のトリガーワードは明示的なペルソナトリガーとして扱われなくなります。
- \`@{trigger}\` は引き続き有効
- Discordメンションは有効
- リプライは有効
- {botRespond} は有効

つまり、普段の会話で偶然ペルソナ名が出ただけでは起動せず、より意図的な呼びかけが必要になります。`,
      personal_title: `サーバー設定と個人設定`,
      personal_description: `- サーバー全体のDTMは {serverDtm} で切り替えられます
- 個人ごとの上書きは {personalDtm} で設定できます
- 個人DTMには3つのモードがあります：
  off = いつでも通常のトリガーワードを許可
  follow = サーバー設定に従う
  on = いつでも明示的な呼びかけだけを許可`,
      footer: `普段の会話でペルソナ名や短いトリガー語がよく出てしまい、誤反応が多いならDTMが有効です。`,
    },
    customization: {
      description: `TomoriBotのパーソナリティと動作をカスタマイズする方法を学ぶ`,
      embed1_title: `TomoriBotのカスタマイズ`,
      embed1_description: `TomoriBotは高度にカスタマイズ可能です！私を本当にあなたのものにするために設定できるすべてがここにあります。これは**私がどう振る舞うか**（パーソナリティ、トーン、設定）についてです。**私が記憶していること**（事実、記憶）については、代わりに{helpMemory}をご覧ください！`,
      summary_personas_title: `ペルソナ`,
      summary_personas_description: `{personaCreate} または {personaGenerate} でペルソナを作り、{personaAttributeAdd} と {personaSampleDialogueAdd} で調整できます。ペルソナは切り替え、エクスポート、インポート、別々のアルターIDとして使用できます。`,
      summary_behavior_title: `動作設定`,
      summary_behavior_description: `{configModel}、{configHumanizer}、{configSystemPromptSet}、{capabilitiesManage} で、モデル選択、人間らしさ、システム指示、機能アクセスを調整できます。`,
      summary_server_title: `サーバー側の制御`,
      summary_server_description: `管理者は、ペルソナ制限、{serverWhitelistChannel} などのホワイトリストチャンネル、自動トリガー、クールダウン、ロール権限を組み合わせて、TomoriBot がどこでどう応答するかを制御できます。`,
      embed1_personas_title: `パーソナリティペルソナ`,
      embed1_personas_description: `私の核となるパーソナリティと動作を制御：

**ペルソナコマンド：**
- {personaCreate} - ゼロからカスタムパーソナリティを作成
- {personaGenerate} - 説明と画像に基づいてAIがパーソナリティを生成（構造化出力に対応したプロバイダーが必要。TomoriプリセットやSillyTavernカードをアップロードして既存キャラクターを変換することも可能）
- {personaDefault} - デフォルトのパーソナリティに切り替え
- {personaExport} - ペルソナを共有またはバックアップ用にエクスポート
- {personaImport} - ファイルからペルソナをインポート（独自のトリガーとウェブフックアバターを持つアルターペルソナとしてインポートも対応）
- {personaRemove} - アルターペルソナを削除
- {personaAttributeAdd} / {personaSampleDialogueAdd} - 話し方や行動を教える
- {serverAvatar} - プロフィール画像を変更`,
      embed1_what_personas_include_title: `ペルソナに含まれるもの：`,
      embed1_what_personas_include_description: `- パーソナリティ属性（特性、特徴、癖）
- サンプル対話（話し方を教える会話例）
- そのパーソナリティ用のカスタムサーバーアバター
- 動作とトーンの設定
- アルターペルソナ：独自のトリガー、ウェブフックアバター、パーソナリティを持つ別キャラクター`,
      embed1_footer: `次：教えるコマンド`,
      embed2_title: `教えるコマンド `,
      embed2_description: `## ペルソナ学習コマンド（\`/persona\`）
パーソナリティと知識を微調整：

**パーソナリティの形成：**
- {personaAttributeAdd} - パーソナリティの特性を追加（例：「フレンドリー」、「皮肉っぽい」、「フォーマル」）
- {personaSampleDialogueAdd} - 話し方を形作る会話例を追加
- {configRename} - 自分を何と呼ぶべきかを設定

**サンプル対話の書き方：**
例で\`{user}\`と\`{bot}\`のプレースホルダーを使用：
- \`{user}\` = 実際のユーザーの名前/ニックネームに置き換えられます
- \`{bot}\` = 私の現在の名前に置き換えられます

**例：**
\`\`\`
ユーザーメッセージ：{user}：やあ、元気？
ボットの応答：{bot}：よぉ{user}！超元気だぜ、わかるだろ？
\`\`\`

**優れたサンプル対話のヒント：**
- 自然で会話的なやり取りを書く
- 表現したいパーソナリティの特性を含める
- 望むトーンを示す
- より良く学習できるように多様性を追加
- \`/persona export\`で共有する際にみんなに使えるようプレースホルダーを使用`,
      embed2_footer: `次：設定`,
      embed3_title: `設定＆管理`,
      embed3_description: `## 削除コマンド（\`/persona\`）
パーソナリティのカスタマイズを削除：

- {personaAttributeRemove} - 特定のパーソナリティ属性を削除
- {personaSampleDialogueRemove} - サンプル対話の例を削除

---

## サーバー設定（\`/server\`）
サーバー全体の設定と動作：

**学習＆プライバシー：**
- {serverMemberpermissions} - 誰が私に物事を教えられるかを制御
- {serverBlacklist} - 特定のユーザーから学習したり記憶を使用するのを防ぐ

**自動トリガー動作：**
- {serverAutotriggerChannels} - メンションなしで応答するチャンネルを設定
- {serverAutotriggerThreshold} - 自動応答のメッセージ閾値を設定

**トリガー＆外観：**
- {serverTriggerAdd} - 反応するカスタムトリガーワードを追加（アルターペルソナにも対応しています）
- {serverTriggerRemove} - トリガーワードを削除
- {serverAvatar} - このサーバー用のカスタムプロフィール画像を設定

**チャンネルホワイトリスト＆クールダウン：**
- {configCooldown} - 私の応答間のグローバルクールダウンを設定
- {serverWhitelistChannel} - チャンネルをホワイトリストに追加（ホワイトリストされたチャンネルのみが私をトリガーできます）
- {serverWhitelistPersona} - ペルソナがトリガーできるチャンネルを制限
- {serverWhitelistRole} - ロールホワイトリストにロールを追加/削除
- {serverWhitelistRemove} - ホワイトリスト項目を削除
- ホワイトリストされたチャンネルは、チャンネル固有の上書きを設定しない限りグローバルクールダウンを継承します

**ドキュメント：**
- {memoryDocumentAdd} - 参照用のドキュメントをアップロード
- {memoryDocumentRemove} - アップロードされたドキュメントを削除`,
      embed3_footer: `次：ボット設定`,
      embed4_title: `詳細設定`,
      embed4_description: `## ボット設定（\`/config\`）
個人的なボット設定：

**AI設定：**
- {configModel} - 使用するAIモデルを選択
- {configTemperature} - 創造性/ランダム性を調整。高いほど応答がより多様に（1.0-2.0）
- {configHumanizer} - 応答の人間らしさを変更

**画像生成：**
- {generateImage} - プロンプトから画像を生成し、参照画像を編集する
- {configModelImage} - 画像生成モデルを選択（Text2ImageとImage2Image対応）

**システムプロンプト：**
- {configPromptChange} - カスタムシステム指示を追加（最大16000文字）
- {configPromptPreset} - プリセットシステムプロンプトを選択
- {configPromptClear} - デフォルトシステムプロンプトにリセット

**APIキー：**
- {configApikeySet} - AIプロバイダーのAPIキーを設定
- {configApikeyDelete} - APIキーを削除
- {configApikeyRotation} - 自動フェイルオーバーとロード分散用のバックアップAPIキーを管理
- {configBraveapiSet} - Brave Search APIキーを設定（オプション）
- {configBraveapiDelete} - Brave Search APIキーを削除

**パーソナライゼーション：**
- {configRename} - 自分を何と呼ぶかを変更
- {configTimezone} - 時間認識応答とリマインダー用のタイムゾーンを設定
- {configPermissions} - 機能のオン/オフを切り替え（画像生成を含む）
- {configUncensors} - 検閲なし出力オプションを設定
- {personalPrivacy} - 私への視認性を制御（完全に見えなくなるオプション利用可能）
- {serverInitializeExpressions} - サーバーの絵文字とステッカーの見た目を登録し、適切な場面で使えるようにする

**ドキュメント知識庫：**
- {configModelEmbedding} - ドキュメントアップロードとRAG用の埋め込みモデルを設定`,
      embed4_footer: `他に質問があれば、\`/support discord\`でサポートサーバーに参加してください`,
      embed5_title: `プロのヒント`,
      embed5_description: `- ペルソナ（デフォルトまたは生成）を基盤として始める
- 素早くパーソナリティを調整するには\`/persona attribute add\`を使用
- サンプル対話では、属性や特性も示す例を使用すると効果的：
\`\`\`
ユーザーメッセージ：{user}：お気に入りの趣味は？
ボットの応答：{bot}：ふふ〜小さなぬいぐるみに小さな服を編むのが好きです〜♥
\`\`\`
- チャットして変更をテストし、しっくりくるまで繰り返す
- ペルソナをエクスポートしてバックアップするか、他のサーバーと共有！`,
    },
    mcp: {
      description: `MCPツールサーバーの追加と管理方法を学ぶ`,
      title: `MCPサーバーセットアップガイド`,
      description_text: `MCP（Model Context Protocol）サーバーは、外部ツールでTomoriの機能を拡張します。始め方を説明します。`,
      online_title: `オンラインMCPの追加`,
      online_description: `HTTPSエンドポイントを持つ公開MCPサーバーであれば、どれでも追加できます。Smithery.aiはその一例に過ぎません。

**Smithery.aiを使う場合：**
**1.** [smithery.ai](https://smithery.ai) にアクセスし、アカウントを作成してプロフィールからAPIキーを生成します。
**2.** カタログを閲覧し、追加したいMCPを開きます。ページに表示されている**接続URL**をコピーします（例：\`https://youtube.run.tools\`）。
**3.** {configMcpAdd} を実行し、**URL**フィールドに接続URLを、**認証トークン**フィールドにSmithery APIキーを貼り付けます。

**他のソースを使う場合：**
認証が不要なMCPサーバーの場合は、**認証トークン**フィールドを空白のままにしてください。サーバーによっては別の認証形式を使用する場合があります。詳細はそのサーバーのドキュメントを確認してください。

認証トークンは保存後に暗号化され、平文で表示されることはありません。`,
      online_summary_description: `{configMcpAdd} で、公開された HTTPS MCP サーバーを登録できます。認証トークンは保存後に暗号化されます。接続URLの注意点はドキュメントを確認してください。`,
      local_title: `ローカルMCPの追加（自己ホスト限定）`,
      local_description: `ローカルMCPサーバーは、**自己ホストのTomoriBotインスタンスでのみ対応しています**。公式ホスト版のbotはセキュリティのためHTTPSが必要で、ローカル/プライベートアドレスはブロックされます。

自己ホストの場合は、ローカルサーバーのURLを指定してください（例：\`http://localhost:3000/sse\`）。ローカルサーバーには認証トークンは不要です。`,
      local_summary_description: `ローカル MCP サーバーは自己ホスト専用です。公式ホスト版はローカル/プライベートアドレスをブロックします。ローカルMCPの起動とURL登録手順はドキュメントにあります。`,
      removing_title: `MCPサーバーの削除`,
      removing_description: `{configMcpRemove} を使えば、いつでもサーバーの登録を解除できます。削除すると即座に接続が切断され、新しいサーバーのスロットが解放されます。`,
      security_title: `セキュリティに関する警告`,
      security_description: `**信頼できるMCPサーバーのみ追加してください。**

悪意のあるMCPサーバーは以下のことが可能です：
- **プロンプトインジェクション**：Tomoriへ隠し指示を送り、動作を操作する
- **データ漏洩**：ツールに渡されたデータ（メッセージやファイル内容など）を外部へ送信する
- **有害または虚偽の結果** を返し、Tomoriがそれをサーバーに中継する

MCPサーバーはブラウザ拡張機能やサードパーティアプリと同様の注意を持って扱ってください。不安な場合は追加しないでください。`,
      footer: `Smithery.aiはサードパーティのサービスであり、TomoriBotとは無関係です。追加前に必ずMCPの提供ツールを確認してください。`,
    },
    nsfw: {
      description: `年齢制限コマンド（NSFW）を有効にする方法を学ぶ`,
      title: `年齢制限コマンドの有効化`,
      embed_description: `TomoriBotは年齢制限コマンドに対応しています。有効化方法は以下の通りです：`,
      enable_title: `ステップ1：Discordの設定で有効化`,
      enable_description: `**1.** Discordを開いて **ユーザー設定** （左下の歯車アイコン）を開く
**2.** **プライバシーとセーフティ** に移動
**3.** **アプリのコマンドで年齢制限付きコンテンツを許可する** をオンにする
**4.** 有効化すると、NSFWコマンドが利用可能になります

注：この設定を有効にするには18歳以上である必要があります。`,
      channel_title: `ステップ2：NSFWチャンネルで使用`,
      channel_description: `年齢制限コマンドはNSFWとしてマークされたチャンネルでのみ実行可能です：
- デスクトップ：チャンネルを右クリック → **チャンネル編集** → **NSFW** をオン
- モバイル：チャンネル設定 → **NSFW** をオン
- NSFWのマークはサーバー管理者のみが変更できます

チャンネルがNSFWでない場合はコマンド実行時に権限エラーが表示されます。`,
      warning_title: `⚠️ コンテンツ警告`,
      warning_description: `年齢制限コマンドは **成人向けのコンテンツ** を含む場合があります。これらのコマンドは18歳以上の利用者を対象としています。責任を持って使用し、Discordコミュニティガイドラインを守ってください。`,
      footer: `その他のヘルプについては \`/help\` を使用して、利用可能なコマンドをご確認ください。`,
    },
    "deliberate-tool-mode": {
      description: `明示的ツールモードでツール利用がどう変わるかを学ぶ`,
      title: `明示的ツールモードガイド`,
      embed_description: `[明示的ツールモード](https://docs.tomoribot.app/ja/features/capabilities/tools-and-extensions/#deliberate-tool-mode)は、メッセージがツールを必要としているように見える場合だけ、通常会話ターンにツール宣言を含めます。`,
      what_title: `何をするか`,
      what_description: `明示的ツールモードが有効な場合、まずメッセージに明示的なツール意図があるか確認します。意図が見つからない場合、そのターンではツール宣言を外します。これによりプロンプト量が減り、小型・ローカルモデルの応答が速くなります。`,
      intent_title: `ツール意図として扱われるもの`,
      intent_description: `組み込みトリガーは、リマインダー、Web検索、メモリー更新、クロスチャンネルメッセージ、画像・動画・音声生成、メディア解析、スレッド作成、メッセージ操作などの一般的な依頼を扱います。

最近の文脈がツールを示している場合は、\`do that again but angrier\`、\`same thing but softer\`、音声メッセージ依頼の後の \`pretty please?\` などのフォローアップ表現も使えます。`,
      custom_title: `カスタムトリガーフレーズ`,
      custom_description: `サーバー管理者は {triggerCommand} でリテラルなフレーズを追加できます。たとえば \`pic\`、\`img\`、\`pfp\` を画像生成に対応させたり、サーバー独自の言い回しを適切なツール対象へ対応させたりできます。`,
      control_title: `制御とログ`,
      control_description: `- サーバー管理者は {serverDtm} で切り替えられます
- ユーザーは {personalDtm} で自分向けに上書きできます
- {thoughtLogs} で思考ログチャンネルが設定されている場合、明示的ツールモードで実際に使われたツールと、そのツールを表示させたトリガーがそこに記録されます`,
      footer: `明示的ツールモードは、どのツールをモデルに見せるかを決めます。見せられたツールを実際に呼ぶかどうかは、モデル側の判断です。`,
    },
  },
};
