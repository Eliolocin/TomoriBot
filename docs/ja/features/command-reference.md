---
title: "コマンドリファレンス"
sidebar:
  order: 6
---

<!--
  GENERATED FILE: do not edit by hand.
  Run `bun run generate-command-reference` from the repository root.
-->

TomoriBotによって現在登録されているすべてのスラッシュコマンドです。Discordの登録に使用されるものと同じコマンドビルダーと英語ロケールの説明から生成されています。

最上位のコマンドグループ：**27**。実行可能なスラッシュコマンド：**223**。

## `/bot`

Botコマンドです。

| コマンド | 概要 |
|---|---|
| `/bot generate image` | 進行中のチャンネルの文脈から、短いシーンの画像を生成します。 |
| `/bot generate scene` | 選択したペルソナ間で短いスクリプト化されたテキストシーンを生成します。 |
| `/bot impersonate` | ペルソナやユーザーになりすましたり、システムプロンプトを挿入したりします。 |
| `/bot kill` | 現在のストリームを直ちに停止し、このチャンネルでキューに入れられている応答をクリアします。 |
| `/bot respond` | このチャンネルの最新のメッセージに対する応答を手動でトリガーします。 |

## `/capabilities`

ツールの使用と特定の機能を管理します。

| コマンド | 概要 |
|---|---|
| `/capabilities manage` | このサーバーでトモリが使用できる特定のツールを設定します。 |
| `/capabilities toggle` | トモリがツールと関数呼び出しを使用できるかどうかを切り替えます。 |

## `/conditioning`

永続的な報酬と罰の条件付けメモリーを管理します。

| コマンド | 概要 |
|---|---|
| `/conditioning manage` | このサーバーのすべてのペルソナ間で、挿入された条件付け履歴を管理します。 |
| `/conditioning punish bite` | 遊び心のある噛みつきを与えます！ |
| `/conditioning punish bonk` | 頭をコツンと叩きます！ |
| `/conditioning punish pinch` | つねります！ |
| `/conditioning punish spank` | 遊び心のあるお尻叩きをします！ |
| `/conditioning punish squeeze` | ぎゅっと絞ります！ |
| `/conditioning reward feed` | 美味しいおやつを与えます！ |
| `/conditioning reward headpat` | 頭をなでます！ |
| `/conditioning reward hug` | ハグします！ |
| `/conditioning reward kiss` | キスします！ |
| `/conditioning reward tickle` | くすぐります！ |

## `/config`

設定コマンドです。

| コマンド | 概要 |
|---|---|
| `/config context-note set` | 会話履歴の特定の深さに挿入される短いリマインダーを設定します。 |
| `/config humanizer` | トモリの応答をどれくらい「人間らしく」するかを設定します。カスタムプロンプトを使用するには、`/config system-prompt set`を使用してください。 |
| `/config image-tags default-negative` | 望ましくない外観の詳細やアーティファクトに対するデフォルトのネガティブ画像タグを設定します。 |
| `/config image-tags default-positive` | 画像生成プロンプトに追加されるデフォルトのポジティブな外観・スタイルの画像タグを設定します。 |
| `/config message-fetch-limit` | コンテキストのために取得する最近のメッセージの数を設定します（20〜100、デフォルト：80）。 |
| `/config model-randomizer` | 各応答を主導するモデルをランダムに選択するかどうかを切り替えます（反復防止）。 |
| `/config notice-embeds visibility` | どの通知埋め込みをチャットに表示したままにするかを選択します。 |
| `/config random-trigger add` | チャンネルに確率的なタイマーベースの自動トリガーを追加します。 |
| `/config random-trigger remove` | このサーバーから既存のランダムトリガーを削除します。 |
| `/config self-debug` | トモリ自身の診断用の埋め込みをコンテキストに読み込むかどうかを切り替えます。 |
| `/config send-limit` | 1回の応答につきトモリが送信するメッセージ数の上限を設定します（デフォルト：0 ＝ 無制限）。 |
| `/config setup` | 初期セットアッププロセスを開始します。AIプロバイダーと性格を設定します。 |
| `/config system-prompt preset` | プリセットのシステムプロンプトを適用します。 |
| `/config system-prompt remove` | カスタムシステムプロンプトを削除し、デフォルトのプロンプトを使用します。 |
| `/config system-prompt set` | トモリの行動を導くカスタムシステムプロンプトを設定します。 |
| `/config trigger-cascade-limit` | 最初のトリガーの後に許可される追加のペルソナトリガーの数を管理します（デフォルト：3）。 |
| `/config trigger-match-limit` | 1つのメッセージに一致できるペルソナの数を管理します（デフォルト：3）。 |
| `/config workarounds` | 実験的な互換性のための回避策を設定します。 |

