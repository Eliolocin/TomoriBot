// Export the entire locale structure as a default object
export default {
	general: {
		// Cooldown messages
		cooldown_title: `お待ちください！`,
		cooldown: `⏳ \`/{category}\` コマンドをもう一度使うまで {seconds} 秒お待ちください。`,

		// Standard interaction responses (buttons, selects)
		interaction: {
			cancel_title: `❌ 操作がキャンセルされました`,
			cancel_description: `操作がキャンセルされました。いつでもまた試すことができます！`,
			timeout_title: `⏰ 操作がタイムアウトしました`,
			timeout_description: `時間内に応答がありませんでした。続行したい場合は再度お試しください。`,
		},

		// Pagination component messages
		pagination: {
			page_info: `{current} / {total} ページ`,
			previous: `前へ`,
			next: `次へ`,
			cancel: `キャンセル`,
			no_items: `表示するアイテムがありません。`,
			cancelled: `選択がキャンセルされました。`,
			timeout: `時間内に選択されませんでした。再度お試しください。`,
			item_selected: `選択済み: {item}`,
		},

		// 一般的なエラーメッセージ
		errors: {
			guild_only_title: `サーバー専用コマンド`,
			guild_only_description: `このコマンドはサーバーチャンネル内でのみ使用できます。`,
			dm_not_supported_title: `DMはサポートされていません`,
			dm_not_supported_description: `申し訳ありませんが、ダイレクトメッセージではなく、サーバーチャンネル内でのみチャットできます。`,
			tomori_not_setup_title: `Tomoriが設定されていません`,
			tomori_not_setup_description: `このサーバーでまだ設定されていないようです。管理者が最初に \`/config setup\` を使用する必要があります。`,
			api_key_missing_title: `APIキーがありません`,
			api_key_missing_description: `機能するためにGoogle Gemini APIキーが必要ですが、このサーバーでは設定されていません。管理者が \`/config apikeyset\` を使用して設定できます。`,
			api_key_error_title: `APIキーエラー`,
			api_key_error_description: `設定されたAPIキーへのアクセスまたは復号化に問題がありました。正しく設定されていることを確認してください。`,
			context_error_title: `コンテキスト構築エラー`,
			context_error_description: `会話のコンテキストを理解しようとする際にエラーが発生しました。再度お試しください。`,
			critical_error_title: `重大なエラー`,
			critical_error_description: `メッセージの処理中に予期しない重大なエラーが発生しました。続く場合は報告してください。`,
			update_failed_title: `更新に失敗しました`,
			update_failed_description: `データベースの設定の更新に失敗しました。再度お試しください。`,
			unknown_error_title: `不明なエラー`,
			unknown_error_description: `予期しないエラーが発生しました。再度お試しいただくか、続く場合は報告してください。`,
			invalid_option_title: `無効なオプション`,
			invalid_option_description: `選択されたオプションは無効です。有効なオプションを選択してください。`,
			brave_api: {
				missing_key: {
					title: `Brave APIキーがありません`,
					description: `検索を実行するためにBrave Search APIキーが必要ですが、このサーバーでは設定されていません。管理者が \`/config braveapiset\` を使用して設定するか、\`/config tomoripermissions\` を使用して無効にできます。`,
					footer: `https://brave.com/search/api/ で無料のAPIキーを取得してください`,
				},
			},
		},
		tomori_busy_title: "他の人に返信中です！",
		tomori_busy_replying:
			"現在 {message_link} に対応中です。あなたのメッセージはキューに入れられました。",
	},

	genai: {
		// Errors related to LLM API generation
		generic_error_title: `生成エラー`,
		generic_error_description: `申し訳ありませんが、応答を生成しようとする際にエラーが発生しました（{error_message}）。後でもう一度お試しください。`,
		safety_block_title: `コンテンツがブロックされました`,
		safety_block_description: `安全上の理由（{reason}）でフラグが立てられたため、リクエストを処理したり応答を生成したりできませんでした。プロンプトを修正するか、別のことを試してください。`,
		api_error_title: `Gemini APIエラー`,
		error_stream_timeout_title: "接続タイムアウト",
		error_stream_timeout_description:
			"現在、私の脳に接続するのに問題があります。しばらくしてからリクエストを再試行するか、`/tools refresh` を使用してコンテキスト履歴を更新してください。これが続く場合は、サービスに一時的な問題がある可能性があります。",

		// Specific Gemini API error codes
		"400_invalid_argument_description": `**400 INVALID_ARGUMENT:** リクエストが不正な形式でした（例：タイプミス、フィールドの欠落）。手動で設定する場合はAPIドキュメントを確認してください。`,
		"400_failed_precondition_description": `**400 FAILED_PRECONDITION:** Gemini API無料ティアがあなたの地域で利用できないか、関連するGoogle Cloudプロジェクトで請求を有効にする必要があります。`,
		"403_permission_denied_description": `**403 PERMISSION_DENIED:** 提供されたAPIキーが無効、期限切れ、または選択されたモデルに必要な権限がありません。`,
		"404_not_found_description": `**404 NOT_FOUND:** リクエストに必要なリソース（画像やファイルなど）が見つからないか、モデル名が正しくありません。`,
		"429_resource_exhausted_description": `**429 RESOURCE_EXHAUSTED:** あまりに多くのリクエストが送信されています。しばらく待ってから再度お試しください（レート制限超過）。`,
		"500_internal_description": `**500 INTERNAL:** Googleサイドで予期しないエラーが発生しました。これは非常に長いプロンプト/コンテキストが原因の可能性があります。入力を減らすか、後でもう一度お試しください。`,
		"503_unavailable_description": `**503 UNAVAILABLE:** Geminiサービスが一時的に過負荷または利用できません。少し待ってから再度お試しください。`,
		"504_deadline_exceeded_description": `**504 DEADLINE_EXCEEDED:** 非常に大きなプロンプトやコンテキストのために、リクエストの処理に時間がかかりすぎました。入力を減らしてみてください。`,
		unknown_api_error_description: `Gemini APIとの通信中に予期しないエラーが発生しました：\`{error}\``,

		// Empty response from API
		empty_response_title: `空の応答`,
		empty_response_description: `AIから空の応答を受信しました。時々これが起こることがあります。言い換えるか、再度お試しください。`,
		// New: Max iterations for function calls
		max_iterations_title: "思考ループ",
		max_iterations_streaming_description:
			"Tomoriが思考ループに陥り、リクエストを完了できませんでした。言い換えるか、後でもう一度お試しください。",

		// New: Search related messages
		search: {
			web_search_title: `🔍 \`{query}\`をWeb検索中...`,
			image_search_title: `🔍 \`{query}\`を画像検索中...`,
			video_search_title: `🔍 \`{query}\`を動画検索中...`,
			news_search_title: `🔍 \`{query}\`をニュース検索中...`,
			disclaimer_description:
				`⚠️ **ご注意**: AI生成の応答と検索結果は不正確または不完全な場合があります。重要な情報は必ず再確認してください`,
		},

		// YouTube video processing messages
		video: {
			youtube_processing_title: "🎥 YouTube動画を視聴中...",
			youtube_processing_description:
				"YouTube動画を分析しています: **{video_url}**\n\n動画の長さによって時間がかかる場合があります。コンテンツを処理している間、少しお待ちください。",
		},

		// New: Stream specific error messages
		stream: {
			prompt_blocked_title: "リクエストがブロックされました",
			prompt_blocked_description:
				"次の理由でブロックされたため、リクエストを処理できませんでした：{reason}。リクエストを修正してお試しください。",
			response_stopped_title: "応答が中断されました",
			response_stopped_description:
				"次の理由で応答が中断されました：{reason}。出力が不完全な可能性があります。",
			streaming_failed_description:
				"Tomoriが応答をストリーミングしようとする際に問題が発生しました。再度お試しください。",
			generic_error_title: "不明なエラー",
			generic_error_description:
				"テキスト生成中に不明なエラーが発生しました。しばらくしてから再度お試しください。",
		},

		self_teach: {
			server_memory_learned_title:
				"🧠 Tomoriが新しいことを学びました（サーバー全体！）",
			server_memory_learned_description:
				'私たちのサーバーについてこれを学びました："{memory_content}"',
			personal_memory_learned_title: "💡 Tomoriがユーザーについて学びました！",
			personal_memory_learned_description:
				'{user_nickname}についてこれを学びました："{memory_content}"',
			server_memory_footer:
				"サーバー管理者は `/teach` と `/unlearn` コマンドを使用してこの記憶を管理できます。",
			personal_memory_footer_manage:
				"`/teach` と `/unlearn` コマンドを使用して個人の記憶を管理できます。",
			personal_memory_footer_personalization_disabled:
				"注意：この記憶は保存されましたが、このサーバーでは現在パーソナライゼーション機能が無効になっているため、ここでは即座に効果がありません。",
			personal_memory_footer_user_blacklisted:
				"注意：この記憶は保存されましたが、該当ユーザーは現在このサーバーでパーソナライゼーション機能からブラックリストに登録されています。",
		},
	},

	functions: {
		// Locales for built-in functions (e.g., image search)
		scrapeBooru: {
			title: `Booru検索`,
			description: `\`{query}\` の最大4つのランダムな「SFW」高品質投稿を素早く取得
フィルタリングされたクエリ：\`{filtered_query}\``,
			error_not_nsfw: `申し訳ありませんが、このコマンドはNSFWチャンネルでのみ使用できます！`,
			error_no_results: `ごめんなさい、\`{query}\` の投稿が見つかりませんでした。
別のプロンプトを試すか、\`/rule34\` を代わりに試してください！`,
			progress_message: `投稿をダウンロードしてランダムにアップロード中...`,
			query_comparison_title: `検索クエリ翻訳`,
			query_comparison_description: `あなたのタグ：\`{original}\`
検索対象：\`{filtered}\``,
			result_title: `元：{source}`,
			result_original: `（ソースが提供されていません）`,
			result_footer: `スコア：{score} | タグ：{tags}`,
		},
		generateImage: {
			description: `Stable Diffusionを使用してプロンプトから画像を素早く生成！`,
			progress: `🎨 \`{prompt}\` の画像を生成中...`,
			result: `✨ \`{prompt}\` に対して生成したものがこちらです (b ᵔ▽ᵔ)b`,
			error: `🚫 画像の生成中に問題が発生しました。後でもう一度お試しください。`,
		},
	},

	commands: {
		// General utility commands
		tool: {
			ping: {
				description: `ボットのレイテンシを確認します。`,
				title: `ポン！`,
				description_content: `現在のpingは {ping}ms です。`,
				response_fast: `ポン！ 🏓
応答時間：\`{response_time}ms\`
Discord APIレイテンシ：\`{discord_response}ms\``,
				response_slow: `ポン！ 🐢 （少し遅いです...）
応答時間：\`{response_time}ms\`
Discord APIレイテンシ：\`{discord_response}ms\``,
			},
			refresh: {
				description: `Tomoriの最近の会話履歴をクリアします。`,
				title: `会話履歴がクリアされました`,
				response: `🧹 わかりました、最近のチャットの短期記憶をクリアしました！新しく始めましょう。（このメッセージは更新を示します）`,
			},
			status: {
				description: `Tomoriの現在の設定またはパーソナリティステータスを表示します。`,
				type_description: `どのステータス項目を表示しますか？`,
				type_choice_config: `設定`,
				type_choice_personality: `パーソナリティ`,
				config_title: `Tomori設定ステータス`,
				config_description: `Tomoriの現在の運用設定。`,
				personality_title: `Tomoriパーソナリティステータス`,
				personality_description: `Tomoriの現在のパーソナリティ設定。`,
				field_model: `AIモデル`,
				field_temperature: `温度`,
				field_humanizer: `ヒューマナイザーレベル`,
				field_autoch_threshold: `自動チャット閾値`,
				field_autoch_channels: `自動チャットチャンネル`,
				field_trigger_words: `トリガーワード`,
				field_personalization: `パーソナライゼーション`,
				field_self_teach: `自己学習`,
				field_api_key_set: `APIキー設定`,
				field_nickname: `ニックネーム`,
				field_dialogue_count: `サンプル対話`,
				field_server_memory_count: `サーバー記憶`,
				field_attributes: `属性`,
				item_count: `{count} アイテム`,
				none: `なし`,
				disabled: `無効`,
				unknown_channel: `不明なチャンネルID：`,
				not_available: `N/A`,
			},
		},

		// Configuration commands (Admin only)
		config: {
			options: {
				// General options for config subcommands
				add: `追加`,
				remove: `削除`,
				enable: `有効`,
				disable: `無効`,
			},
			triggeradd: {
				description: `メンションされたときにTomoriが反応する単語を追加します。`,
				word_description: `トリガーとして追加する単語。`,
				too_short_title: `トリガーワードが短すぎます`,
				too_short_description: `トリガーワードは最低2文字必要です。`,
				already_exists_title: `トリガーワードが存在します`,
				already_exists_description: `単語 \`{word}\` は既にトリガーリストにあります。`,
				success_title: `トリガーワードが追加されました`,
				success_description: `\`{word}\` をトリガーワードとして正常に追加しました。現在 {word_count} 個のトリガーワードがあります。`,
			},
			autochchannels: {
				description: `Tomoriが自動的にチャットするチャンネルを追加または削除します。`,
				channel_description: `追加または削除するテキストチャンネル。`,
				action_description: `チャンネルを追加するか削除するか。`,
				invalid_channel_title: `無効なチャンネルタイプ`,
				invalid_channel_description: `標準のテキストチャンネルを選択してください。`,
				already_added_title: `チャンネルが既に追加されています`,
				already_added_description: `チャンネル \`{channel_name}\` は既に自動チャットリストにあります。`,
				not_in_list_title: `チャンネルが見つかりません`,
				not_in_list_description: `チャンネル \`{channel_name}\` は自動チャットリストにありません。`,
				added_title: `自動チャットチャンネルが追加されました`,
				added_description: `\`{channel_name}\` を自動チャットチャンネルに正常に追加しました。`,
				removed_title: `自動チャットチャンネルが削除されました`,
				removed_description: `\`{channel_name}\` を自動チャットチャンネルから正常に削除しました。`,
			},
			autochthreshold: {
				description: `Tomoriが自動チャットするメッセージ数の閾値を設定します（0で無効）。`,
				threshold_description_v2: `自動チャット前に必要なメッセージ数（0で無効、または30-100）。`,
				invalid_range_title: `無効な閾値`,
				invalid_range_specific_description: `閾値は正確に \`{min}\`（無効にする場合）または \`{range_start}\` から \`{max}\` の間である必要があります。`,
				success_title: `自動チャット閾値が設定されました`,
				success_description: `Tomoriは指定されたチャンネルで \`{threshold}\` メッセージ後に自動的にチャットするようになります。`,
				success_disabled_title: `自動チャットが無効になりました`,
				success_disabled_description: `自動チャット機能が無効になりました（閾値が \`{threshold}\` に設定されました）。`,
			},
			blacklist: {
				description: `メンバーをパーソナライゼーションブラックリストに追加または削除します。`,
				member_description: `ブラックリストに追加または削除するメンバー。`,
				action_description: `メンバーを追加するか削除するか。`,
				personalization_disabled_title: `パーソナライゼーションが無効です`,
				personalization_disabled_description: `現在、サーバー全体でパーソナライゼーションが無効になっています。最初に \`/config personalization\` で有効にしてください。`,
				already_blacklisted_title: `既にブラックリストに登録されています`,
				already_blacklisted_description: `\`{user_name}\` は既にパーソナライゼーションブラックリストにあります。`,
				not_blacklisted_title: `ブラックリストに登録されていません`,
				not_blacklisted_description: `\`{user_name}\` はパーソナライゼーションブラックリストにありません。`,
				added_title: `メンバーがブラックリストに登録されました`,
				added_description: `\`{user_name}\` をパーソナライゼーションブラックリストに追加しました。彼らの個人記憶とニックネームは使用されません。`,
				removed_title: `メンバーのブラックリスト登録が解除されました`,
				removed_description: `\`{user_name}\` をパーソナライゼーションブラックリストから削除しました。彼らの個人記憶とニックネームが使用できるようになります。`,
			},
			humanizerdegree: {
				description: `Tomoriの応答がどの程度「人間らしく」感じるかを設定します。`,
				value_description: `ヒューマナイゼーションのレベル（0=なし、1=プロンプト、2=タイピング/チャンク、3=小文字/句読点なし）。`,
				choice_none: `0: なし（生AI出力）`,
				choice_light: `1: 軽微（プロンプト注入 - デフォルト）`,
				choice_medium: `2: 中程度（タイピングシミュレーション&チャンク）`,
				choice_heavy: `3: 重度（小文字&句読点なし）`,
				invalid_value_title: `無効な値`,
				invalid_value_description: `ヒューマナイザー度は {min} から {max} の間である必要があります。`,
				already_set_title: `ヒューマナイザーが既に設定されています`,
				already_set_description: `ヒューマナイザー度は既に \`{value}\` に設定されています。`,
				success_title: `ヒューマナイザー度が更新されました`,
				success_description: `ヒューマナイザー度が \`{previous_value}\` から \`{value}\` に変更されました。`,
			},
			memberpermissions: {
				description: `非管理者メンバーがTomoriに教えることができることを設定します。`,
				option_description: `メンバーが教えることができる記憶の種類。`,
				servermemories_option: `サーバー記憶`,
				attributelist_option: `属性リスト`,
				sampledialogues_option: `サンプル対話`,
				set_description: `メンバーにこの権限を有効または無効にします。`,
				success_title: `メンバー権限が更新されました`,
				enabled_success: `メンバーが教えることができるようになりました：\`{permission_type}\`。`,
				disabled_success: `メンバーはもう教えることができません：\`{permission_type}\`。`,
			},
			model: {
				description: `Tomoriが使用する基盤AIモデルを変更します。`,
				name_description: `希望するGeminiモデルを選択します。`,
				no_models_title: `モデルが見つかりません`,
				no_models_description: `データベースから利用可能なAIモデルを読み込めませんでした。`,
				invalid_model_title: `無効なモデル`,
				invalid_model_description: `選択されたモデル名は有効でないか利用できません。`,
				already_selected_title: `モデルが既に選択されています`,
				already_selected_description: `Tomoriは既に \`{model_name}\` モデルを使用しています。`,
				success_title: `モデルが更新されました`,
				success_description: `Tomoriは \`{model_name}\` モデルを使用するようになります（以前は \`{previous_model}\`）。`,
			},
			nickname: {
				description: `Tomoriが自分自身に使用する名前を変更します。`,
				option_description: `Tomoriの新しいニックネーム（2-32文字）。`,
				invalid_length_title: `無効なニックネームの長さ`,
				invalid_length_description: `ニックネームは {min} から {max} 文字の間である必要があります。`,
				success_title: `ニックネームが更新されました`,
				success_description: `Tomoriのニックネームが \`{old_nickname}\` から \`{new_nickname}\` に変更されました。`,
			},
			apikeydelete: {
				description: `現在設定されているGemini APIキーを削除します。`,
				no_key_title: `APIキーが設定されていません`,
				no_key_description: `削除する現在設定されているAPIキーがありません。`,
				success_title: `APIキーが削除されました`,
				success_description: `Gemini APIキーが正常に削除されました。新しいキーが設定されるまでTomoriは応答を停止します。`,
			},
			triggerdelete: {
				description: `メンションされたときにTomoriが反応する単語を削除します。`,
				no_triggers_title: `トリガーワードがありません`,
				no_triggers_description: `削除するカスタムトリガーワードが設定されていません。\`/config triggeradd\` でいくつか追加してください。`,
				select_title: `トリガーワードを削除`,
				select_description: `削除したいトリガーワードを選択してください：

{items}`,
				trigger_words_label: `トリガーワード`,
			},
			apikeyset: {
				description: `このサーバーのGoogle Gemini APIキーを設定します。`,
				key_description: `あなたのGoogle Gemini APIキー。`,
				invalid_key_title: `無効なAPIキー形式`,
				invalid_key_description: `提供されたAPIキーが短すぎるか無効のようです。有効なキーを提供してください。`,
				validating_key: `GoogleでAPIキーを検証中...`,
				key_validation_failed_title: `APIキー検証に失敗しました`,
				key_validation_failed_description: `提供されたAPIキーはGoogleによると有効ではありません。キーを確認して再度お試しください。`,
				success_title: `APIキーが設定されました`,
				success_description: `Google Gemini APIキーが正常に検証、暗号化、保存されました。`,
			},
			braveapiset: {
				description: `このサーバーのBrave Search APIキーを設定します。`,
				key_description: `あなたのBrave Search APIキー。`,
				invalid_key_title: `無効なAPIキー形式`,
				invalid_key_description: `提供されたAPIキーが短すぎるか無効のようです。有効なキーを提供してください。`,
				storing_key: `暗号化されたBrave Search APIキーを保存中...`,
				success_title: `Brave APIキーが設定されました`,
				success_description: `Brave Search APIキーが正常に暗号化され、保存されました。`,
			},
			braveapidelete: {
				description: `現在設定されているBrave Search APIキーを削除します。`,
				no_key_title: `Brave APIキーが設定されていません`,
				no_key_description: `削除する現在設定されているBrave Search APIキーがありません。`,
				success_title: `Brave APIキーが削除されました`,
				success_description: `Brave Search APIキーが正常に削除されました。`,
			},
			setup: {
				description: `Tomoriの初期設定プロセスを開始します。`,
				no_presets_found: `エラー：あなたの言語のパーソナリティプリセットが見つかりません。設定を続行できません。`,
				modal_title: `Tomori初期設定`,
				api_key_label: `Google Gemini APIキー`,
				preset_label: `パーソナリティプリセット名`,
				humanizer_label: `ヒューマナイザーレベル（0-3）`,
				api_key_invalid: `エラー：提供されたAPIキーが短すぎるか無効です。`,
				api_key_validating: `GoogleでAPIキーを検証中...`,
				api_key_invalid_api: `エラー：GoogleがAPIキーを拒否しました。正しいことを確認し、Gemini APIが有効になっていることを確認してください。`,
				preset_invalid: `エラー：無効なプリセット名です。利用可能なプリセット名のいずれかを正確に入力してください：{available}`,
				humanizer_invalid: `エラー：無効なヒューマナイザーレベルです。0から3の間の数字を入力してください。`,
				config_invalid: `エラー：内部設定検証に失敗しました。これを報告してください。`,
				setup_failed_description: `エラー：初期設定構成をデータベースに保存できませんでした。再度お試しください。`,
				success_title: `🎉 Tomori設定完了！ 🎉`,
				success_desc: `Tomoriがこのサーバーで設定されました。概要は以下の通りです：`,
				preset_field: `パーソナリティプリセット`,
				humanizer_field: `ヒューマナイザーレベル`,
				name_field: `Tomoriの名前`,
				modal_timeout: `設定がタイムアウトしました。再度 \`/config setup\` を実行してください。`,
				already_setup_title: `Tomoriは既に設定されています`,
				already_setup_description: `Tomoriは既にこのサーバーで設定されています。Tomoriの設定を変更するには、\`/config humanizerdegree\`、\`/config temperature\`、\`/teach attribute\` などの他のコマンドを使用してください。`,
			},
			temperature: {
				description: `Tomoriの応答の創造性/ランダム性を設定します（0.1-2.0）。`,
				value_description: `1.0（予測可能）から2.0（非常にランダム）の間の値。デフォルト：1.5。`,
				invalid_value_title: `無効な温度`,
				invalid_value_description: `温度は {min} から {max} の間である必要があります。`,
				already_set_title: `温度が既に設定されています`,
				already_set_description: `温度は既に \`{temperature}\` に設定されています。`,
				success_title: `温度が更新されました`,
				success_description: `LLM温度が \`{previous_temperature}\` から \`{temperature}\` に変更されました。`,
			},
			preset: {
				description: `Tomoriにプリセットパーソナリティ設定を適用します`,
				no_presets_title: `利用可能なプリセットがありません`,
				no_presets_description: `あなたの言語で利用可能なパーソナリティプリセットがありません。ボット管理者に連絡してください。`,
				select_title: `パーソナリティプリセットを選択`,
				select_description: `Tomoriに適用するプリセットを選択してください。

⚠️ **警告：** これにより現在の属性リストとサンプル対話が上書きされます！

{items}`,
				preset_label: `プリセット`,
				success_title: `プリセットが適用されました`,
				success_description: `'{preset}' プリセットをTomoriに正常に適用しました。`,
			},
			tomoripermissions: {
				description: `このサーバーでのTomoriのコア動作権限を設定します。`,
				option_description: `設定する特定のTomori権限。`,
				selfteaching_option: `自己学習`,
				personalization_option: `パーソナライゼーション（記憶/ニックネーム）`,
				emojiusage_option: `絵文字使用`,
				stickerusage_option: `スタンプ使用`,
				websearch_option: "Web検索権限",
				set_description: `Tomoriにこの権限を有効または無効にします。`,
				already_set_title: `権限が既に設定されています`,
				already_enabled_description: `権限 \`{permission_type}\` は既に**有効**です。`,
				already_disabled_description: `権限 \`{permission_type}\` は既に**無効**です。`,
				success_title: `Tomori権限が更新されました`,
				enabled_success: `Tomoriの \`{permission_type}\` 権限が**有効**になりました。`,
				disabled_success: `Tomoriの \`{permission_type}\` 権限が**無効**になりました。`,
			},
		},

		// Commands for teaching Tomori
		teach: {
			sampledialogue: {
				description: `Tomoriの記憶にサンプルユーザー/ボット対話ペアを追加します。`,
				teaching_disabled_title: `サンプル対話教育が無効です`,
				teaching_disabled_description: `このサーバーではメンバーがサンプル対話を教えることは現在許可されていません。管理者が \`/config memberpermissions\` を使用してこれを有効にできます。`,
				modal_title: `サンプル対話を追加`,
				user_input_label: `ユーザーのセリフ`,
				bot_input_label: `Tomoriの応答`,
				success_title: `サンプル対話が追加されました`,
				success_description: `新しいサンプル対話ペアを正常に追加しました：

**ユーザー:**
> {user_input}

**Tomori:**
> {bot_input}`,
			},
			attribute: {
				description: `Tomoriの記憶にパーソナリティ属性を追加します。`,
				teaching_disabled_title: `属性教育が無効です`,
				teaching_disabled_description: `このサーバーではメンバーがパーソナリティ属性を教えることは現在許可されていません。管理者が \`/config memberpermissions\` を使用してこれを有効にできます。`,
				modal_title: `パーソナリティ属性を追加`,
				attribute_input_label: `新しい属性`,
				duplicate_title: `重複する属性`,
				duplicate_description: `この属性 '{attribute}' は既にTomoriの属性リストにあります。`,
				success_title: `属性が追加されました`,
				success_description: `'{attribute}' をTomoriのパーソナリティ属性に正常に追加しました。`,
			},
			servermemory: {
				description: `Tomoriの知識にサーバー記憶を追加します。`,
				teaching_disabled_title: `サーバー記憶教育が無効です`,
				teaching_disabled_description: `このサーバーではメンバーがサーバー記憶を追加することは現在許可されていません。管理者が \`/config memberpermissions\` を使用してこれを有効にできます。`,
				modal_title: `サーバー記憶を追加`,
				memory_input_label: `新しいサーバー記憶`,
				duplicate_title: `重複する記憶`,
				duplicate_description: `この記憶 '{memory}' は既にTomoriのサーバー記憶にあります。`,
				limit_exceeded_title: `サーバー記憶の上限に達しました`,
				limit_exceeded_description: `このサーバーは記憶の上限である {max_allowed} 件に達しています（現在 {current_count} 件）。新しい記憶を追加する前に、\`/unlearn servermemory\` を使用していくつかの記憶を削除してください。`,
				content_too_long_title: `記憶の内容が長すぎます`,
				content_too_long_description: `記憶の内容が長すぎます。最大許可文字数は {max_length} 文字です。`,
				success_title: `サーバー記憶が追加されました`,
				success_description: `'{memory}' をTomoriのサーバー記憶に正常に追加しました。`,
			},
			personalmemory: {
				description: `あなただけが見ることができる個人記憶を追加します。`,
				modal_title: `個人記憶を追加`,
				memory_input_label: `新しい個人記憶`,
				duplicate_title: `重複する個人記憶`,
				duplicate_description: `この記憶 '{memory}' は既にあなたの個人記憶にあります。`,
				limit_exceeded_title: `個人記憶の上限に達しました`,
				limit_exceeded_description: `あなたは個人記憶の上限である {max_allowed} 件に達しています（現在 {current_count} 件）。新しい記憶を追加する前に、\`/unlearn personalmemory\` を使用していくつかの記憶を削除してください。`,
				content_too_long_title: `記憶の内容が長すぎます`,
				content_too_long_description: `記憶の内容が長すぎます。最大許可文字数は {max_length} 文字です。`,
				success_title: `個人記憶が追加されました`,
				success_description: `'{memory}' をあなたの個人記憶に正常に追加しました。`,
				success_but_disabled_description: `'{memory}' をあなたの個人記憶に正常に追加しました。

**警告：** このサーバーでは現在パーソナライゼーションが無効になっているため、この記憶はここでは使用されません。パーソナライゼーションが有効な他のサーバーでは引き続き利用できます。`,
			},
			nickname: {
				description: `Tomoriがあなたを呼ぶ名前を変更します。`,
				option_description: `Tomoriがあなたに使用するニックネーム（2-32文字）。`,
				invalid_length_title: `無効なニックネームの長さ`,
				invalid_length: `ニックネームは {min} から {max} 文字の間である必要があります。`,
				success_title: `個人ニックネームが更新されました`,
				success_description: `わかりました、これからあなたを '{new_nickname}' とお呼びします（以前は '{old_nickname}'）。`,
				success_but_disabled_description: `わかりました、あなたを '{new_nickname}' とお呼びすることを覚えておきます（以前は '{old_nickname}'）。

**警告：** このサーバーでは現在パーソナライゼーションが無効になっているため、ここではこのニックネームを使用しません。パーソナライゼーションが有効な他のサーバーでは引き続き使用します。`,
			},
		},

		// Commands for making Tomori unlearn things
		unlearn: {
			sampledialogue: {
				description: `Tomoriの記憶からサンプルユーザー/ボット対話ペアを削除します。`,
				no_dialogues_title: `サンプル対話がありません`,
				no_dialogues: `削除する保存されたサンプル対話がありません。\`/teach sampledialogue\` でいくつか追加してください。`,
				select_title: `サンプル対話を削除`,
				select_description: `削除したい対話ペアを選択してください：

{items}`,
				dialogue_label: `対話ペア`,
			},
			attribute: {
				description: `Tomoriの記憶からパーソナリティ属性を削除します。`,
				no_attributes_title: `属性がありません`,
				no_attributes: `削除するパーソナリティ属性がありません。\`/teach attribute\` でいくつか追加してください。`,
				select_title: `属性を削除`,
				select_description: `削除したい属性を選択してください：

{items}`,
				attribute_label: `属性`,
			},
			servermemory: {
				description: `Tomoriの知識からサーバー記憶を削除します。`,
				no_memories_title: `サーバー記憶がありません`,
				no_memories: `このサーバーに保存されたサーバー記憶がありません。\`/teach servermemory\` でいくつか追加してください。`,
				select_title: `サーバー記憶を削除`,
				select_description: `削除したいサーバー記憶を選択してください：

{items}`,
				memory_label: `サーバー記憶`,
			},
			personalmemory: {
				description: `個人記憶を削除します。`,
				no_memories_title: `個人記憶がありません`,
				no_memories: `保存された個人記憶がありません。\`/teach personalmemory\` でいくつか追加してください。`,
				select_title: `個人記憶を削除`,
				select_description: `削除したい個人記憶を選択してください：

{items}`,
				memory_label: `個人記憶`,
				warning_disabled_title: `パーソナライゼーションが無効です`,
				warning_disabled_description: `記憶はあなたのプロフィールから正常に削除されました。

**警告：** このサーバーでは現在パーソナライゼーションが無効になっているため、この変更はここでのTomoriの動作に影響しません。パーソナライゼーションが有効な他のサーバーでは引き続き反映されます。`,
			},
		},
	},

	events: {
		// Messages related to the main chat event handler
		tomoriChat: {
			setup_required_title: `ボット設定が必要です`,
			setup_required_description: `チャット機能を使用するには、以下を設定してください：
• \`/teach convo\` を使用して最低2つの会話例
• \`/teach info\` を使用して最低1つの情報エントリ
ボットのパーソナリティプリセットを簡単に選択するために \`/setup\` を使用することもできます。`,
			safety_error_title: `安全フィルターが作動しました`,
			safety_error_description: `🚫 Geminiの安全フィルターが応答をブロックしました。これは通常、コンテンツがGoogleの安全措置に違反する可能性がある場合に発生します。`,
			dm_not_supported_title: `DMではTomoriを利用できません`,
			dm_not_supported_description: `Tomoriはダイレクトメッセージではなく、サーバーでのみ使用できます。`,
			api_key_missing_title: `APIキーがありません`,
			api_key_missing_description: `Tomoriが動作するにはAPIキーが必要です。サーバー管理者に \`/config apikeyset\` コマンドを使用して設定を依頼してください。`,
			api_key_error_title: `APIキーエラー`,
			api_key_error_description: `APIキーに問題がありました。サーバー管理者に \`/config apikeyset\` コマンドを使用して確認またはリセットを依頼してください。`,
			generation_error_title: `応答生成エラー`,
			generation_error_description: `応答を生成する際にエラーが発生しました。後でもう一度お試しください。`,
			context_error_title: `コンテキスト構築エラー`,
			context_error_description: `この会話のコンテキストを構築する際にエラーが発生しました。後でもう一度お試しください。`,
			critical_error_title: `予期しないエラー`,
			critical_error_description: `問題が発生しました。後でもう一度お試しいただくか、問題が続く場合はサポートに連絡してください。`,
		},

		// Messages for when the bot is added to a server
		addBot: {
			rejoin_title: `戻ってきました！`,
			rejoin_description: `こんにちは！このサーバーに再追加されたようですね。以前の設定とパーソナリティはそのまま残っています！\`/teach\` と \`/unlearn\` コマンドを使用して私を管理できます。`,
			setup_prompt_title: `TomoriBotを追加していただきありがとうございます！`,
			setup_prompt_description: `こんにちは！追加していただきありがとうございます！開始するには、**サーバーの管理**権限を持つ誰かが私の \`/setup\` コマンドを実行して、初期パーソナリティを選択し、AI機能を設定する必要があります。`,
		},
	},
};
