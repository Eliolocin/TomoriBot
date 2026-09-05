export default {
  tool: {
    estimate: {
      description: `利用量と費用の見積もり`,
      cost: {
        description: `有料AIプロバイダーのAPI費用を見積もる`,
        title: `推定API費用`,
        embed_description: `Discordチャンネルでのトリガーあたりの**非常におおまかな**推定費用です。費用は**{provider}**の例を使用して推定されています（入力：{inputPrice}/百万トークン、出力：{outputPrice}/百万トークン）`,
        current_context_description: `あなたの**現在のコンテキストのみ**を対象にした推定費用です。入力トークンは、現在の設定と直近のチャンネル履歴を使って、**{provider}** のモデル **{model}** でプロバイダーAPI計測を行います。出力トークンは推定値です。使用価格: 入力 {inputPrice}/百万、出力 {outputPrice}/百万。`,
        current_context_estimated_description: `あなたの**現在のコンテキストのみ**を対象にした推定費用です。**{provider}**（モデル **{model}**）はライブのトークン計測APIに対応していないため、入力トークンは、現在の設定と直近のチャンネル履歴をもとに**文字数からの概算**（約4文字＝1トークン）です。精度は言語によって変わり、日本語のような密な文字体系ではこの推定より高くなります。出力トークンも推定値です。使用価格: 入力 {inputPrice}/百万、出力 {outputPrice}/百万。`,
        current_input_title: `計測済み入力トークン（現在のコンテキスト）`,
        current_input_estimated_title: `推定入力トークン（現在のコンテキスト）`,
        current_input_value: `**入力:** {inputTokens} トークン
**入力コストのみ:** 1トリガーあたり約 {inputCost}`,
        current_output_typical_title: `推定出力: 標準`,
        current_output_persona_average_title: `推定出力: ペルソナ平均`,
        current_output_band_value: `**出力推定:** {outputTokens} トークン
**出力推定コスト:** 1トリガーあたり約 {outputCost}`,
        average_total_cost_title: `1トリガーあたりの平均合計費用`,
        average_total_cost_value: `**合計推定:** {totalTokens} トークン
1トリガーあたり約 {costPerMessage}（100トリガーあたり約 {costPer100}）`,
        current_footer: `入力トークンは、ライブ計測に対応したプロバイダーでのみプロバイダー計測値になります。出力トークンは推定値です。「ペルソナ平均」バンドは、ペルソナのサンプルダイアログ返信とこのチャンネルの直近ペルソナ発言を合算して平均します。どちらも存在しない場合は、標準の推定値にフォールバックします。`,
        current_estimated_footer: `このプロバイダーはライブ計測APIに対応していないため、入力トークンは文字数からの概算です。特に日本語やJSONが多いコンテキストではおおよその目安として扱ってください。出力トークンも推定値です。「ペルソナ平均」バンドは、ペルソナのサンプルダイアログ返信とこのチャンネルの直近ペルソナ発言を合算して平均します。どちらも存在しない場合は、標準の推定値にフォールバックします。`,
        no_cost_provider_description: `現在のプロバイダーには費用がありません`,
        unavailable_description: `現在のプロバイダー（**{provider}**）ではライブ費用見積もりを利用できません。`,
        fallback_notice_title: `ライブ計測を利用できません`,
        fallback_notice_value: `現在の設定ではライブのプロバイダートークン計測を利用できなかったため、この表示はおおまかな代替推定です。`,
        minimum_scenario_title: `最小シナリオ（軽量使用）`,
        minimum_scenario_value: `**コンテキスト：** 1ユーザー、メモリなし、1段落のペルソナ、会話は1メッセージあたり1文未満
**トークン数：** {inputTokens} 入力 + {outputTokens} 出力`,
        average_scenario_title: `平均シナリオ（中程度使用）`,
        average_scenario_value: `**コンテキスト：** 3ユーザー（各10メモリ）、~16段落のペルソナ（属性と対話を含む）、会話は1メッセージあたり1〜2文
**トークン数：** {inputTokens} 入力 + {outputTokens} 出力`,
        maximum_scenario_title: `最大シナリオ（重量使用）`,
        maximum_scenario_value: `**コンテキスト：** 5ユーザー（各25メモリ）、~31段落のペルソナ（属性と対話を含む）、会話は1メッセージあたり2段落
**トークン数：** {inputTokens} 入力 + {outputTokens} 出力`,
        breakdown_title: `費用に影響する要因`,
        breakdown_value: `**入力トークン（AIに送信されるコンテキスト）：**
- ペルソナの段落数（属性とサンプル対話を含む）
- サーバー＆個人メモリ
- 有効化されたツール（ある場合）
- ユーザーステータス＆リマインダー
- 最近の会話履歴（プロバイダーがサポートしている場合、画像、動画、スタンプ、絵文字、埋め込みを含む）
- サーバー絵文字（常に10個）

**出力トークン（AI応答）：**
- 応答の長さはクエリの複雑さによって異なります
- より詳細な質問 = より長い応答 = より高い費用

**費用を削減するヒント：**
サーバー内の悪用者やスパマーによる費用を削減するための組み込み機能がありますが、以下の追加のヒントもあります：
- ペルソナの段落数を少なくする（属性と対話）
- メモリを簡潔に保つ
- 無料のAIプロバイダーを使用する（Google Gemini無料プラン）
- 自動トリガーチャンネルを制限する`,
        footer: `Google Gemini（無料プラン）や一部のOpenRouterモデルなどの無料プロバイダーは費用がかかりません！NovelAIはサブスクリプション制で無制限に使用できます。詳細は\`/help\`のセットアップから「ステップ1：APIキーを取得」を開いてください。`,
      },
    },
    delete: {
      description: `ターンやチャンネルのコンテンツを削除します。`,
      turn: {
        description: `チャンネルから最後のペルソナのターンを削除します。`,
        regenerate_description: `trueの場合、削除後にペルソナを再トリガーします。`,
        select_persona_description: `trueの場合、削除するペルソナのターンを選択できます。`,
        no_permission_title: `権限が不足しています`,
        no_permission_description: `このコマンドにはサーバー管理権限が必要か、指定されたRPチャンネルで使用する必要があります。`,
        already_running_title: `削除中です`,
        already_running_description: `このチャンネルではすでに削除処理が進行中です。しばらくお待ちください。`,
        no_persona_found_title: `ペルソナのターンが見つかりません`,
        no_persona_found_description: `最近の履歴にペルソナの連続したメッセージブロックが見つかりませんでした。`,
        deleting_title: `⏳ ターンを削除中`,
        deleting_description: `**{persona_name}** の {count} 件のメッセージを削除中...`,
        success_title: `✅ ターンが削除されました`,
        success_description: `**{persona_name}** の {count} 件のメッセージを削除しました。`,
        success_regenerate_description: `**{persona_name}** の {count} 件のメッセージを削除しました。再トリガー中...`,
        partial_title: `⚠️ 一部削除されました`,
        partial_description: `**{persona_name}** の {deleted_count}/{total_count} 件のメッセージを削除しました。一部のメッセージは削除できませんでした。`,
        partial_no_manage_messages_description: `**{persona_name}** の {deleted_count}/{total_count} 件のメッセージを削除しました。**メッセージ管理**権限がないため、すべてを削除することはできませんでした。`,
        bot_no_delete_title: `メッセージを削除できません`,
        bot_no_delete_description: `このチャンネルで**メッセージ管理**権限がなく、ウェブフックフォールバックでもメッセージを削除できませんでした。**メッセージ管理**権限を付与するか、ウェブフックが利用可能であることを確認してください。`,
        bot_failed_delete_description: `メッセージを削除しようとしましたが、予期しないエラーが発生しました。`,
      },
    },
    prompt: {
      snapshot: {
        description: `デバッグ用に、ペルソナのLLMプロンプトをファイルに出力します。`,
        format_description: `スナップショットファイルの出力形式。`,
        fetch_tools_description: `trueの場合、利用可能なツール／関数定義をスナップショットに追加します（JSON形式のみ）。`,
        text_option: `テキスト`,
        json_option: `JSON`,
        no_permission_title: `権限が不足しています`,
        no_permission_description: `**サーバー管理**権限が必要か、サーバーオーナーが\`/moderation\`でこの機能を有効にする必要があります。`,
        modal_title: `ペルソナを選択`,
        persona_select_label: `ペルソナ`,
        persona_select_description: `スナップショットを取るペルソナを選択してください。`,
        persona_select_placeholder: `ペルソナを選択...`,
        dm_title: `プロンプトスナップショット`,
        dm_description: `ペルソナ **{persona_name}** のプロンプトスナップショットです（形式: {format}）。`,
        dm_txt_headers_note: `ご注意：TXTファイル内の \`=== タイトル (/コマンド) ===\` および \`== サブタイトル ==\` のヘッダーは、各セクションを制御する設定コマンドを示すための注釈です。LLMに実際に送信されるプロンプトの一部では**ありません**。`,
        dm_hint_try_json: `生の機械可読フォーマットが必要ですか？コマンドを再実行する際に \`format: JSON\` を指定してください。`,
        dm_hint_try_text: `より人間に読みやすい形式が必要ですか？コマンドを再実行する際に \`format: Text\` を指定してください。`,
        dm_tools_txt_note: `ツール定義はTXT形式からは省略されています。含めるには \`format: JSON\` と \`fetch_tools: true\` を指定して再実行してください。`,
        dm_config_heading: `**サンプリング / リクエスト設定**（プロバイダーアダプタが実行時に送信する内容と一致）：`,
        dm_failed_title: `DMを送信できませんでした`,
        dm_failed_description: `DMを送信できませんでした。スナップショットをここに添付します。今後DMで受け取るには、サーバーメンバーからのDMを有効にしてください。`,
        success_title: `スナップショットを送信しました`,
        success_description: `プロンプトスナップショットをDMに送信しました。`,
        no_personas_title: `ペルソナが見つかりません`,
        no_personas_description: `このサーバーにはペルソナが登録されていません。`,
        build_failed_title: `スナップショット失敗`,
        build_failed_description: `プロンプトスナップショットの生成に失敗しました。もう一度お試しください。`,
        guild_only_title: `サーバー専用`,
        guild_only_description: `このコマンドはサーバーチャンネルでのみ使用できます。`,
        dm_tools_filtering_note: `JSONスナップショット内のツール定義は、deliberate tool mode が有効な場合、直近の表示済みターンに合わせてフィルタリングされます。後から作成するスナップショットでは一時的な直近ツール文脈を完全には復元できない場合がありますが、実際のターンでツールが限定または抑制される状況で全ツール一覧を出力しないようになっています。`,
      },
    },

    visualize: {
      description: `このチャンネルの直近コンテキストから素早くシーン画像を生成します。`,
      missing_permissions_title: `権限がありません`,
      missing_permissions_description: `このチャンネルでシーン画像を生成するには、チャンネルの閲覧、メッセージ履歴の読み取り、メッセージ送信、ファイル添付の権限が必要です。`,
      cooldown_active: `このサーバーの管理者がクールダウンを設定しています。\`/tool visualize\` を再度使用するまで、あと **{seconds}** 秒お待ちください。このクールダウンはメッセージトリガーや他の手動コマンドと共有されています。`,
      channel_not_whitelisted: `このサーバーではホワイトリスト制限が有効です。\`/tool visualize\` はホワイトリスト登録チャンネル内で、かつホワイトリスト登録ロールを持つメンバーのみ使用でき、このチャンネルで許可されたペルソナだけを使えます。`,
      persona_access_blocked: `現在のホワイトリスト権限と個人スポットライト設定では、このチャンネルで \`/tool visualize\` に使えるペルソナがありません。`,
      no_backend_title: `使える画像バックエンドがありません`,
      no_backend_description: `このサーバーで今使える画像バックエンドが見つかりませんでした。**{current_provider}** に有効な画像モデルを設定するか、NovelAI で描画したい場合は NovelAI のオプション API キーを追加してください。`,
      planner_unavailable_title: `計画用モデルがありません`,
      planner_unavailable_description: `現在のプロバイダーで構造化出力に対応したモデルが見つからないため、今はシーン画像を計画できません。`,
      planner_failed_title: `シーン計画に失敗しました`,
      planner_failed_description: `最近のチャンネル文脈を画像プランに変換できませんでした: {error}`,
      success_title: `シーン画像を投稿しました`,
      success_description: `最近のチャンネル文脈から構図を計画し、このチャンネルに画像を投稿しました。`,
      modal: {
        title: `シーン画像`,
        prompt_label: `追加指示（任意）`,
        prompt_description: `シーンプランナーに反映してほしい補足、雰囲気、修正を入力してください`,
        prompt_placeholder: `例: 雨を強調して、やわらかめの雰囲気で、二人とも見えるように`,
        setting_label: `構図プリセット`,
        setting_description: `この fire-and-forget シーン画像に使う構図プリセットを選択してください`,
        setting_storybeat_label: `ストーリービート`,
        setting_storybeat_description: `直近の場面を広めに切り取るシネマ風構図`,
        setting_character_label: `キャラクター重視`,
        setting_character_description: `主役や話者に寄せた近めの構図`,
        setting_snapshot_label: `スクエアスナップ`,
        setting_snapshot_description: `今この瞬間を収めるバランス型の正方形構図`,
        setting_vertical_label: `スマホ壁紙`,
        setting_vertical_description: `シルエットを活かした縦長構図`,
        backend_label: `画像バックエンド`,
        backend_description: `どのレンダラーでこのシーン画像を生成するか選択してください`,
        backend_current_label: `現在のプロバイダー`,
        backend_current_description: `{provider} の通常の画像生成フローとプロンプト形式を使います`,
        backend_novelai_label: `NovelAI`,
        backend_novelai_description: `シーンを NovelAI 向けタグに変換し、NovelAI の画像ツールで生成します`,
        persona_label: `送信ペルソナ`,
        persona_description: `生成された画像を投稿するペルソナを選んでください`,
      },
    },
  },
};