## `/contribute`

コントリビュートコマンドです。

| コマンド | 概要 |
|---|---|
| `/contribute github` | GitHubリポジトリのリンクを取得し、TomoriBotへの貢献方法について学びます。 |

## `/donate`

寄付コマンドです。

| コマンド | 概要 |
|---|---|
| `/donate kofi` | Ko-fiの寄付を通じてTomoriBotの開発をサポートします。 |

## `/generate`

生成コマンドです。

| コマンド | 概要 |
|---|---|
| `/generate image` | Google GeminiまたはOpenRouterを使用してAI画像を生成します。 |
| `/generate video` | Google Veo、OpenRouter、またはZ.aiを使用してAI動画を生成します。 |

## `/help`

セットアップ、プロバイダー、メモリ、動作、ツール、メディア、連携、プライバシーのガイドを表示します。

| コマンド | 概要 |
|---|---|
| `/help` | セットアップ、プロバイダー、メモリ、動作、ツール、メディア、連携、プライバシーのガイドを表示します。 |

## `/legal`

法的コマンドです。

| コマンド | 概要 |
|---|---|
| `/legal license` | TomoriBotのオープンソースライセンスを表示します。 |
| `/legal privacy` | TomoriBotのプライバシーポリシーを表示します。 |
| `/legal terms` | TomoriBotの利用規約を表示します。 |

## `/mcps`

リモートMCPツールサーバーの追加、一覧、有効化、無効化、削除を行う推奨の永続パネルです。

共存パイロット中は、ロールバック経路として以下の従来の `/mcp` コマンドも利用できます。

## `/mcp`（一時ブリッジ）

リモートのMCP（Model Context Protocol）ツールサーバーを管理します。

| コマンド | 概要 |
|---|---|
| `/mcp add` | リモートMCPサーバーを登録します。`/help`の連携からMCPを開いてください。 |
| `/mcp list` | このサーバーに登録されているすべてのMCPサーバーを一覧表示します。 |
| `/mcp remove` | 登録されたMCPサーバーをこのサーバーから削除します。 |
| `/mcp toggle` | 登録されたMCPサーバーを有効または無効にします。 |

## `/memory`

保存されたメモリーとドキュメントを管理します。

| コマンド | 概要 |
|---|---|
| `/memory document add` | メモリーにドキュメントを追加します。 |
| `/memory document remove` | メモリーからドキュメントを削除します。 |
| `/memory history import` | AIを使用して、このチャンネルのメッセージ履歴から知識を抽出します。 |
| `/memory history remove` | 履歴から抽出されたドキュメントをメモリーから削除します。 |
| `/memory personal add` | 個人メモリーを追加します。 |
| `/memory personal edit` | 個人メモリーを編集します。 |
| `/memory personal export` | 個人メモリーをJSONにエクスポートします。 |
| `/memory personal import` | JSONから個人メモリーをインポートします。 |
| `/memory personal remove` | 個人メモリーを削除します。 |
| `/memory server add` | サーバーメモリーを追加します。 |
| `/memory server edit` | サーバーメモリーを編集します。 |
| `/memory server export` | サーバーメモリーをJSONにエクスポートします。 |
| `/memory server import` | JSONからサーバーメモリーをインポートします。 |
| `/memory server remove` | サーバーメモリーを削除します。 |
| `/memory tagging set` | タグ付けメモリーモードに切り替えます。 |

## `/model`

このサーバーの既定AIモデルを管理します。

