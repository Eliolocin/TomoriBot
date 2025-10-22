// locales/ja.ts

// ロケール構造全体をデフォルトオブジェクトとしてエクスポートします
export default {
	general: {
		// クールダウンメッセージ
		cooldown_title: `⌛ お待ちください！`,
		cooldown: `再度 \`/{category}\` コマンドを使用するまで {seconds} 秒待つ必要があります。`,

		// 標準的なインタラクションの応答（ボタン、セレクトメニュー）
		interaction: {
			cancel_title: `❌ コマンドがキャンセルされました`,
			cancel_description: `コマンドはキャンセルされました。`,
			timeout_title: `⏰ コマンドがタイムアウトしました`,
			timeout_description: `時間内に応答しませんでした。もう一度お試しください。`,
		},

		// ページネーションコンポーネントのメッセージ
		pagination: {
			page_info: `ページ {current}/{total}`,
			previous: `前へ`,
			next: `次へ`,
			cancel: `キャンセル`,
			no_items: `表示する項目がありません。`,
			cancelled: `選択はキャンセルされました。`,
			timeout: `時間内に選択しませんでした。もう一度お試しください。`,
			item_selected: `選択済み: {item}`,
			select_page_title: `ページを選択`,
			select_page_description: `{totalItems}項目から{totalPages}ページ中の表示するページを選択してください：`,
		},

		// 一般的なエラーメッセージ
		errors: {
			guild_only_title: `サーバー専用コマンド`,
			guild_only_description: `このコマンドはサーバー内でのみ使用できます。`,
			channel_only_title: `チャンネルが必要です`,
			channel_only_description: `このコマンドは正常に動作するためにチャンネルが必要です。`,
			dm_not_supported_title: `DMはサポートされていません`,
			dm_not_supported_description: `申し訳ありませんが、ダイレクトメッセージではなく、サーバーチャンネル内でのみチャットできます。これは将来変更されるかもしれませんが、今のところサーバーでのみ動作します！`,
			tomori_not_setup_title: `初期設定が必要です`,
			tomori_not_setup_description: `このサーバーではまだ私の設定が行われていないようです。\`サーバー管理\`権限を持つメンバーが最初に\`/config setup\`を使用する必要があります。`,
			tomori_not_setup_dm_footer: `注：DMは「ミニサーバー」として扱われ、私はあなたのメッセージに個人的に応答します。すべてのサーバー関連コマンドは意図通りに動作し、DM内では\`サーバー管理\`権限は必要ありません。`,
			api_key_missing_title: `APIキーがありません`,
			api_key_missing_description: `機能するにはAPIキーが必要ですが、このサーバーには設定されていません。\`サーバー管理\`権限を持つメンバーが\`/config apikeyset\`を使用して設定できます。`,
			api_key_error_title: `APIキーエラー`,
			api_key_error_description: `設定されたAPIキーへのアクセスまたは復号化で問題が発生しました。\`/config apikeyset\`を使用して正しく設定されているか確認してください。`,
			context_error_title: `コンテキスト構築エラー`,
			context_error_description: `会話のコンテキストを理解しようとしているときにエラーが発生しました。`,
			critical_error_title: `重大なエラー`,
			critical_error_description: `予期しない重大なエラーが発生しました。`,
			update_failed_title: `更新に失敗しました`,
			update_failed_description: `データベースの設定の更新に失敗しました。もう一度お試しください。`,
			unknown_error_title: `不明なエラー`,
			unknown_error_description: `予期しないエラーが発生しました。`,
			invalid_option_title: `無効なオプション`,
			invalid_option_description: `選択されたオプションは無効です。有効なオプションを選択してください。`,
			brave_api: {
				missing_key: {
					title: `Brave APIキーがありません`,
					description: `検索を実行するにはBrave Search APIキーが必要ですが、このサーバーには設定されていません。\`サーバー管理\`権限を持つメンバーが\`/config braveapiset\`で設定するか、\`/config botpermissions\`で無効にすることができます。`,
					footer: `無料のAPIキーを https://brave.com/search/api/ で取得できます`,
				},
			},
			duckduckgo_rate_limit: {
				title: `DuckDuckGoがレート制限されています`,
				description: `DuckDuckGo検索は現在レート制限されています。より信頼性の高い検索のために、\`サーバー管理\`権限を持つメンバーが\`/config braveapiset\`でBrave Searchを設定するか、\`/config botpermissions\`で無効にすることができます。`,
				footer: `無料のBrave Search APIキーを https://brave.com/search/api/ で取得できます`,
			},
			operation_failed_title: `操作に失敗しました`,
			operation_failed_description: `要求された操作を完了できませんでした。もう一度お試しください。`,
			provider_not_supported_title: `サポートされていないプロバイダー`,
			provider_not_supported_description: `選択されたAIプロバイダーは現在サポートされていません。`,
			user_blacklisted_title: `ユーザーがブラックリスト登録済み`,
			user_blacklisted_description: `あなたは現在このサーバーのパーソナライズ機能のブラックリストに登録されており、この操作を実行できません。`,
		},
		tomori_busy_title: "他の人に返信中です！",
		tomori_busy_replying:
			"現在このメッセージに返信中です: {message_link}。あなたのメッセージはキューに追加されました。",
	},

	genai: {
		// LLM API生成に関するエラー
		generic_error_title: `生成エラー`,
		generic_error_description: `申し訳ありません、応答を生成中にエラーが発生しました ({error_message})。`,
		generic_error_footer:
			"`/tool refresh`を実行してからもう一度お試しください。問題が解決しない場合は、`/support report`で報告してください。",
		error_stream_timeout_title: "接続タイムアウト",

		// プロバイダーエラー形式テンプレート
		provider_error_format:
			"{providerName} エラーコード {errorCode}: {apiMessage}。{tip}",
		error_stream_timeout_description:
			"この問題が続く場合、サービスに一時的な問題がある可能性があります。しばらくしてからリクエストを再試行するか、`/tools refresh`を使用してコンテキスト履歴をリフレッシュしてください。",

		// APIからの空の応答
		empty_response_title: `空の応答`,
		empty_response_description: `AIから空の応答を受け取りました。`,
		// 新規: 関数呼び出しの最大反復回数
		max_iterations_title: "思考ループ",
		max_iterations_streaming_description:
			"思考ループに陥り、リクエストを完了できませんでした。",

		// 検索関連メッセージ
		search: {
			web_search_title: `🔍 ウェブで \`{query}\` を検索中...`,
			image_search_title: `🔍 \`{query}\` の画像を検索中...`,
			video_search_title: `🔍 \`{query}\` の動画を検索中...`,
			news_search_title: `🔍 ニュースで \`{query}\` を検索中...`,
			disclaimer_description: `AIによる生成応答と検索結果は不正確または不完全な場合があります。**重要な情報は再確認してください**。`,
		},

		// YouTube動画処理メッセージ
		video: {
			youtube_processing_title: "👁️ YouTube動画を視聴中...",
			youtube_processing_description:
				"現在、YouTube動画を視聴しています: {video_url}",
			youtube_processing_footer:
				"動画の長さに応じて、少し時間がかかる場合があります",
		},

		// 新規: ストリーム固有のエラーメッセージ
		stream: {
			response_stopped_title: "応答が中断されました",
			response_stopped_description:
				"次の理由で応答が中断されました: {reason}。送信されたコンテンツがAIプロバイダーにとって大きすぎないか確認してください。`/tool refresh`で会話コンテンツをクリアしてください。",
			prohibited_content_title: "コンテンツポリシー違反",
			prohibited_content_description:
				"禁止コンテンツが検出されたため、応答はブロックされました。",
			prohibited_content_admin_notice_title: "管理者への通知",
			prohibited_content_admin_notice_description:
				"送信されたコンテンツ（メディア、会話メッセージ、記憶）がAIプロバイダーのコンテンツポリシーに準拠していることを確認してください。`/tool refresh`で会話コンテンツをクリアしてください。",
			streaming_failed_description:
				"応答をストリーミング中に問題が発生しました。",

			// エラーインタラクションメッセージ
			provider_error_interaction:
				"ストリーム応答がブロック/停止されました。理由: {reason}。",
			retry_message:
				"これは一時的なエラーです。リクエストを再度お試しいただけます。",

			// 汎用プロバイダーエラータイトルとヒント（genai.googleから移動）
			api_error_title: "❌ APIエラー",
			api_error_tip: "APIキーを確認して再度お試しください",

			rate_limit_title: "🟡 レート制限を超過",
			rate_limit_tip: "数分お待ちいただいてから再度お試しください",

			content_blocked_title: "🛡️ コンテンツがブロックされました",
			content_blocked_tip:
				"コンテンツポリシーに準拠するようメッセージを言い換えてください",

			timeout_title: "⏱️ リクエストタイムアウト",
			timeout_tip: "メッセージを短くするか再度お試しください",

			provider_overloaded_title: "🛑 プロバイダーの過負荷",
			provider_overloaded_tip:
				"プロバイダーが現在過負荷状態です、しばらく後に再度お試しください",

			unknown_title: "❓ プロバイダーエラー",
			unknown_tip:
				"再度お試しいただくか、この問題が続く場合は `/support report` をご利用ください",
		},

		// Google固有のエラーメッセージ（プロバイダー固有のデフォルトメッセージのみ）
		google: {
			// 400 INVALID_ARGUMENT
			"400_default_message": "リクエスト形式にエラーがありました",

			// 400 FAILED_PRECONDITION (billing)
			"400_billing_default_message": "このサービスには課金が必要です",

			// 403 PERMISSION_DENIED
			"403_default_message": "APIキーに必要な権限がありません",

			// 404 NOT_FOUND
			"404_default_message": "参照されたリソースが見つかりませんでした",

			// 429 RESOURCE_EXHAUSTED
			"429_default_message": "短時間に多くのリクエストを送信しすぎました",

			// 500 INTERNAL
			"500_default_message": "Googleのサーバーで予期しないエラーが発生しました",

			// 503 UNAVAILABLE
			"503_default_message": "AIモデルが現在過負荷状態です",

			// 504 DEADLINE_EXCEEDED
			"504_default_message": "リクエストの処理時間が長すぎました",

			// Content blocked errors
			content_blocked_default_message:
				"あなたのコンテンツは安全フィルターによってブロックされました",

			// Generic fallback for unknown Google errors
			unknown_default_message: "予期しないエラーが発生しました",
		},

		self_teach: {
			server_memory_learned_title: "🧠 新しいことを学びました！ (サーバー全体)",
			server_memory_learned_description:
				'このサーバーについて、次のことを学びました: "{memory_content}"',
			personal_memory_learned_title:
				"💡 新しいことを学びました！ (ユーザー固有)",
			personal_memory_learned_description:
				'{user_nickname}さんについて、次のことを学びました: "{memory_content}"',
			server_memory_footer:
				"サーバー管理者は`/teach`と`/unlearn`コマンドでこの記憶を管理できます。",
			personal_memory_footer_manage:
				"あなたの個人的な記憶は`/teach`と`/unlearn`コマンドで管理できます。",
			personal_memory_footer_personalization_disabled:
				"この記憶は保存されましたが、現在このサーバーではパーソナライズ機能が無効になっているため、すぐには効果がありません。",
			personal_memory_footer_user_blacklisted:
				"この記憶は保存されましたが、対象のユーザーは現在このサーバーのパーソナライズ機能のブラックリストに登録されているため、すぐには効果がありません。",
		},

		// テスト/プレースホルダーキー
		some_other: {
			title: `テスト GenAI 機能`,
		},
	},

	commands: {
		// 一般的なユーティリティコマンド
		tool: {
			ping: {
				description: `ボットの遅延を確認します。`,
				response_fast: `Pong! 🏓
応答時間: \`{response_time}ms\`
Discord API 遅延: \`{discord_response}ms\``,
				response_slow: `Pong! 🐢 (少し遅いです...)
応答時間: \`{response_time}ms\`
Discord API 遅延: \`{discord_response}ms\``,
			},
			refresh: {
				description: `最近の会話履歴をクリアします。`,
				title: `🧹 会話履歴がクリアされました`,
				response: `コンテキストがリフレッシュされました。これより上のすべてのメッセージは無視されます。`,
			},
			status: {
				description: `現在の個人またはサーバーのステータスを表示します。`,
				type_description: `どのステータスタイプを表示しますか？`,
				type_choice_personal: `個人`,
				type_choice_server: `サーバー`,
				personal_title: `個人ステータス`,
				personal_description: `あなたの個人設定と記憶`,
				server_title: `サーバーステータス`,
				server_description: `サーバー設定、人格、記憶`,
				field_model: `AIモデル`,
				field_temperature: `Temperature`,
				field_humanizer: `ヒューマナイザーレベル`,
				field_autoch_threshold: `自動チャット閾値`,
				field_autoch_channels: `自動チャットチャンネル`,
				field_trigger_words: `トリガーワード`,
				field_personalization: `パーソナライズ`,
				field_self_teach: `自己学習`,
				field_api_key_set: `APIキー設定済み`,
				field_emoji_usage: `絵文字使用`,
				field_sticker_usage: `スタンプ使用`,
				field_web_search: `ウェブ検索`,
				field_server_memteaching: `サーバー記憶の学習`,
				field_attribute_memteaching: `属性の学習`,
				field_sampledialogue_memteaching: `サンプル対話の学習`,
				field_nickname: `ニックネーム`,
				field_dialogue_count: `サンプル対話`,
				field_attributes: `属性`,
				field_user_nickname: `ユーザーニックネーム`,
				field_language_pref: `言語設定`,
				field_reminders_count: `アクティブなリマインダー`,
				field_personal_memories: `個人の記憶`,
				field_server_memories: `サーバーの記憶`,
				item_count: `{count} 件`,
				none: `なし`,
				disabled: `無効`,
				unknown_channel: `不明なチャンネルID:`,
				not_available: `N/A`,
				see_all_memories_prompt: `すべての記憶を表示するには \`/export\` コマンドを使用してください`,
				memories_omitted: `...他 {count} 件の記憶が省略されました`,
				export_footer: `完全な記憶を表示するには \`/export\` コマンドを使用してください`,
				export_footer_full: `すべての詳細を表示するには \`/export\` コマンドを使用してください`,
				field_personal_memories_with_count: `個人の記憶 ({current}/{max} 枠使用中)`,
				field_trigger_words_with_count: `トリガーワード ({current}/{max} 枠使用中)`,
				field_attributes_with_count: `属性 ({current}/{max} 枠使用中)`,
				field_server_memories_with_count: `サーバーの記憶 ({current}/{max} 枠使用中)`,
				field_dialogue_count_with_count: `サンプル対話 ({current}/{max} 枠使用中)`,
			},
		},

		// ヘルプコマンド
		help: {
			apikey: {
				title: `APIキーヘルプ`,
			},
		},

		// テスト/プレースホルダーコマンド
		some_feature: {
			title: `テスト機能`,
		},

		// ボットの手動制御コマンド
		bot: {
			respond: {
				description: `このチャンネルの最新メッセージに手動で応答をトリガーします。`,
				success_title: `手動応答がトリガーされました`,
				success_description: `このチャンネルの最新メッセージに応答しています...`,
			},
			reason: {
				description: `現在のAIプロバイダーの最も賢い推論モデルを使用して、オプションのクエリで応答します。`,
				query_description: `推論を集中させるためのオプションのクエリ。`,
				success_title: `推論モードが有効になりました`,
				success_description: `高度な推論を使用して応答します{query}...`,
				no_smart_model_title: `推論モデルが見つかりません`,
				no_smart_model_description: `現在のAIプロバイダーに推論モデルが見つかりませんでした。\`/config apikeyset\`を使用して、推論モデルをサポートするプロバイダーに切り替えてください。`,
			},
		},

		// 設定コマンド（管理者のみ）
		config: {
			options: {
				add: `追加`,
				remove: `削除`,
				enable: `有効化`,
				disable: `無効化`,
			},
			triggeradd: {
				description: `言及されたときに私が応答する単語を追加します。`,
				word_description: `トリガーとして追加する単語。`,
				too_short_title: `トリガーワードが短すぎます`,
				too_short_description: `トリガーワードは少なくとも2文字以上である必要があります。`,
				already_exists_title: `トリガーワードが存在します`,
				already_exists_description: `単語 \`{word}\` は既にトリガーリストにあります。`,
				limit_exceeded_title: `トリガーワード上限に達しました`,
				limit_exceeded_description: `このサーバーはトリガーワードの上限 {max_allowed} 個に達しました（現在 {current_count} 個）。新しいものを追加する前に、\`/config triggerdelete\`でいくつかのトリガーワードを削除してください。`,
				success_title: `トリガーワードが追加されました`,
				success_description: `\`{word}\` をトリガーワードとして正常に追加しました。現在 {word_count} 個のトリガーワードがあります。`,
			},
			autochchannels: {
				description: `私が自動的にチャットするチャンネルを追加または削除します。`,
				channel_description: `追加または削除するテキストチャンネル。`,
				action_description: `チャンネルを追加するか削除するか。`,
				invalid_channel_title: `無効なチャンネルタイプ`,
				invalid_channel_description: `標準のテキストチャンネルを選択してください。`,
				already_added_title: `チャンネルは既に追加されています`,
				already_added_description: `チャンネル \`{channel_name}\` は既に自動チャットリストにあります。`,
				not_in_list_title: `チャンネルが見つかりません`,
				not_in_list_description: `チャンネル \`{channel_name}\` は自動チャットリストにありません。`,
				added_title: `自動チャットチャンネルが追加されました`,
				added_description: `\`{channel_name}\` を自動チャットチャンネルに正常に追加しました。`,
				removed_title: `自動チャットチャンネルが削除されました`,
				removed_description: `\`{channel_name}\` を自動チャットチャンネルから正常に削除しました。`,
			},
			autochthreshold: {
				description: `私が自動チャットするためのメッセージ数の閾値を設定します（0で無効）。`,
				threshold_description_v2: `自動チャットまでのメッセージ数（0で無効、または30-100）。`,
				invalid_range_title: `無効な閾値`,
				invalid_range_specific_description: `閾値は正確に \`{min}\`（無効にする場合）または \`{range_start}\` と \`{max}\` の間でなければなりません。`,
				success_title: `自動チャット閾値が設定されました`,
				success_description: `指定されたチャンネルで \`{threshold}\` メッセージ後に自動的にチャットします。`,
				success_disabled_title: `自動チャットが無効になりました`,
				success_disabled_description: `自動チャット機能は現在無効です（閾値が \`{threshold}\` に設定されました）。`,
			},
			blacklist: {
				description: `パーソナライズのブラックリストにメンバーを追加または削除します。`,
				member_description: `ブラックリストに追加または削除するメンバー。`,
				action_description: `メンバーを追加するか削除するか。`,
				personalization_disabled_title: `パーソナライズが無効です`,
				personalization_disabled_description: `現在、サーバー全体でパーソナライズが無効になっています。まず \`/config botpermissions\` で有効にしてください。`,
				already_blacklisted_title: `既にブラックリストに登録されています`,
				already_blacklisted_description: `\`{user_name}\` は既にパーソナライズのブラックリストに登録されています。`,
				not_blacklisted_title: `ブラックリストに登録されていません`,
				not_blacklisted_description: `\`{user_name}\` はパーソナライズのブラックリストに登録されていません。`,
				added_title: `メンバーがブラックリストに登録されました`,
				added_description: `\`{user_name}\` をパーソナライズのブラックリストに追加しました。彼らの個人的な記憶とニックネームは使用されません。`,
				removed_title: `メンバーがブラックリストから解除されました`,
				removed_description: `\`{user_name}\` をパーソナライズのブラックリストから削除しました。彼らの個人的な記憶とニックネームが使用できるようになります。`,
				user_registration_failed_title: `ユーザー登録に失敗しました`,
				user_registration_failed_description: `データベースへのユーザー登録に失敗しました。もう一度お試しください。`,
				cannot_blacklist_bot_title: `ボットをブラックリスト登録できません`,
				cannot_blacklist_bot_description: `\`{user_name}\` はボットであり、パーソナライズのブラックリストに追加できません。`,
			},
			humanizerdegree: {
				description: `私の応答がどれだけ「人間らしい」か設定します。`,
				modal_title: `ヒューマナイザーレベルの設定`,
				select_label: `ヒューマナイザーレベル`,
				select_description: `私の応答がどれだけ人間らしく感じられるかを選択してください`,
				select_placeholder: `レベルを選択...`,
				choice_none: `0: なし (生のAI出力)`,
				choice_light: `1: ライト (プロンプトインジェクション)`,
				choice_medium: `2: ミディアム (タイピングシミュレーション＆チャンキング)`,
				choice_heavy: `3: ヘビー (小文字＆句読点なし - デフォルト)`,
				desc_none: `人間化なし。フォーマルなトーンと構造の標準的なAI応答。`,
				desc_light: `人間らしい応答ガイドラインを追加。絵文字を制限（0-2個）、簡潔な応答を優先。`,
				desc_medium: `ライト機能 + タイピングシミュレーションと自然な流れのためのメッセージチャンキングの改善。`,
				desc_heavy: `全機能 + カジュアルなテキスト処理（小文字、句読点の削減）でインフォーマルなトーンに。`,
				invalid_value_description: `ヒューマナイザーレベルは {min} から {max} の間でなければなりません。`,
				already_set_title: `ヒューマナイザーは既に設定済みです`,
				already_set_description: `ヒューマナイザーレベルは既に \`{value}\` に設定されています。`,
				success_title: `ヒューマナイザーレベルが更新されました`,
				success_description: `ヒューマナイザーレベルが \`{previous_value}\` から \`{value}\` に変更されました。`,
			},
			language: {
				description: `インターフェースの優先言語を設定します。`,
				value_description: `インターフェースの優先言語を選択してください。`,
				choice_english: `英語`,
				choice_japanese: `日本語`,
				invalid_value_title: `無効な言語`,
				invalid_value_description: `言語は次のいずれかでなければなりません: {supported}。`,
				already_set_title: `言語は既に設定済みです`,
				already_set_description: `あなたの言語設定は既に \`{value}\` に設定されています。`,
				success_title: `言語が更新されました`,
				success_description: `あなたのインターフェース言語が \`{previous_value}\` から \`{value}\` に変更されました。`,
			},
			memberpermissions: {
				description: `管理者以外のメンバーが私に何を教えられるかを設定します。`,
				option_description: `メンバーが教えることができる記憶の種類。`,
				servermemories_option: `サーバーの記憶`,
				attributelist_option: `属性リスト`,
				sampledialogues_option: `サンプル対話`,
				set_description: `メンバーに対してこの権限を有効または無効にします。`,
				success_title: `メンバー権限が更新されました`,
				enabled_success: `メンバーは \`{permission_type}\` を教えることができます。`,
				disabled_success: `メンバーはもう \`{permission_type}\` を教えることはできません。`,
				already_set_title: `権限は既に設定済みです`,
				already_enabled_description: `メンバーは既に \`{permission_type}\` を教えることが許可されています。`,
				already_disabled_description: `メンバーは既に \`{permission_type}\` を教えることが禁止されています。`,
			},
			model: {
				description: `私が使用する基盤となるAIモデルを変更します。`,
				modal_title: `AIモデルの選択`,
				select_label: `AIモデル`,
				select_description: `私が使用するAIモデルを選択してください`,
				select_placeholder: `モデルを選択...`,
				no_api_key_title: `APIキーが設定されていません`,
				no_api_key_description: `モデルを変更する前にAPIキーを設定する必要があります。まず \`/config apikeyset\` を使用してAPIキーを設定してください。`,
				no_models_title: `モデルが見つかりません`,
				no_models_description: `データベースから利用可能なAIモデルを読み込めませんでした。`,
				invalid_model_description: `選択されたモデル名は無効か、利用できません。`,
				already_selected_title: `モデルは既に選択済みです`,
				already_selected_description: `私は既に \`{model_name}\` モデルを使用しています。`,
				validating_api_key_compatibility: `新しいプロバイダーとのAPIキー互換性を検証中...`,
				api_key_incompatible_title: `APIキーに互換性がありません`,
				api_key_incompatible_description: `現在のAPIキーは{provider}の{model_name}モデルと互換性がありません。\`/config apikeyset\`を使用して{provider}の有効なAPIキーを設定してください。`,
				validation_error_title: `検証エラー`,
				validation_error_description: `APIキーの互換性検証中にエラーが発生しました。もう一度お試しください。`,
				success_title: `モデルが更新されました`,
				success_description: `これからは \`{model_name}\` モデルを使用します（以前は \`{previous_model}\`）。`,
			},
			apikeydelete: {
				description: `現在設定されているAIプロバイダーのAPIキーを削除します。`,
				no_key_title: `APIキーが設定されていません`,
				no_key_description: `現在削除するAPIキーが設定されていません。`,
				success_title: `APIキーが削除されました`,
				success_description: `AIプロバイダーのAPIキーが正常に削除されました。新しいキーが設定されるまで、私のチャット機能は無効になります。`,
			},
			triggerdelete: {
				description: `言及されたときに私が応答する単語を削除します。`,
				no_triggers_title: `トリガーワードがありません`,
				no_triggers_description: `削除するカスタムトリガーワードが設定されていません。\`/config triggeradd\`で追加してください。`,
				select_title: `トリガーワードの削除`,
				select_description: `削除したいトリガーワードを選択してください`,
				trigger_words_label: `トリガーワード`,
				modal_title: `トリガーワードの削除`,
				select_label: `トリガーワード`,
				select_placeholder: `削除するトリガーワードを選択してください`,
				success_title: `トリガーワードが削除されました`,
				success_description: `サーバー設定からトリガーワード「{triggerWord}」を正常に削除しました。`,
			},
			apikeyset: {
				description: `選択したAIプロバイダーのAPIキーを設定します。`,
				modal_title: `APIキーの設定`,
				provider_label: `AIプロバイダー`,
				provider_description: `APIキーに対応するAIプロバイダーを選択してください`,
				provider_placeholder: `プロバイダーを選択...`,
				api_key_label: `APIキー`,
				api_key_description: `選択したプロバイダーのAPIキーを入力してください。このキーは安全に保存されます。取得方法が不明な場合は、\`/help apikey\`コマンドを使用してください。`,
				api_key_placeholder: `ここにAPIキーを貼り付け...`,
				no_providers_title: `利用可能なプロバイダーがありません`,
				no_providers_description: `データベースに利用可能なAIプロバイダーがありません。ボットの管理者に連絡してください。`,
				invalid_key_title: `無効なAPIキー形式`,
				invalid_key_description: `提供されたAPIキーは短すぎるか無効のようです。有効なキーを提供してください。`,
				validating_key: `APIキーを検証中...`,
				unsupported_provider_title: `サポートされていないプロバイダー`,
				unsupported_provider_description: `プロバイダー「{provider}」は現在APIキーの検証をサポートしていません。`,
				validation_error_title: `検証エラー`,
				validation_error_description: `APIキーの検証中にエラーが発生しました。もう一度お試しください。`,
				key_validation_failed_title: `APIキーの検証に失敗しました`,
				key_validation_failed_description: `{provider}に対して提供されたAPIキーは無効です。キーを確認してもう一度お試しください。`,
				success_title: `APIキーが設定されました`,
				success_description: `{provider}のAPIキーが正常に検証、暗号化、保存されました。`,
			},
			braveapiset: {
				description: `このサーバーのBrave Search APIキーを設定します。`,
				key_description: `あなたのBrave Search APIキー。`,
				invalid_key_title: `無効なAPIキー形式`,
				invalid_key_description: `提供されたAPIキーは短すぎるか無効のようです。有効なキーを提供してください。`,
				validating_key: `Brave Search APIキーを検証中...`,
				validation_error_title: `APIキーの検証エラー`,
				validation_error_description: `Brave Search APIキーの検証中にエラーが発生しました。再度お試しいただくか、接続を確認してください。`,
				key_validation_failed_title: `Brave APIキーの検証に失敗しました`,
				key_validation_failed_description: `提供されたBrave Search APIキーは無効です。キーを確認してもう一度お試しください。`,
				success_title: `Brave APIキーが設定されました`,
				success_description: `Brave Search APIキーが正常に検証、暗号化、保存されました。`,
			},
			braveapidelete: {
				description: `現在設定されているBrave Search APIキーを削除します。`,
				no_key_title: `Brave APIキーが設定されていません`,
				no_key_description: `現在削除するBrave Search APIキーが設定されていません。`,
				success_title: `Brave APIキーが削除されました`,
				success_description: `Brave Search APIキーが正常に削除されました。`,
			},
			rename: {
				description: `このサーバーでの私の名前を変更します。`,
				option_description: `私の新しい名前（2〜32文字）。`,
				invalid_length_title: `無効な名前の長さ`,
				invalid_length: `名前は2〜32文字でなければなりません。`,
				already_set_title: `名前は既に設定済みです`,
				already_set_description: `私の名前は既に \`{nickname}\` に設定されています。`,
				success_title: `名前が更新されました`,
				success_description: `私の名前が \`{old_nickname}\` から \`{new_nickname}\` に変更されました。`,
				success_with_trigger_description: `私の名前が \`{old_nickname}\` から \`{new_nickname}\` に変更されました。トリガーワードもそれに合わせて更新されました。`,
				success_with_discord_description: `私の名前が \`{old_nickname}\` から \`{new_nickname}\` に変更され、サーバーのニックネームも更新されました！`,
				success_with_trigger_and_discord_description: `私の名前が \`{old_nickname}\` から \`{new_nickname}\` に変更されました。トリガーワードとサーバーのニックネームが更新されました！`,
				nickname_update_failed_footer: `注：サーバーのニックネーム更新に失敗しました（「ニックネームの変更」権限が必要な場合があります）。`,
				partial_success_title: `名前は更新されましたが問題あり`,
				partial_success_description: `私の名前は \`{new_nickname}\` に変更されましたが、一部のトリガーワードの更新に失敗しました。`,
			},
			setup: {
				description: `初期設定プロセスを開始します。`,
				no_presets_found: `エラー: あなたの言語用の人格プリセットが見つかりません。設定を続行できません。`,
				modal_title: `初期設定`,
				api_provider_label: `APIプロバイダー`,
				api_provider_description: `お好みのLLMのプロバイダーを選択してください`,
				api_provider_placeholder: `選択してください...`,
				api_key_label: `APIキー`,
				api_key_description: `選択したLLMプロバイダーのAPIキーを入力してください。このキーは安全に保存されます。取得方法が不明な場合は、\`/help apikey\`コマンドを使用してください。`,
				preset_label: `人格プリセット`,
				preset_description: `人格プリセットを選択してください`,
				preset_placeholder: `人格を選択...`,
				api_key_invalid: `エラー: 提供されたAPIキーは短すぎるか無効です。`,
				api_key_validating: `APIキーを検証中...`,
				api_key_invalid_api: `エラー: プロバイダーがAPIキーを拒否しました。正しいか確認してください。`,
				preset_invalid: `エラー: 無効なプリセット名です。利用可能なプリセット名を正確に入力してください: {available}`,
				config_invalid: `エラー: 内部設定の検証に失敗しました。これを報告してください。`,
				setup_failed_description: `エラー: 初期設定構成をデータベースに保存できませんでした。もう一度お試しください。`,
				modal_values_missing: `エラー: 必須入力項目の一部がセットアップフォームから受信されませんでした。もう一度セットアップコマンドをお試しください。`,
				success_title: `🎉 設定完了！`,
				success_desc: `このサーバー用に設定が完了しました。私の設定を変更するには、\`/config\`と\`/serverconfig\`コマンドを使用してください。 概要は以下の通りです:`,
				success_desc_dm: `このダイレクトメッセージ用に設定が完了しました。概要は以下の通りです:`,
				preset_field: `人格プリセット`,
				name_field: `私の名前`,
				dm_context_explanation_title: `ダイレクトメッセージについて`,
				dm_context_explanation: `このダイレクトメッセージでも「サーバー」として参照します。つまり、すべての「サーバー」機能が同じように動作しますが、私たちだけのプライベートな空間です！このダイレクトメッセージを私との1対1サーバーと考えてください。「サーバーメモリー」はここでのみの私の記憶です。`,
				already_setup_title: `既に設定済みです`,
				already_setup_description: `このサーバーでは既に設定が完了しています。設定を変更するには、\`/config humanizerdegree\`、\`/config temperature\`、\`/teach attribute\`などの他のコマンドを使用してください。

				プロバイダーを変更したい場合は、\`/config apikeyset\`コマンドを使用してください。`,
			},
			temperature: {
				description: `私の応答の創造性/ランダム性を設定します（0.1〜2.0）。`,
				value_description: `1.0（予測可能）から2.0（非常にランダム）の間の値。デフォルト: 1.5。`,
				invalid_value_title: `無効なTemperature`,
				invalid_value_description: `Temperatureは {min} から {max} の間でなければなりません。`,
				already_set_title: `Temperatureは既に設定済みです`,
				already_set_description: `Temperatureは既に \`{temperature}\` に設定されています。`,
				success_title: `Temperatureが更新されました`,
				success_description: `LLMのTemperatureが \`{previous_temperature}\` から \`{temperature}\` に変更されました。`,
			},
			preset: {
				description: `人格設定のプリセットを適用します`,
				modal_title: `人格プリセットの適用`,
				select_label: `人格プリセット`,
				select_description: `適用するプリセットを選択してください。これにより、現在の属性と対話が上書きされます。`,
				select_placeholder: `プリセットを選択...`,
				no_presets_title: `利用可能なプリセットがありません`,
				no_presets_description: `あなたの言語で利用可能な人格プリセットがありません。\`/support report\`で報告してください。`,
				preset_not_found: `選択されたプリセットが見つかりませんでした。`,
				success_title: `プリセットが適用されました`,
				success_description: `'{preset_name}'プリセットが正常に適用されました。`,
			},
			botpermissions: {
				description: `このサーバーでの私のコアな行動権限を設定します。`,
				option_description: `設定する特定の権限。`,
				selfteaching_option: `自己学習`,
				personalization_option: `パーソナライズ (記憶/ニックネーム)`,
				emojiusage_option: `絵文字の使用`,
				stickerusage_option: `スタンプの使用`,
				websearch_option: "ウェブ検索権限",
				set_description: `私のためにこの権限を有効または無効にします。`,
				already_set_title: `権限は既に設定済みです`,
				already_enabled_description: `権限 \`{permission_type}\` は既に**有効**です。`,
				already_disabled_description: `権限 \`{permission_type}\` は既に**無効**です。`,
				success_title: `権限が更新されました`,
				enabled_success: `\`{permission_type}\` の権限が**有効**になりました。`,
				disabled_success: `\`{permission_type}\` の権限が**無効**になりました。`,
			},
			avatar: {
				description: `このサーバー用のカスタムアバターを設定または削除します。`,
				image_description: `アバターとして設定する画像（空白にするとカスタムアバターを削除）`,
				success_title: `アバターが更新されました`,
				success_description: `このサーバー用のアバターの更新に成功しました。`,
				removed_title: `アバターがリセットされました`,
				removed_description: `このサーバー用のアバターをデフォルトにリセットしました。`,
				invalid_image_title: `無効な画像`,
				invalid_image_description: `有効な画像ファイルを提供してください。`,
				file_too_large_title: `ファイルサイズが大きすぎます`,
				file_too_large_description: `画像ファイルが大きすぎます。最大ファイルサイズは8MBです。`,
				invalid_format_title: `無効な形式`,
				invalid_format_description: `PNG、JPG、JPEG、またはGIF画像ファイルを提供してください。`,
				conversion_error_title: `変換エラー`,
				conversion_error_description: `画像の処理に失敗しました。別の画像ファイルを試してください。`,
				api_error_title: `APIエラー`,
				api_error_description: `Discord APIを通じてアバターの更新に失敗しました。後でもう一度お試しください。`,
			},
		},

		// Tomoriに教えるためのコマンド
		teach: {
			sampledialogue: {
				description: `私がどのように応答すべきかの例として、ユーザー/ボットの対話ペアを追加します。`,
				teaching_disabled_title: `サンプル対話の教育が無効です`,
				teaching_disabled_description: `現在、このサーバーではメンバーがサンプル対話を教える・取り除くことは許可されていません。\`サーバー管理\`権限を持つメンバーが\`/config memberpermissions\`でこれを有効にできます。`,
				modal_title: `サンプル対話の追加`,
				user_input_label: `ユーザーのセリフ`,
				user_input_description: `ボットへのサンプル質問`,
				user_input_placeholder: `好きな食べ物は何ですか？`,
				bot_input_label: `私の応答`,
				bot_input_description: `ボットがどのように応答すべきか`,
				bot_input_placeholder: `わ、わたしはマンゴーが好きです…`,
				limit_exceeded_title: `サンプル対話上限に達しました`,
				limit_exceeded_description: `このサーバーはサンプル対話の上限 {max_allowed} 個に達しました（現在 {current_count} 個）。新しいものを追加する前に、\`/unlearn sampledialogue\`でいくつかのサンプル対話を削除してください。`,
				success_title: `サンプル対話が追加されました`,
				success_description: `新しいサンプル対話ペアを正常に追加しました:

**ユーザー:**
> {user_input}

**私:**
> {bot_input}`,
			},
			attribute: {
				description: `このサーバーでの私を表す人格属性を追加します。`,
				teaching_disabled_title: `属性の教育が無効です`,
				teaching_disabled_description: `現在、このサーバーではメンバーが人格属性を教える・取り除くことは許可されていません。\`サーバー管理\`権限を持つメンバーが\`/config memberpermissions\`でこれを有効にできます。`,
				modal_title: `人格属性の追加`,
				modal_description: `このサーバーでの私の人格特性`,
				attribute_input_label: `新しい属性`,
				attribute_input_placeholder: `マンゴーが好き`,
				duplicate_title: `重複した属性`,
				duplicate_description: `この属性 '{attribute}' は既に私の属性リストにあります。`,
				limit_exceeded_title: `属性上限に達しました`,
				limit_exceeded_description: `このサーバーは属性の上限 {max_allowed} 個に達しました（現在 {current_count} 個）。新しいものを追加する前に、\`/unlearn attribute\`でいくつかの属性を削除してください。`,
				success_title: `属性が追加されました`,
				success_description: `'{attribute}' を私の人格属性に正常に追加しました。`,
			},
			servermemory: {
				description: `私の知識ベースにサーバーの記憶を追加します。`,
				teaching_disabled_title: `サーバーの記憶の教育が無効です`,
				teaching_disabled_description: `現在、このサーバーではメンバーがサーバーの記憶を追加・取り除くすることは許可されていません。\`サーバー管理\`権限を持つメンバーが\`/config memberpermissions\`でこれを有効にできます。`,
				modal_title: `サーバーの記憶の追加`,
				modal_description: `このサーバーだけで私が覚えている記憶`,
				memory_input_label: `新しいサーバーの記憶`,
				memory_input_placeholder: `このサーバーのメンバーはマンゴーが好き`,
				duplicate_title: `重複した記憶`,
				duplicate_description: `この記憶 '{memory}' は既にこのサーバーの私の記憶にあります。`,
				limit_exceeded_title: `サーバーの記憶の上限に達しました`,
				limit_exceeded_description: `このサーバーは記憶の上限 {max_allowed} 件に達しました（現在 {current_count} 件）。新しい記憶を追加する前に、\`/unlearn servermemory\`でいくつかの記憶を削除してください。`,
				content_too_long_title: `記憶の内容が長すぎます`,
				content_too_long_description: `記憶の内容が長すぎます。最大許容長は {max_length} 文字です。`,
				success_title: `サーバーの記憶が追加されました`,
				success_description: `'{memory}' を私のサーバーの記憶に正常に追加しました。`,
			},
			personalmemory: {
				description: `どのサーバーでも私が覚えているあなたの個人的な記憶を追加します。`,
				modal_title: `個人的な記憶の追加`,
				modal_description: `どのサーバーでも私が覚えているあなたの記憶`,
				memory_input_label: `新しい個人的な記憶`,
				memory_input_placeholder: `マンゴーが好き`,
				duplicate_title: `重複した個人的な記憶`,
				duplicate_description: `この記憶 '{memory}' は既にあなたの個人的な記憶にあります。`,
				limit_exceeded_title: `個人的な記憶の上限に達しました`,
				limit_exceeded_description: `あなたは個人的な記憶の上限 {max_allowed} 件に達しました（現在 {current_count} 件）。新しい記憶を追加する前に、\`/unlearn personalmemory\`でいくつかの記憶を削除してください。`,
				content_too_long_title: `記憶の内容が長すぎます`,
				content_too_long_description: `記憶の内容が長すぎます。最大許容長は {max_length} 文字です。`,
				success_title: `個人的な記憶が追加されました`,
				success_description: `'{memory}' をあなたの個人的な記憶に正常に追加しました。`,
				success_but_disabled_description: `'{memory}' をあなたの個人的な記憶に正常に追加しました。

**警告:** 現在、このサーバーではパーソナライズが無効になっているため、この記憶はここでは使用されません。パーソナライズが有効になっている他のサーバーでは引き続き利用可能です。`,
				success_but_blacklisted_description: `'{memory}' をあなたの個人的な記憶に正常に追加しました。

**警告:** あなたは現在、このサーバーのパーソナライズ機能のブラックリストに登録されているため、この記憶はここでは使用されません。ブラックリストに登録されていない他のサーバーでは引き続き利用可能です。`,
			},
			nickname: {
				description: `私があなたを呼ぶ名前を変更します。`,
				option_description: `私があなたに使用すべきニックネーム（2〜32文字）。`,
				invalid_length_title: `無効なニックネームの長さ`,
				invalid_length: `ニックネームは {min}〜{max} 文字でなければなりません。`,
				success_title: `個人的なニックネームが更新されました`,
				success_description: `わかりました、これからはあなたのことを '{new_nickname}' と呼びます（以前は '{old_nickname}' でした）。`,
				success_but_disabled_description: `わかりました、あなたのことを '{new_nickname}' と呼ぶことを覚えておきます（以前は '{old_nickname}' でした）。

**警告:** 現在、このサーバーではパーソナライズが無効になっているため、このニックネームはここでは使用しません。パーソナライズが有効になっている他のサーバーでは使用します。`,
			},
		},

		// Tomoriに物事を忘れさせるためのコマンド
		unlearn: {
			sampledialogue: {
				description: `私の記憶からサンプルユーザー/ボットの対話ペアを削除します。`,
				modal_title: `サンプル対話の削除`,
				select_label: `削除する対話`,
				select_description: `削除する対話ペアを選択してください`,
				select_placeholder: `対話を選択...`,
				no_dialogues_title: `サンプル対話がありません`,
				no_dialogues: `削除するサンプル対話が保存されていません。\`/teach sampledialogue\`で追加してください。`,
				select_title: `サンプル対話の削除`,
				dialogue_label: `対話ペア`,
				success_title: `サンプル対話が削除されました`,
				success_description: `対話ペアを正常に削除しました: ユーザー: "{input}" → ボット: "{output}"`,
			},
			attribute: {
				description: `私の記憶から人格属性を削除します。`,
				modal_title: `属性の削除`,
				select_label: `削除する属性`,
				select_description: `私の人格から削除する属性を選択してください`,
				select_placeholder: `属性を選択...`,
				no_attributes_title: `属性がありません`,
				no_attributes: `削除する人格属性がありません。\`/teach attribute\`で追加してください。`,
				select_title: `属性の削除`,
				attribute_label: `属性`,
				success_title: `属性が削除されました`,
				success_description: `属性を正常に削除しました: "{attribute}"`,
			},
			servermemory: {
				description: `私の知識からサーバーの記憶を削除します。`,
				modal_title: `サーバーの記憶の削除`,
				select_label: `削除する記憶`,
				select_description: `削除するサーバーの記憶を選択してください`,
				select_placeholder: `記憶を選択...`,
				no_memories_title: `サーバーの記憶がありません`,
				no_memories: `このサーバーにはサーバーの記憶が保存されていません。\`/teach servermemory\`で追加してください。`,
				no_owned_memories: `あなたが所有していて削除できるサーバーの記憶はありません。`,
				memory_not_found: `選択された記憶が見つかりませんでした。`,
				select_title: `サーバーの記憶の削除`,
				memory_label: `サーバーの記憶`,
				success_title: `サーバーの記憶が削除されました`,
				success_description: `サーバーの記憶を正常に削除しました: "{memory}"`,
			},
			personalmemory: {
				description: `個人的な記憶を削除します。`,
				modal_title: `個人的な記憶の削除`,
				select_label: `削除する記憶`,
				select_description: `削除する個人的な記憶を選択してください`,
				select_placeholder: `記憶を選択...`,
				no_memories_title: `個人的な記憶がありません`,
				no_memories: `あなたには個人的な記憶が保存されていません。\`/teach personalmemory\`で追加してください。`,
				select_title: `個人的な記憶の削除`,
				memory_label: `個人的な記憶`,
				success_title: `個人的な記憶が削除されました`,
				success_description: `個人的な記憶を正常に削除しました: "{memory}"`,
				warning_disabled_title: `パーソナライズが無効です`,
				warning_disabled_description: `記憶は正常に削除されました。

**警告:** 現在、このサーバーではパーソナライズが無効になっているため、この変更はここでの私の行動に影響しません。パーソナライズが有効になっている他のサーバーでは反映されます。`,
			},
		},
	},

	events: {
		// ボットがサーバーに追加されたときのメッセージ
		addBot: {
			rejoin_title: `TomoriBotが戻ってきました！`,
			rejoin_description: `このサーバーに再追加されたようです。以前の設定と人格はそのままです！\`/config\`、\`/teach\`、\`unlearn\`コマンドで私を管理できます。

			プロバイダーを変更したい場合は、\`/config apikeyset\`コマンドを使用してください。

			**重要なお知らせ:** 私はDiscordメッセージを一切保存しません。記憶と関連設定のみを保存しており、これらはスラッシュコマンドで自由に削除・変更できます。ただし、私を動かすために選択したAIプロバイダーは、それぞれ異なるプライバシーポリシーを持っている場合があります。あなたまたはサーバーのメンバーが選択したプロバイダーのプライバシーポリシーに同意しない場合は、私の使用をお控えください。**それ以外の場合は、個人情報を共有しないようにしてください**。`,
			setup_prompt_title: `TomoriBotの追加が完了しました`,
			setup_prompt_description: `追加してくれてありがとうございます！始めるには、**サーバー管理**権限を持つ方が\`/config setup\`コマンドを実行して、私の初期の人格を選択し、AI機能を設定する必要があります。
			
			選択したAIプロバイダーのAPIキーの作成方法が不明な場合は、\`/help apikey\`コマンドを使用してください。APIキーは暗号化されて保存されますが、公開されているDiscordボットに提供することに不安がある場合（通常そうあるべきです）、[リポジトリのガイド](https://github.com/Eliolocin/TomoriBot)を使用してご自身でTomoriBotを実行することもできます。

			**重要なお知らせ:** 私はDiscordメッセージを一切保存しません。記憶と関連設定のみを保存しており、これらはスラッシュコマンドで自由に削除・変更できます。ただし、私を動かすために選択したAIプロバイダーは、それぞれ異なるプライバシーポリシーを持っている場合があります。あなたまたはサーバーのメンバーが選択したプロバイダーのプライバシーポリシーに同意しない場合は、私の使用をお控えください。**それ以外の場合は、個人情報を共有しないようにしてください**。`,
		},
	},

	// リマインダーシステムメッセージ
	reminders: {
		// リマインダー設定時の確認埋め込み
		reminder_set_title: `⏰ リマインダー設定完了`,
		reminder_set_description: `{user_nickname}さんに「**{reminder_purpose}**」について\`{reminder_time}\`にリマインドします`,
		reminder_set_footer: `{time_remaining}後にメンションを送信します。`,

		// リマインダー配信失敗時のエラー埋め込み（実行時のユーザー向けメッセージのみ）
		reminder_error_title: `リマインダー配信失敗`,
		reminder_error_description: `{user_mention}さんの「**{reminder_purpose}**」のリマインダーに問題が発生しました: {error_reason}。{lateness}。`,
		reminder_error_footer: `技術的問題により手動でリマインダーを配信しました。`,
	},
};