| コマンド | 概要 |
|---|---|
| `/model embedding` | このサーバーで文書検索に使う埋め込みモデルを変更します。 |
| `/model fallback` | このサーバーのバックアップテキストモデルを設定し、なしで各スロットをクリアできます。 |
| `/model image` | このサーバーの画像生成モデルを変更します。 |
| `/model logit-bias add` | 共有のバイアス値を1つ持つ、カンマ区切りのロジットバイアスエントリを追加します。 |
| `/model logit-bias remove` | 保存されたロジットバイアスエントリを削除します。 |
| `/model logit-bias upload` | SillyTavernスタイルのロジットバイアスJSONエントリをアップロードします。 |
| `/model override remove` | チャンネルおよびペルソナのモデルオーバーライドを削除します。 |
| `/model parameters` | このサーバーのプロバイダーごとの保存済みサンプラー設定を更新します。 |
| `/model speech` | このサーバーの音声生成エンドポイントを選択します。 |
| `/model stop-strings add` | サーバー全体の中止文字列を追加します。 |
| `/model stop-strings manage` | サーバー全体の中止文字列と、話者パターンの停止動作を管理します。 |
| `/model text` | このサーバーの既定テキストモデルを変更します。 |
| `/model transcription` | このサーバーの文字起こしエンドポイントを選択します。 |
| `/model video` | このサーバーの動画生成モデルを変更します。 |
| `/model vision` | チャットモデルが画像を見られない場合に使うこのサーバーのビジョンモデルを設定します。 |

## `/novelai`

NovelAIコマンドです。

| コマンド | 概要 |
|---|---|
| `/novelai attg` | NovelAIのKayraおよびEratoプロンプトの著者（Author）/タイトル（Title）/タグ（Tags）/ジャンル（Genre）/星（Stars）のメタデータを設定します。 |
| `/novelai character-reference` | あなたやペルソナのために、NovelAIキャラクターリファレンス画像をアップロードまたはクリアします。 |
| `/novelai image generate` | 画像掲示板スタイルのタグと、オプションでキャラクターリファレンスを使用して、NovelAIの画像を生成します。 |
| `/novelai image parameters` | このサーバーにおけるNovelAI画像生成のサンプラーと品質設定をオーバーライドします。 |
| `/novelai preset text` | このサーバーのテキスト生成設定にNovelAIのサンプリングプリセットを適用します。 |

## `/nsfw`

年齢制限付きのコマンドと設定です。

| コマンド | 概要 |
|---|---|
| `/nsfw jailbreaks` | このサーバーでのトモリのプロンプトに対するオプションのジェイルブレイク動作を管理します。 |

## `/openrouter`

OpenRouter固有のモデルと設定を管理します。

| コマンド | 概要 |
|---|---|
| `/openrouter model add` | このサーバーにOpenRouterモデルのコードネームを登録します。 |
| `/openrouter model remove` | 登録されたOpenRouterモデルをこのサーバーから削除します。 |

## `/optional-key`

オプションサービスのAPIキーを管理します。

| コマンド | 概要 |
|---|---|
| `/optional-key brave remove` | 現在設定されているBrave SearchのAPIキーを削除します。 |
| `/optional-key brave set` | このサーバーにBrave SearchのAPIキーを設定します。 |

## `/persona`

性格プリセットを管理します。

| コマンド | 概要 |
|---|---|
| `/persona attribute add` | ペルソナに属性を追加します。 |
| `/persona attribute edit` | ペルソナの属性を編集します。 |
| `/persona attribute remove` | ペルソナから属性を削除します。 |
| `/persona avatar` | このサーバーの選択したペルソナのアバターを設定または削除します。 |
| `/persona create` | シンプルな性格プリセットを手動で作成します。 |
| `/persona default` | プリセットの性格設定を適用します。 |
| `/persona export` | 現在の性格を共有可能なPNGファイルとしてエクスポートします。 |
| `/persona generate` | AIによる性格生成を行います（互換性のあるプロバイダーが必要です）。 |
| `/persona image-tags` | 画像生成を支援するために、ペルソナの身体的な外観を表すカンマ区切りの画像タグを設定します。 |
| `/persona import` | PNGまたはJSONファイルからペルソナをインポートします。 |
| `/persona prompt remove` | ペルソナのプロンプトを削除します。 |
| `/persona prompt set` | ペルソナのプロンプトを設定します。 |
| `/persona remove` | アルターペルソナをサーバーから削除します。 |
| `/persona rename` | このサーバーでのトモリの名前を変更します。 |
| `/persona sample-dialogue add` | トモリがどのように応答すべきかの例として、ユーザーとBotのサンプル会話のペアを追加します。 |
| `/persona sample-dialogue edit` | ユーザーとBotのサンプル会話のペアを編集します。 |
| `/persona sample-dialogue remove` | トモリのメモリーからユーザーとBotのサンプル会話のペアを削除します。 |
| `/persona sprites add` | ペルソナのスプライトアバターを追加または置換します。 |
| `/persona sprites edit` | ペルソナスプライトの名前、画像、指示、またはアイデンティティを編集します。 |
| `/persona sprites export` | ペルソナのスプライトを共有可能な.zipファイルとしてエクスポートします。 |
| `/persona sprites import` | .zipファイルからペルソナのスプライトをインポートします。 |
| `/persona sprites remove` | ペルソナのスプライトアバターを削除します。 |
| `/persona swap` | メインペルソナとアルターペルソナを切り替えます。 |
| `/persona trigger add` | ペルソナのトリガーワードを追加します。 |
| `/persona trigger remove` | 言及されたときにトモリが反応するトリガーワードを削除します。 |

## `/personal`

個人設定を管理します。

| コマンド | 概要 |
|---|---|
| `/personal config export` | サーバー設定、ペルソナ、メモリーを除外して、個人設定をエクスポートします。 |
| `/personal config import` | 個人設定のみをインポートします。サーバー設定やメモリーはインポートしません。 |
| `/personal config remove` | 個人設定をリセットします。 |
| `/personal custom-endpoint add` | 個人カスタムエンドポイントのラベルの下にモデルを登録します（ラベルを再利用してさらに追加できます）。 |
| `/personal custom-endpoint edit` | 登録された個人カスタムエンドポイントのフィールドを編集します。 |
| `/personal custom-endpoint remove` | 個人カスタムエンドポイントから選択した機能を削除します。 |
| `/personal deliberate-tool-mode` | 個人の意図的なツールモードの設定を行います。 |
| `/personal deliberate-trigger-mode` | 個人の意図的なトリガーモード（DTM）の設定を行います。 |
| `/personal image-tags` | 画像生成を支援するために、あなたの身体的な外観を表すカンマ区切りの画像タグを設定します。 |
| `/personal impersonate prompt` | トモリがどのようにあなたになりすますべきかを指示する、再利用可能なプロンプトを設定します。 |
| `/personal language` | トモリのインターフェースの優先言語を設定します。 |
| `/personal model fallback` | 個人テキスト上書きのフォールバックモデルを設定し、なしで各スロットをクリアできます。 |
| `/personal profile nickname` | トモリがあなたを呼ぶときの名前を変更します。 |
| `/personal openrouter-model add` | 個人プロバイダーリストにOpenRouterモデルのコードネームを登録します。 |
| `/personal openrouter-model remove` | 個人プロバイダーリストから登録されたOpenRouterモデルを削除します。 |
| `/personal parameters` | このサーバーではなく、個人プロバイダーのサンプラー設定を調整します。 |
| `/personal privacy` | 個人メモリーの保存とプライバシー設定を制御します。 |
| `/personal provider add` | APIキーを保存し、既定の個人テキストモデルを全サーバーで有効化します。 |
| `/personal provider model-embedding` | 全サーバーで使う個人埋め込みモデルを選択して有効化します。 |
| `/personal provider model-image` | 全サーバーで使う個人画像モデルを選択して有効化します。 |
| `/personal provider model-text` | 全サーバーで使う個人テキストモデルを選択して有効化します。 |
| `/personal provider model-video` | 全サーバーで使う個人動画モデルを選択して有効化します。 |
| `/personal provider model-vision` | 全サーバーで使う個人ビジョンモデルを選択して有効化します。 |
| `/personal provider remove` | 全サーバー共通の個人プロバイダー設定を削除します。 |
| `/personal provider toggle-models` | どの機能でサーバー既定ではなく個人プロバイダーを使うか選択します。 |
| `/personal spotlight manage` | アクティブな個人スポットライトを削除します。詳細は`/help`の個人スポットライトを確認してください。 |
| `/personal spotlight set` | 1つのチャンネルに個人のペルソナスポットライトを設定します。詳細は`/help`の個人スポットライトを確認してください。 |
| `/personal stm` | STM（短期記憶）設定を構成します。 |
| `/personal timezone` | 個人のUTCからのタイムゾーンオフセットを設定します。 |

## `/provider`

このサーバー共通のAIプロバイダーを管理します。

| コマンド | 概要 |
|---|---|
| `/provider add` | このサーバー用の認証情報を保存し、保存済みテキストモデルを有効化します。 |
| `/provider api-key rotation` | 負荷分散とフェイルオーバーのためにAPIキーのローテーションを管理します。 |
| `/provider custom-endpoint add` | カスタムエンドポイントのラベルの下にモデルを登録します（ラベルを再利用してさらに追加できます）。 |
| `/provider custom-endpoint edit` | 登録されたカスタムエンドポイントのフィールドを編集します。 |
| `/provider custom-endpoint remove` | ラベル付けされたカスタムエンドポイントから選択した機能を削除します。 |
| `/provider remove` | このサーバーから保存済みプロバイダー設定を削除します。 |

## `/scheduled-task`

スケジュールされたタスクとリマインダーを管理します。

| コマンド | 概要 |
|---|---|
| `/scheduled-task edit` | スケジュールされたタスクまたはリマインダーを編集します。 |
| `/scheduled-task remove` | スケジュールされたタスクまたはリマインダーを削除します。 |

## `/server`

サーバーコマンドです。

| コマンド | 概要 |
|---|---|
| `/server always-reply` | メインペルソナの常時応答モードを切り替えます。 |
| `/server auto-trigger channels` | 自動トリガーチャンネルと、オプションのチャンネルごとのペルソナ割り当てを管理します。 |
| `/server auto-trigger threshold` | 設定された自動チャットチャンネルの、共有される自動チャット間隔を設定します。 |
| `/server channel-prompt` | 1つのチャンネルにスコープされたシステムプロンプトを設定します（そこにあるサーバープロンプトに追加または置換します）。 |
| `/server config export` | メモリー、ペルソナ、および個人設定を除外して、このサーバーの設定をエクスポートします。 |
| `/server config import` | サーバー設定をインポートします。メモリー、ペルソナ、個人設定はインポートしません。 |
| `/server config remove` | このサーバーの設定をリセットします。 |
| `/server cooldown triggers` | トリガーおよび`/bot`のクールダウンの種類と期間を設定します（デフォルト：オフ、5秒）。 |
| `/server crosschannel-blocklist` | ツール駆動のクロスチャンネルメッセージ用のチャンネルブロックリストを管理します。 |
| `/server deliberate-tool-context` | 最近使用したツールを引き続き使用可能にする、後続のターンの回数を設定します。 |
| `/server deliberate-tool-mode` | このサーバーの意図的なツールモードを切り替えます。 |
| `/server deliberate-tool-trigger` | 意図的なツールモードのカスタムトリガーフレーズを管理します。 |
| `/server deliberate-trigger-mode` | このサーバーの意図的なトリガーモード（DTM）を切り替えます。 |
| `/server expressions edit` | 1つの絵文字またはステッカーの感情と使用方法の指示を編集します。 |
| `/server expressions initialize` | AIビジョンを使用して、すべてのカスタム絵文字とステッカーを分析および分類します。 |
| `/server matrix link` | 双方向の中継のためにDiscordチャンネルをMatrixルームにリンクします。 |
| `/server matrix unlink` | DiscordチャンネルからMatrixブリッジのリンクを削除します。 |
| `/server member-permissions` | 管理者以外のメンバーがトモリに教えることができる内容を設定します。 |
| `/server nuke` | サーバーのすべてのデータを完全に消去します。後で`/setup`を再実行する必要があります。 |
| `/server private-channels` | STMが隔離され、思考ログが抑制されるプライベートチャンネルを管理します。 |
| `/server quota image-generation` | このサーバーの1日あたりの画像生成クォータを設定します。 |
| `/server quota reset` | 画像、テキスト、または動画生成のクォータプールをリセットします。 |
| `/server quota text-generation` | このサーバーのテキスト生成のトリガークォータを設定します。 |
| `/server quota video-generation` | このサーバーの動画生成クォータを設定します。 |
| `/server rp-channels` | 絵文字とステッカーが常に抑制され、`/delete turn`が使用できるチャンネルを管理します。 |
| `/server stm manage` | ペルソナ間でアクティブな、サーバー共有のSTMを確認およびクリアします。 |
| `/server stm privacy-bypass` | プライベートチャンネルのSTMが非プライベートチャンネルに漏れる可能性があるかどうかを切り替えます。 |
| `/server thought-logs-channel` | サーバーの思考ログチャンネルを設定またはクリアします。 |
| `/server timezone` | サーバーのUTCからのタイムゾーンオフセットを設定します（デフォルト：0 / UTC）。 |
| `/server user-blacklist add` | パーソナライズのブラックリストにメンバーを追加します。 |
| `/server user-blacklist remove` | ユーザーのブラックリストエントリとペルソナのブロックを確認します。エントリのチェックを外すと削除されます。 |
| `/server user-byok toggle` | ユーザーがトリガーしたメッセージに、メンバーの個人プロバイダーが必要かどうかを切り替えます。 |
| `/server welcome-channel remove` | 設定されたウェルカムチャンネルを削除し、自動の挨拶を停止します。 |
| `/server welcome-channel set` | 自動のウェルカムの挨拶に使用されるチャンネルを設定します。 |
| `/server whitelist channel` | ホワイトリストにチャンネルを追加します。必要に応じてグローバルクールダウンをオーバーライドします。 |
| `/server whitelist persona` | ペルソナがトリガーできるチャンネルを制限します。 |
| `/server whitelist remove` | ホワイトリストからペルソナ、チャンネル、またはロールを削除します。 |
| `/server whitelist role` | トモリをトリガーできるホワイトリストに登録されたロールを追加または削除します。 |

## `/speech`

音声の声とサンプルを管理します。

| コマンド | 概要 |
|---|---|
| `/speech chatterbox parameters` | Chatterbox Turboおよび標準モデルの音声生成を調整します。 |
| `/speech elevenlabs` | ElevenLabsの音声と文字起こしを接続します。 |
| `/speech transcripts` | ボイスメッセージの表示される文字起こしの投稿を切り替えます。 |
| `/speech voice-add` | ローカルのTTSリファレンス音声サンプルをアップロードします。 |
| `/speech voice-assign` | ペルソナに音声を割り当てます。 |
| `/speech voice-design remove` | ペルソナの音声デザインプロンプトを削除します。 |
| `/speech voice-design set` | ペルソナの音声デザインプロンプトを設定します。 |
| `/speech voice-remove` | このサーバーからローカルのTTS音声サンプルを削除します。 |

## `/st-preset`

SillyTavernのプリセットを管理します。詳細は`/help`の連携からSillyTavernプリセットを開いてください。

| コマンド | 概要 |
|---|---|
| `/st-preset import` | SillyTavernのプリセットJSONファイルをインポートします。詳細は`/help`のSillyTavernプリセットを確認してください。 |
| `/st-preset node toggle` | プリセットのプロンプトノードのオン/オフを切り替えます。 |
| `/st-preset remove` | インポートされたSillyTavernのプリセットを削除します。 |
| `/st-preset switch` | アクティブなSillyTavernプリセットを切り替えます。 |

## `/stats`

使用統計を表示します。

| コマンド | 概要 |
|---|---|
| `/stats generate` | 共有可能な統計画像カードを生成します。 |
| `/stats persona` | このサーバーでのペルソナの使用統計を表示します。 |
| `/stats personal` | あなた自身の使用統計を表示します。 |
| `/stats server` | サーバー全体の使用統計を表示します。 |

## `/support`

サポートコマンドです。

| コマンド | 概要 |
|---|---|
| `/support discord` | バグレポート、フィードバック、およびコミュニティチャットのための、公式Discordサーバーのリンクを取得します。 |

## `/tool`

ツールコマンドです。

| コマンド | 概要 |
|---|---|
| `/tool comment` | チャットには表示されるがコンテキストでは非表示になる、コメントの埋め込みを送信します。 |
| `/tool compact` | 最近の会話をコンパクトなシステムメモリーに要約します。 |
| `/tool delete turn` | チャンネルから最後のペルソナのターンを削除します。 |
| `/tool estimate cost` | 有料AIプロバイダーのAPIコストを見積もります。 |
| `/tool ping` | トモリのレイテンシを確認します。 |
| `/tool prompt snapshot` | デバッグのために、ペルソナの正確なLLMプロンプトをファイルにダンプします。 |
| `/tool refresh` | 最近の会話履歴をクリアします。 |
| `/tool status` | 現在の個人、サーバー、またはペルソナのステータスを表示します。 |

## `/update`

TomoriBotの最新のリリースノートを表示します。

| コマンド | 概要 |
|---|---|
| `/update` | TomoriBotの最新のリリースノートを表示します。 |
